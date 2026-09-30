import type {
  AnnotationObject,
  Contour,
  ContourHole,
  ImageRecord,
  ImageVersion,
  MergeChoice,
  MergeConflict,
  MergeSession,
  Point,
} from '../types';
import { uid } from './geometry';
import { getDraft, nowIso } from './versioning';

function clone<T>(v: T): T {
  return structuredClone(v);
}

export function pointsEqual(a: Point[], b: Point[]): boolean {
  return a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y);
}

function holesEqual(a: ContourHole[], b: ContourHole[]): boolean {
  return (
    a.length === b.length &&
    a.every((h, i) => h.id === b[i].id && pointsEqual(h.points, b[i].points))
  );
}

function contoursEqual(a: Contour[], b: Contour[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => c.id === b[i].id && pointsEqual(c.points, b[i].points) && holesEqual(c.holes, b[i].holes))
  );
}

export function objectsEqual(a: AnnotationObject, b: AnnotationObject): boolean {
  return a.categoryId === b.categoryId && contoursEqual(a.contours, b.contours);
}

export interface MergeResult {
  objects: AnnotationObject[];
  conflicts: MergeConflict[];
  /** 尚未确认的冲突 */
  unresolved: MergeConflict[];
}

type Resolutions = Record<string, MergeChoice>;

function pick<T>(conflictId: string, resolutions: Resolutions, left: T, right: T): T {
  const choice = resolutions[conflictId];
  if (choice === 'left') return left;
  if (choice === 'right') return right;
  // 未确认时先采用左侧占位，最终提交前必须全部确认
  return left;
}

function mergeHoles(
  objectId: string,
  contourId: string,
  base: ContourHole[],
  left: ContourHole[],
  right: ContourHole[],
  resolutions: Resolutions,
  conflicts: MergeConflict[],
): ContourHole[] {
  const out: ContourHole[] = [];
  const ids: string[] = [];
  for (const list of [base, left, right]) {
    for (const h of list) if (!ids.includes(h.id)) ids.push(h.id);
  }
  for (const id of ids) {
    const b = base.find((h) => h.id === id);
    const l = left.find((h) => h.id === id);
    const r = right.find((h) => h.id === id);
    if (!b) {
      // 新增孔洞：两侧 id 不会冲突，互不冲突的新增全部保留
      if (l) out.push(clone(l));
      if (r && !l) out.push(clone(r));
      continue;
    }
    const lDel = !l;
    const rDel = !r;
    const lMod = l !== undefined && !pointsEqual(b.points, l.points);
    const rMod = r !== undefined && !pointsEqual(b.points, r.points);
    if (lDel && rDel) continue;
    if (lDel || rDel) {
      const survivorMod = lDel ? rMod : lMod;
      if (!survivorMod) continue; // 一侧删除、另一侧未动：按删除处理
      const cid = `obj:${objectId}:ctr:${contourId}:hole:${id}:delete`;
      conflicts.push({
        id: cid,
        objectId,
        contourId,
        holeId: id,
        kind: 'hole-delete-vs-modify',
        message: `孔洞 ${id}：一侧删除了该孔洞，另一侧修改了它`,
        base: clone(b.points),
        left: l ? clone(l.points) : null,
        right: r ? clone(r.points) : null,
      });
      const kept = pick(cid, resolutions, l, r);
      if (kept) out.push(clone(kept));
      continue;
    }
    if (lMod && rMod && !pointsEqual(l!.points, r!.points)) {
      const cid = `obj:${objectId}:ctr:${contourId}:hole:${id}:points`;
      conflicts.push({
        id: cid,
        objectId,
        contourId,
        holeId: id,
        kind: 'hole-points',
        message: `孔洞 ${id}：两侧对该孔洞做了不同修改`,
        base: clone(b.points),
        left: clone(l!.points),
        right: clone(r!.points),
      });
      out.push({ id, points: clone(pick(cid, resolutions, l!.points, r!.points)) });
      continue;
    }
    out.push(clone(lMod ? l! : rMod ? r! : b));
  }
  return out;
}

