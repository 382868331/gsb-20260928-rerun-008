import type {
  AnnotationObject,
  Contour,
  ImageRecord,
  ImageVersion,
  MergeConflict,
  MergeResolution,
  MergeSession,
  Point,
} from '../types';
import { uid } from './geometry';
import { nowIso } from './versioning';

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

const DELETED = Symbol('deleted');
type Maybe<T> = T | typeof DELETED;

interface ObjectParts {
  categoryId: Maybe<string>;
  contours: Map<string, Maybe<Contour>>;
}

function partsOf(obj: AnnotationObject | undefined): ObjectParts {
  const contours = new Map<string, Maybe<Contour>>();
  for (const c of obj?.contours ?? []) contours.set(c.id, clone(c));
  return { categoryId: obj ? obj.categoryId : DELETED, contours };
}

export interface MergePlan {
  baseVersion: number;
  aVersion: number;
  bVersion: number;
  conflicts: MergeConflict[];
}

interface Ctx {
  conflicts: MergeConflict[];
  resolutions: Record<string, MergeResolution>;
  strict: boolean;
}

/** 三方取值的公共辅助：base/a/b 比较，相同改动自动采纳，分歧进入冲突表 */
function mergeValue<T>(
  ctx: Ctx,
  meta: Omit<MergeConflict, 'baseValue' | 'aValue' | 'bValue'>,
  base: Maybe<T>,
  a: Maybe<T>,
  b: Maybe<T>,
): Maybe<T> {
  const view = (v: Maybe<T>) => (v === DELETED ? null : v);
  const aChanged = (a === DELETED) !== (base === DELETED) || !eq(view(a), view(base));
  const bChanged = (b === DELETED) !== (base === DELETED) || !eq(view(b), view(base));

  if (!aChanged && !bChanged) return base;
  if (aChanged && !bChanged) return a;
  if (bChanged && !aChanged) return b;
  if (a === DELETED && b === DELETED) return DELETED;
  if (a !== DELETED && b !== DELETED && eq(a, b)) return a;

  const toView = (v: Maybe<T>) => (v === DELETED ? '（已删除）' : clone(v));
  const conflict: MergeConflict = {
    ...meta,
    baseValue: toView(base),
    aValue: toView(a),
    bValue: toView(b),
  };
  ctx.conflicts.push(conflict);
  const pick = ctx.resolutions[conflict.id];
  if (!pick) {
    if (ctx.strict) throw new Error('冲突未裁决：' + conflict.message);
    return base;
  }
  return pick === 'a' ? a : b;
}

function mergeContour(
  ctx: Ctx,
  objectId: string,
  contourId: string,
  base: Maybe<Contour>,
  a: Maybe<Contour>,
  b: Maybe<Contour>,
): Maybe<Contour> {
  const aGone = a === DELETED;
  const bGone = b === DELETED;
  const baseC = base === DELETED ? undefined : base;
  const changed = (c: Maybe<Contour>) =>
    c !== DELETED && !!baseC && (!eq(c.points, baseC.points) || !eq(c.holes, baseC.holes));
  // 一方删除轮廓、另一方修改了它（外轮廓点或孔洞）→ 冲突，不能静默吞掉任何一方
  if ((aGone && changed(b)) || (bGone && changed(a))) {
    return mergeValue<Contour>(
      ctx,
      {
        id: 'contour:' + objectId + ':' + contourId,
        objectId,
        contourId,
        part: 'contour-existence',
        message: '物体 ' + objectId + ' 的轮廓 ' + contourId + ' 一边被删除、另一边被修改',
      },
      base,
      a,
      b,
    );
  }
  if (base === DELETED) {
    // 基线中不存在：单边新增直接保留，双边新增需一致
    if (!aGone && !bGone) {
      if (eq(a, b)) return a;
      return mergeValue<Contour>(
        ctx,
        {
          id: 'outline:' + objectId + ':' + contourId,
          objectId,
          contourId,
          part: 'outline',
          message: '物体 ' + objectId + ' 新增轮廓 ' + contourId + ' 在两条修订中不一致',
        },
        base,
        a,
        b,
      );
    }
    return aGone ? b : a;
  }
  if (aGone || bGone) return DELETED; // 双方同删，或单方删且另一方未动

  // 双方都保留：先合并外轮廓顶点，再逐个合并孔洞
  const points = mergeValue<Point[]>(
    ctx,
    {
      id: 'outline:' + objectId + ':' + contourId,
      objectId,
      contourId,
      part: 'outline',
      message: '物体 ' + objectId + ' 的轮廓 ' + contourId + ' 外轮廓被两条修订改成了不同形状',
    },
    base.points,
    a.points,
    b.points,
  );
  const holeIds = new Set<string>([
    ...base.holes.map((h) => h.id),
    ...a.holes.map((h) => h.id),
    ...b.holes.map((h) => h.id),
  ]);
  const holes: Contour['holes'] = [];
  for (const holeId of holeIds) {
    const find = (c: Contour) => c.holes.find((h) => h.id === holeId)?.points ?? DELETED;
    const merged = mergeValue<Point[]>(
      ctx,
      {
        id: 'hole:' + objectId + ':' + contourId + ':' + holeId,
        objectId,
        contourId,
        holeId,
        part: 'hole',
        message: '物体 ' + objectId + ' 轮廓 ' + contourId + ' 的孔洞 ' + holeId + ' 被两条修订改成了不同结果',
      },
      find(base),
      find(a),
      find(b),
    );
    if (merged !== DELETED) holes.push({ id: holeId, points: merged });
  }
  if (points === DELETED) return DELETED;
  return { id: contourId, points, holes };
}