function mergeContours(
  objectId: string,
  base: Contour[],
  left: Contour[],
  right: Contour[],
  resolutions: Resolutions,
  conflicts: MergeConflict[],
): Contour[] {
  const out: Contour[] = [];
  const ids: string[] = [];
  for (const list of [base, left, right]) {
    for (const c of list) if (!ids.includes(c.id)) ids.push(c.id);
  }
  for (const id of ids) {
    const b = base.find((c) => c.id === id);
    const l = left.find((c) => c.id === id);
    const r = right.find((c) => c.id === id);
    if (!b) {
      if (l) out.push(clone(l));
      if (r && !l) out.push(clone(r));
      continue;
    }
    const lDel = !l;
    const rDel = !r;
    const lMod = l !== undefined && (!pointsEqual(b.points, l.points) || !holesEqual(b.holes, l.holes));
    const rMod = r !== undefined && (!pointsEqual(b.points, r.points) || !holesEqual(b.holes, r.holes));
    if (lDel && rDel) continue;
    if (lDel || rDel) {
      const survivorMod = lDel ? rMod : lMod;
      if (!survivorMod) continue;
      const cid = `obj:${objectId}:ctr:${id}:delete`;
      conflicts.push({
        id: cid,
        objectId,
        contourId: id,
        kind: 'contour-delete-vs-modify',
        message: `外轮廓 ${id}：一侧删除了该轮廓，另一侧修改了它`,
        base: clone(b.points),
        left: l ? clone(l.points) : null,
        right: r ? clone(r.points) : null,
      });
      const kept = pick(cid, resolutions, l, r);
      if (kept) out.push(clone(kept));
      continue;
    }
    // 两侧都保留该轮廓：先合并顶点，再合并孔洞
    let points: Point[];
    const lPts = !pointsEqual(b.points, l!.points);
    const rPts = !pointsEqual(b.points, r!.points);
    if (lPts && rPts && !pointsEqual(l!.points, r!.points)) {
      const cid = `obj:${objectId}:ctr:${id}:points`;
      conflicts.push({
        id: cid,
        objectId,
        contourId: id,
        kind: 'contour-points',
        message: `外轮廓 ${id}：两侧对该轮廓顶点做了不同修改`,
        base: clone(b.points),
        left: clone(l!.points),
        right: clone(r!.points),
      });
      points = clone(pick(cid, resolutions, l!.points, r!.points));
    } else {
      points = clone(lPts ? l!.points : rPts ? r!.points : b.points);
    }
    const holes = mergeHoles(objectId, id, b.holes, l!.holes, r!.holes, resolutions, conflicts);
    out.push({ id, points, holes });
  }
  return out;
}

/**
 * 三方合并：以 base 为共同基准，按物体 id 对应，再按轮廓/孔洞 id 对应。
 * 互不冲突的修改自动保留；同一部分的不同修改记录为冲突，由 resolutions 决定取舍。
 */
export function computeMerge(
  baseObjects: AnnotationObject[],
  leftObjects: AnnotationObject[],
  rightObjects: AnnotationObject[],
  resolutions: Resolutions,
): MergeResult {
  const conflicts: MergeConflict[] = [];
  const out: AnnotationObject[] = [];
  const ids: string[] = [];
  for (const list of [baseObjects, leftObjects, rightObjects]) {
    for (const o of list) if (!ids.includes(o.id)) ids.push(o.id);
  }
  for (const id of ids) {
    const b = baseObjects.find((o) => o.id === id);
    const l = leftObjects.find((o) => o.id === id);
    const r = rightObjects.find((o) => o.id === id);
    if (!b) {
      // 两侧各自新增的物体：id 全局唯一，直接全部保留
      if (l) out.push(clone(l));
      if (r && !l) out.push(clone(r));
      continue;
    }
    const lDel = !l;
    const rDel = !r;
    const lMod = l !== undefined && !objectsEqual(b, l);
    const rMod = r !== undefined && !objectsEqual(b, r);
    if (lDel && rDel) continue;
    if (lDel || rDel) {
      const survivorMod = lDel ? rMod : lMod;
      if (!survivorMod) continue; // 一侧删除、另一侧未动：按删除处理
      const cid = `obj:${id}:delete`;
      conflicts.push({
        id: cid,
        objectId: id,
        kind: 'object-delete-vs-modify',
        message: `物体 ${id}：一侧删除了该物体，另一侧修改了它（类别/轮廓/孔洞），不能静默吞掉任何一方`,
        base: clone(b),
        left: l ? clone(l) : null,
        right: r ? clone(r) : null,
      });
      const kept = pick(cid, resolutions, l, r);
      if (kept) out.push(clone(kept));
      continue;
    }
    // 类别
    let categoryId = b.categoryId;
    const lCat = l!.categoryId !== b.categoryId;
    const rCat = r!.categoryId !== b.categoryId;
    if (lCat && rCat && l!.categoryId !== r!.categoryId) {
      const cid = `obj:${id}:category`;
      conflicts.push({
        id: cid,
        objectId: id,
        kind: 'category',
        message: `物体 ${id}：两侧把类别改成了不同值`,
        base: b.categoryId,
        left: l!.categoryId,
        right: r!.categoryId,
      });
      categoryId = pick(cid, resolutions, l!.categoryId, r!.categoryId);
    } else if (lCat) {
      categoryId = l!.categoryId;
    } else if (rCat) {
      categoryId = r!.categoryId;
    }
    const contours = mergeContours(id, b.contours, l!.contours, r!.contours, resolutions, conflicts);
    out.push({ ...clone(b), categoryId, contours, updatedAt: nowIso() });
  }
  const unresolved = conflicts.filter((c) => !(c.id in resolutions));
  return { objects: out, conflicts, unresolved };
}