function mergeObject(
  ctx: Ctx,
  objectId: string,
  base: AnnotationObject | undefined,
  a: AnnotationObject | undefined,
  b: AnnotationObject | undefined,
): AnnotationObject | null {
  const aGone = !a;
  const bGone = !b;
  // 一方删除物体、另一方有任何修改（类别/轮廓/孔洞）→ 冲突，绝不静默吞掉
  if (base && (aGone || bGone) && !(aGone && bGone)) {
    const other = (aGone ? b : a)!;
    const modified =
      other.categoryId !== base.categoryId || !eq(other.contours, base.contours);
    if (modified) {
      const picked = mergeValue<AnnotationObject>(
        ctx,
        {
          id: 'object:' + objectId,
          objectId,
          part: 'object-existence',
          message: '物体 ' + objectId + ' 一边被删除、另一边被修改（类别/轮廓/孔洞）',
        },
        base,
        a ?? DELETED,
        b ?? DELETED,
      );
      return picked === DELETED ? null : finalizeObject(picked);
    }
    return null; // 另一方未动：删除生效
  }
  if (!base) {
    // 新增的物体：单边新增直接保留；两边都新增同 id 物体需一致
    if (a && b) {
      if (eq(a, b)) return finalizeObject(a);
      const picked = mergeValue<AnnotationObject>(
        ctx,
        {
          id: 'object:' + objectId,
          objectId,
          part: 'object-existence',
          message: '物体 ' + objectId + ' 在两条修订中都被新增但内容不一致',
        },
        DELETED,
        a,
        b,
      );
      return picked === DELETED ? null : finalizeObject(picked);
    }
    return finalizeObject((a ?? b)!);
  }
  if (aGone && bGone) return null;

  // 双方都保留物体时类别不可能为 DELETED
  const categoryId = mergeValue<string>(
    ctx,
    {
      id: 'category:' + objectId,
      objectId,
      part: 'category',
      message: '物体 ' + objectId + ' 的类别被两条修订改成了不同类别',
    },
    base.categoryId,
    a!.categoryId,
    b!.categoryId,
  ) as string;
  const pa = partsOf(a);
  const pb = partsOf(b);
  const pbase = partsOf(base);
  const contourIds = new Set<string>([...pbase.contours.keys(), ...pa.contours.keys(), ...pb.contours.keys()]);
  const contours: Contour[] = [];
  for (const contourId of contourIds) {
    const get = (p: ObjectParts) => p.contours.get(contourId) ?? DELETED;
    const merged = mergeContour(ctx, objectId, contourId, get(pbase), get(pa), get(pb));
    if (merged !== DELETED) contours.push(merged);
  }
  return finalizeObject({ ...base, categoryId, contours });
}