function findSubmitted(image: ImageRecord, version: number): ImageVersion | undefined {
  return image.versions.find((v) => v.version === version && v.status === 'submitted');
}

/** 发起合并：两条修订必须是基于同一已提交版本的两个已提交版本 */
export function startMergeSession(image: ImageRecord, leftVersion: number, rightVersion: number): ImageRecord {
  if (leftVersion === rightVersion) throw new Error('不能合并同一个版本，请选择两条不同的修订');
  if (getDraft(image)) throw new Error('存在未提交的草稿，请先提交或丢弃后再合并');
  if (image.mergeSession) throw new Error('已有进行中的合并，请先完成或取消');
  const left = findSubmitted(image, leftVersion);
  const right = findSubmitted(image, rightVersion);
  if (!left || !right) throw new Error('合并来源必须是已提交版本');
  if (left.basedOn == null || left.basedOn !== right.basedOn) {
    throw new Error(`两条修订必须基于同一版本（左侧基于 v${left.basedOn ?? '无'}，右侧基于 v${right.basedOn ?? '无'}）`);
  }
  const base = findSubmitted(image, left.basedOn);
  if (!base) throw new Error(`共同基准版本 v${left.basedOn} 不存在`);
  const { conflicts } = computeMerge(base.objects, left.objects, right.objects, {});
  const next = clone(image);
  const ts = nowIso();
  next.mergeSession = {
    id: uid('merge'),
    baseVersion: base.version,
    leftVersion,
    rightVersion,
    conflicts,
    resolutions: {},
    createdAt: ts,
    updatedAt: ts,
  };
  return next;
}

function updateSession(image: ImageRecord, fn: (s: MergeSession) => void): ImageRecord {
  if (!image.mergeSession) throw new Error('当前没有进行中的合并');
  const next = clone(image);
  fn(next.mergeSession!);
  next.mergeSession!.updatedAt = nowIso();
  return next;
}

/** 确认某项争议：选择左侧或右侧修订 */
export function resolveMergeConflict(image: ImageRecord, conflictId: string, choice: MergeChoice): ImageRecord {
  return updateSession(image, (s) => {
    if (!s.conflicts.some((c) => c.id === conflictId)) throw new Error(`冲突 ${conflictId} 不存在`);
    s.resolutions[conflictId] = choice;
  });
}

/** 撤回某项确认：仅移除该决定，其他确认保留 */
export function unresolveMergeConflict(image: ImageRecord, conflictId: string): ImageRecord {
  return updateSession(image, (s) => {
    delete s.resolutions[conflictId];
  });
}

/** 取消合并：丢弃会话，两条修订版本保持原样 */
export function cancelMerge(image: ImageRecord): ImageRecord {
  const next = clone(image);
  next.mergeSession = null;
  return next;
}

/**
 * 完成合并：所有争议确认后生成一个新的已提交版本。
 * 物体 id 沿用；mergeOf 记录两条修订来源；历史提交版本不被改写。
 */
export function finalizeMerge(image: ImageRecord, note?: string): ImageRecord {
  const session = image.mergeSession;
  if (!session) throw new Error('当前没有进行中的合并');
  const base = findSubmitted(image, session.baseVersion);
  const left = findSubmitted(image, session.leftVersion);
  const right = findSubmitted(image, session.rightVersion);
  if (!base || !left || !right) throw new Error('合并来源版本缺失，无法完成合并');
  const { objects, unresolved } = computeMerge(base.objects, left.objects, right.objects, session.resolutions);
  if (unresolved.length > 0) throw new Error(`还有 ${unresolved.length} 项争议未确认，无法提交合并结果`);
  const next = clone(image);
  const ts = nowIso();
  next.versions.push({
    version: next.versions.length + 1,
    status: 'submitted',
    objects,
    createdAt: ts,
    submittedAt: ts,
    basedOn: session.baseVersion,
    mergeOf: [session.leftVersion, session.rightVersion],
    note,
  });
  next.mergeSession = null;
  return next;
}