function finalizeObject(obj: AnnotationObject): AnnotationObject {
  return { ...clone(obj), updatedAt: nowIso() };
}

function runMerge(
  base: ImageVersion,
  a: ImageVersion,
  b: ImageVersion,
  resolutions: Record<string, MergeResolution>,
  strict: boolean,
): { objects: AnnotationObject[]; conflicts: MergeConflict[] } {
  const ctx: Ctx = { conflicts: [], resolutions, strict };
  const byId = (v: ImageVersion) => new Map(v.objects.map((o) => [o.id, o]));
  const mb = byId(base);
  const ma = byId(a);
  const mbb = byId(b);
  const ids = new Set<string>([...mb.keys(), ...ma.keys(), ...mbb.keys()]);
  const objects: AnnotationObject[] = [];
  for (const id of ids) {
    const merged = mergeObject(ctx, id, mb.get(id), ma.get(id), mbb.get(id));
    if (merged) objects.push(merged);
  }
  return { objects, conflicts: ctx.conflicts };
}

function getSubmitted(image: ImageRecord, version: number): ImageVersion {
  const v = image.versions.find((x) => x.version === version && x.status === 'submitted');
  if (!v) throw new Error('图片 ' + image.id + ' 没有已提交版本 v' + version);
  return v;
}

/** 校验两条修订是否来自同一基线版本，并返回基线版本号 */
export function resolveMergeBase(image: ImageRecord, aVersion: number, bVersion: number): number {
  if (aVersion === bVersion) throw new Error('两条修订不能是同一个版本');
  const a = getSubmitted(image, aVersion);
  const b = getSubmitted(image, bVersion);
  if (a.basedOn == null || b.basedOn == null || a.basedOn !== b.basedOn) {
    throw new Error('v' + aVersion + ' 与 v' + bVersion + ' 不是从同一版本分别修订的，无法合并');
  }
  getSubmitted(image, a.basedOn);
  return a.basedOn;
}

/** 生成合并计划：自动合并不冲突的修改，列出需要用户裁决的冲突 */
export function planMerge(image: ImageRecord, aVersion: number, bVersion: number): MergePlan {
  const baseVersion = resolveMergeBase(image, aVersion, bVersion);
  const { conflicts } = runMerge(
    getSubmitted(image, baseVersion),
    getSubmitted(image, aVersion),
    getSubmitted(image, bVersion),
    {},
    false,
  );
  return { baseVersion, aVersion, bVersion, conflicts };
}

export function createMergeSession(image: ImageRecord, aVersion: number, bVersion: number): MergeSession {
  const plan = planMerge(image, aVersion, bVersion);
  const ts = nowIso();
  return {
    id: uid('merge'),
    imageId: image.id,
    baseVersion: plan.baseVersion,
    aVersion,
    bVersion,
    resolutions: {},
    createdAt: ts,
    updatedAt: ts,
  };
}

/**
 * 落地合并：所有冲突必须已裁决；生成一个新的已提交版本。
 * 物体 id 全部保留，mergeOf 记录基线与两条修订来源；历史版本不被修改。
 */
export function applyMergeSession(image: ImageRecord, session: MergeSession, note?: string): ImageRecord {
  const base = getSubmitted(image, session.baseVersion);
  const a = getSubmitted(image, session.aVersion);
  const b = getSubmitted(image, session.bVersion);
  const { objects, conflicts } = runMerge(base, a, b, session.resolutions, true);
  const unresolved = conflicts.filter((c) => !session.resolutions[c.id]);
  if (unresolved.length > 0) {
    throw new Error('还有 ' + unresolved.length + ' 处冲突未确认，不能完成合并');
  }
  const next = clone(image);
  next.versions.push({
    version: next.versions.length + 1,
    status: 'submitted',
    objects,
    createdAt: nowIso(),
    submittedAt: nowIso(),
    basedOn: session.baseVersion,
    mergeOf: { base: session.baseVersion, a: session.aVersion, b: session.bVersion },
    note: note ?? ('合并 v' + session.aVersion + ' 与 v' + session.bVersion + '（基线 v' + session.baseVersion + '）'),
  });
  return next;
}
