import type {
  AnnotationObject,
  Contour,
  ImageRecord,
  ImageVersion,
  MergeConflict,
  MergeResolution,
  MergeAudit,
  MergeSession,
  ObjectTransform,
  Point,
  RegionOrigin,
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
  relationId?: string;
  sourceObjectIds?: string[];
  targetObjectIds?: string[];
  forceOneSidedRelationChange?: boolean;
  baseVersion: number;
  aVersion: number;
  bVersion: number;
}

interface TopologyResult {
  baseObjects: AnnotationObject[];
  aObjects: AnnotationObject[];
  bObjects: AnnotationObject[];
  conflicts: MergeConflict[];
  selectedRelations: Array<{ id: string; transform: ObjectTransform }>;
  splitTargets: Map<string, { sourceId: string; side: 'a' | 'b' }>;
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

  if (ctx.forceOneSidedRelationChange && (aChanged || bChanged) && a !== DELETED && b !== DELETED && !eq(a, b)) {
    const toView = (v: Maybe<T>) => (v === DELETED ? '（已删除）' : clone(v));
    const forced: MergeConflict = {
      ...meta,
      relationId: ctx.relationId,
      sourceObjectIds: ctx.sourceObjectIds ? [...ctx.sourceObjectIds] : undefined,
      targetObjectIds: ctx.targetObjectIds ? [...ctx.targetObjectIds] : undefined,
      baseValue: toView(base),
      aValue: toView(a),
      bValue: toView(b),
    };
    ctx.conflicts.push(forced);
    const pick = ctx.resolutions[forced.id];
    if (!pick || pick === 'disputed') {
      if (ctx.strict) throw new Error('冲突未裁决：' + forced.message);
      return base;
    }
    if (pick === 'discard') return base;
    return pick === 'a' ? a : b;
  }

  if (!aChanged && !bChanged) return base;
  if (aChanged && !bChanged) return a;
  if (bChanged && !aChanged) return b;
  if (a === DELETED && b === DELETED) return DELETED;
  if (a !== DELETED && b !== DELETED && eq(a, b)) return a;

  const toView = (v: Maybe<T>) => (v === DELETED ? '（已删除）' : clone(v));
  const conflict: MergeConflict = {
    ...meta,
    relationId: ctx.relationId,
    sourceObjectIds: ctx.sourceObjectIds ? [...ctx.sourceObjectIds] : undefined,
    targetObjectIds: ctx.targetObjectIds ? [...ctx.targetObjectIds] : undefined,
    baseValue: toView(base),
    aValue: toView(a),
    bValue: toView(b),
  };
  ctx.conflicts.push(conflict);
  const pick = ctx.resolutions[conflict.id];
  if (!pick || pick === 'disputed') {
    if (ctx.strict) throw new Error('冲突未裁决：' + conflict.message);
    return base;
  }
  if (pick === 'discard') return base;
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
  const aContourExists = (a as unknown as Maybe<Contour>) !== DELETED;
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
    const aHole = (a as unknown as Maybe<Contour>) === DELETED ? undefined : a.holes.find((h) => h.id === holeId);
    const bHole = (b as unknown as Maybe<Contour>) === DELETED ? undefined : b.holes.find((h) => h.id === holeId);
    const oldHole = baseC?.holes.find((h) => h.id === holeId) ?? aHole ?? bHole;
    if (merged !== DELETED) {
      holes.push({
        ...oldHole,
        id: holeId,
        points: merged,
        origin: oldHole?.origin ?? {
          version: aHole ? ctx.aVersion : ctx.bVersion,
          objectId,
          contourId,
          holeId,
        },
      });
    }
  }
  if (points === DELETED) return DELETED;
  const origin = baseC?.origin
    ?? (aContourExists ? { version: ctx.aVersion, objectId, contourId } : { version: ctx.bVersion, objectId, contourId });
  return { ...baseC, id: contourId, points, holes, origin };
}

function mergeObject(
  ctx: Ctx,
  objectId: string,
  base: AnnotationObject | undefined,
  a: AnnotationObject | undefined,
  b: AnnotationObject | undefined,
  splitTarget: { kind: 'split'; sourceId: string; side: 'a' | 'b' } | null = null,
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
  if (!base && splitTarget?.kind === 'split') {
    const topologySide = splitTarget.side === 'a' ? a! : b!;
    const otherSide = splitTarget.side === 'a' ? b! : a!;
    const contours = topologySide.contours.map((topologyContour) => {
      const otherContour = otherSide.contours.find((c) => c.origin?.contourId === topologyContour.origin?.contourId);
      const points = mergeValue<Point[]>(
        ctx,
        {
          id: 'outline:' + objectId + ':' + topologyContour.id,
          objectId,
          contourId: topologyContour.id,
          part: 'outline',
          message: '拆出物体 ' + objectId + ' 的轮廓修改需要确认',
        },
        topologyContour.points,
        splitTarget.side === 'a' ? topologyContour.points : otherContour?.points ?? topologyContour.points,
        splitTarget.side === 'b' ? topologyContour.points : otherContour?.points ?? topologyContour.points,
      ) as Point[];
      const holes = topologyContour.holes.map((topologyHole) => {
        const otherHole = otherContour?.holes.find((h) => h.origin?.holeId === topologyHole.origin?.holeId);
        const points = mergeValue<Point[]>(
          ctx,
          {
            id: 'hole:' + objectId + ':' + topologyContour.id + ':' + topologyHole.id,
            objectId,
            contourId: topologyContour.id,
            holeId: topologyHole.id,
            part: 'hole',
            message: '拆出物体 ' + objectId + ' 的孔洞不能在拆分后无声变成外轮廓，需确认修改',
          },
          topologyHole.points,
          splitTarget.side === 'a' ? topologyHole.points : otherHole?.points ?? topologyHole.points,
          splitTarget.side === 'b' ? topologyHole.points : otherHole?.points ?? topologyHole.points,
        ) as Point[];
        return { ...topologyHole, points };
      });
      return { ...topologyContour, points, holes };
    });
    return finalizeObject({
      ...topologySide,
      categoryId: mergeValue<string>(
        ctx,
        {
          id: 'category:' + objectId,
          objectId,
          part: 'category',
          message: '原物体 ' + splitTarget.sourceId + ' 的类别修改需要确认到拆出的物体 ' + objectId,
        },
        topologySide.categoryId,
        splitTarget.side === 'a' ? topologySide.categoryId : otherSide.categoryId,
        splitTarget.side === 'b' ? topologySide.categoryId : otherSide.categoryId,
      ) as string,
      contours,
    });
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
  let categoryId: string;
  if (splitTarget) {
    const topologySide = splitTarget.side === 'a' ? a! : b!;
    const otherSide = splitTarget.side === 'a' ? b! : a!;
    categoryId = mergeValue<string>(
      ctx,
      {
        id: 'category:' + objectId,
        objectId,
        part: 'category',
        message: '原物体 ' + splitTarget.sourceId + ' 的类别修改需要分别确认到拆出的物体 ' + objectId,
      },
      topologySide.categoryId,
      splitTarget.side === 'a' ? topologySide.categoryId : otherSide.categoryId,
      splitTarget.side === 'b' ? topologySide.categoryId : otherSide.categoryId,
    ) as string;
  } else {
    categoryId = mergeValue<string>(
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
  }
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

function transformId(t: ObjectTransform): string {
  return t.kind + ':' + t.mappings
    .map((m) => `${m.sourceObjectId}/${m.sourceContourId}->${m.targetObjectId}/${m.targetContourId}`)
    .sort()
    .join('|');
}

function signature(t: ObjectTransform): string {
  const sources = [...t.sourceObjectIds].sort();
  const contours = t.mappings
    .map((m) => `${m.sourceObjectId}:${m.sourceContourId}:${[...m.holes.map((h) => h.sourceHoleId)].sort().join(',')}`)
    .sort();
  return t.kind + '|' + sources.join(',') + '|' + contours.join(';');
}

function transformConflicts(aTransforms: ObjectTransform[], bTransforms: ObjectTransform[]): MergeConflict[] {
  const out: MergeConflict[] = [];
  const bBySignature = new Map(bTransforms.map((t) => [signature(t), t]));
  const handledB = new Set<string>();
  for (const aTransform of aTransforms) {
    const bTransform = bBySignature.get(signature(aTransform));
    if (bTransform) {
      handledB.add(signature(bTransform));
      continue;
    }
    out.push({
      id: transformId(aTransform),
      objectId: aTransform.sourceObjectIds[0] ?? aTransform.targetObjectIds[0] ?? '',
      part: aTransform.kind === 'split' ? 'split-relation' : 'merge-relation',
      sourceObjectIds: [...aTransform.sourceObjectIds],
      targetObjectIds: [...aTransform.targetObjectIds],
      baseValue: null,
      aValue: { kind: aTransform.kind, sources: aTransform.sourceObjectIds, targets: aTransform.targetObjectIds },
      bValue: null,
      message: aTransform.kind === 'split'
        ? '修订 A 把一个物体拆成多个，修订 B 尚未确认该拆分关系'
        : '修订 A 把多个物体合成一个，修订 B 尚未确认该合并关系',
    });
  }
  for (const bTransform of bTransforms) {
    if (handledB.has(signature(bTransform))) continue;
    out.push({
      id: transformId(bTransform),
      objectId: bTransform.sourceObjectIds[0] ?? bTransform.targetObjectIds[0] ?? '',
      part: bTransform.kind === 'split' ? 'split-relation' : 'merge-relation',
      sourceObjectIds: [...bTransform.sourceObjectIds],
      targetObjectIds: [...bTransform.targetObjectIds],
      baseValue: null,
      aValue: null,
      bValue: { kind: bTransform.kind, sources: bTransform.sourceObjectIds, targets: bTransform.targetObjectIds },
      message: bTransform.kind === 'split'
        ? '修订 B 把一个物体拆成多个，修订 A 尚未确认该拆分关系'
        : '修订 B 把多个物体合成一个，修订 A 尚未确认该合并关系',
    });
  }
  return out;
}

function findContour(obj: AnnotationObject | undefined, contourId: string, useOrigin = false) {
  return obj?.contours.find((c) => (useOrigin ? c.origin?.contourId ?? c.id : c.id) === contourId);
}

function findHole(contour: Contour | undefined, holeId: string, useOrigin = false) {
  return contour?.holes.find((h) => (useOrigin ? h.origin?.holeId ?? h.id : h.id) === holeId);
}

function applyTransformToVersion(
  base: ImageVersion,
  side: ImageVersion | null,
  transform: ObjectTransform,
): AnnotationObject[] {
  const baseById = new Map(base.objects.map((o) => [o.id, o]));
  const sideById = side ? new Map(side.objects.map((o) => [o.id, o])) : new Map<string, AnnotationObject>();
  const usedSources = new Set(transform.sourceObjectIds);
  const result: AnnotationObject[] = [];
  const targets = new Map<string, AnnotationObject>();

  for (const targetId of transform.targetObjectIds) {
    const sideTarget = side?.objects.find((o) => o.id === targetId);
    const obj: AnnotationObject = {
      id: targetId,
      categoryId: transform.kind === 'merge' || targetId === transform.targetObjectIds[0]
        ? sideById.get(transform.sourceObjectIds[0])?.categoryId ?? baseById.get(transform.sourceObjectIds[0])?.categoryId ?? ''
        : (sideTarget?.categoryId ?? baseById.get(transform.sourceObjectIds[0])?.categoryId ?? ''),
      contours: [],
      createdAt: sideTarget?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      origins: [],
    };
    targets.set(targetId, obj);
    result.push(obj);
  }

  for (const mapping of transform.mappings) {
    const target = targets.get(mapping.targetObjectId)!;
    const sideSource = sideById.get(mapping.sourceObjectId);
    const sideTarget = side?.objects.find((o) => o.id === mapping.targetObjectId);
    const sideTargetContour = sideTarget?.contours.find((c) => c.id === mapping.targetContourId);
    const sideSourceContour = findContour(sideSource, mapping.sourceContourId, true);
    const baseContour = findContour(baseById.get(mapping.sourceObjectId), mapping.sourceContourId, true)
      ?? findContour(baseById.get(mapping.sourceObjectId), mapping.sourceContourId, false);
    const sourceContour = sideTargetContour ?? sideSourceContour ?? baseContour;
    if (!sourceContour) continue;
    const origin: RegionOrigin = {
      version: base.version,
      objectId: mapping.sourceObjectId,
      contourId: mapping.sourceContourId,
    };
    const holes = sourceContour.holes.map((sideHole) => {
      const mappedHole = mapping.holes.find((h) =>
        h.targetHoleId === sideHole.id || h.sourceHoleId === (sideHole.origin?.holeId ?? sideHole.id));
      const baseHole = findHole(baseContour, mappedHole?.sourceHoleId ?? sideHole.origin?.holeId ?? sideHole.id, true)
        ?? findHole(baseContour, sideHole.id, false);
      return {
        ...clone(baseHole ?? sideHole),
        points: clone(sideHole.points),
        id: mappedHole?.targetHoleId ?? sideHole.id,
        origin: { ...origin, holeId: mappedHole?.sourceHoleId ?? sideHole.origin?.holeId ?? baseHole?.id ?? sideHole.id },
      };
    });
    target.contours.push({
      ...clone(sourceContour),
      id: mapping.targetContourId,
      origin,
      holes,
    });
    target.origins!.push(origin);
  }

  const untouched = (side ?? base).objects.filter((o) => !usedSources.has(o.id) && !transform.targetObjectIds.includes(o.id));
  return [...result, ...clone(untouched)];
}

function reverseTransformToBase(
  base: ImageVersion,
  side: ImageVersion,
  transform: ObjectTransform,
): AnnotationObject[] {
  if (transform.kind === 'split') {
    const targets = transform.targetObjectIds.map((targetId, index) => {
      const sourceId = transform.sourceObjectIds[0];
      const source = side.objects.find((o) => o.id === sourceId)!;
      const sourceObj = index === 0 ? clone(source) : {
        ...clone(source),
        id: targetId,
        contours: [],
        origins: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      if (index > 0) sourceObj.contours = [];
      const ids = transform.mappings.filter((m) => m.targetObjectId === targetId);
      sourceObj.contours = ids.map((mapping) => {
        const baseContour = findContour(base.objects.find((o) => o.id === mapping.sourceObjectId), mapping.sourceContourId, true);
        const sideContour = findContour(source, mapping.sourceContourId, true);
        const holes = (baseContour ?? sideContour)!.holes.map((baseHole) => {
          const mappedHole = mapping.holes.find((h) => h.sourceHoleId === (baseHole.origin?.holeId ?? baseHole.id));
          const sideHole = findHole(sideContour, mappedHole?.sourceHoleId ?? baseHole.id, true);
          return {
            ...baseHole,
            id: mappedHole?.targetHoleId ?? baseHole.id,
            points: clone(sideHole?.points ?? baseHole.points),
            origin: { version: base.version, objectId: mapping.sourceObjectId, contourId: mapping.sourceContourId, holeId: mappedHole?.sourceHoleId ?? baseHole.id },
          };
        });
        return {
          ...clone(baseContour ?? sideContour!),
          id: mapping.targetContourId,
          points: clone(sideContour?.points ?? baseContour!.points),
          origin: { version: base.version, objectId: mapping.sourceObjectId, contourId: mapping.sourceContourId },
          holes,
        };
      });
      sourceObj.origins = sourceObj.contours.map((c) => c.origin!);
      return sourceObj;
    });
    return [...targets, ...side.objects.filter((o) => !transform.sourceObjectIds.includes(o.id)).map(clone)];
  }
  const targetId = transform.targetObjectIds[0];
  const first = side.objects.find((o) => o.id === transform.sourceObjectIds[0]);
  const target: AnnotationObject = {
    id: targetId,
    categoryId: first?.categoryId ?? base.objects.find((o) => o.id === transform.sourceObjectIds[0])?.categoryId ?? '',
    contours: [],
    createdAt: first?.createdAt ?? nowIso(),
    updatedAt: nowIso(),
    origins: [],
  };
  for (const mapping of transform.mappings) {
    const sideObj = side.objects.find((o) => o.id === mapping.sourceObjectId);
    const sideContour = findContour(sideObj, mapping.sourceContourId, true);
    const baseContour = findContour(base.objects.find((o) => o.id === mapping.sourceObjectId), mapping.sourceContourId, true);
    const contour = sideContour ?? baseContour;
    if (contour) target.contours.push(clone({ ...contour, id: mapping.targetContourId }));
  }
  target.origins = target.contours.map((c) => c.origin!);
  return [target, ...side.objects.filter((o) => !transform.sourceObjectIds.includes(o.id) && o.id !== targetId).map(clone)];
}

function normalizeTopology(
  base: ImageVersion,
  a: ImageVersion,
  b: ImageVersion,
  relations: Record<string, MergeRelationChoice>,
): TopologyResult {
  const relationConflicts = transformConflicts(a.objectTransforms ?? [], b.objectTransforms ?? []);
  const chosen: ObjectTransform[] = [];
  for (const conflict of relationConflicts) {
    const choice = relations[conflict.id];
    if (!choice || choice === 'disputed') {
      return { baseObjects: base.objects.map(clone), aObjects: a.objects.map(clone), bObjects: b.objects.map(clone), conflicts: [conflict], selectedRelations: [], splitTargets: new Map() };
    }
    if (choice === 'a' || choice === 'b') {
      chosen.push((choice === 'a' ? a.objectTransforms : b.objectTransforms)!.find((t) => transformId(t) === conflict.id)!);
    }
  }
  const same = (a.objectTransforms ?? []).filter((ta) =>
    (b.objectTransforms ?? []).some((tb) => signature(ta) === signature(tb)));
  const transforms = [...chosen, ...same];
  let baseObjects = base.objects.map(clone);
  let aObjects = a.objects.map(clone);
  let bObjects = b.objects.map(clone);
  const splitTargets = new Map<string, { sourceId: string; side: 'a' | 'b' }>();
  for (const transform of transforms) {
    const inA = (a.objectTransforms ?? []).some((t) => transformId(t) === transformId(transform) || signature(t) === signature(transform));
    const inB = (b.objectTransforms ?? []).some((t) => transformId(t) === transformId(transform) || signature(t) === signature(transform));
    const tmpBase: ImageVersion = { ...base, objects: baseObjects };
    const tmpA: ImageVersion = { ...a, objects: aObjects };
    const tmpB: ImageVersion = { ...b, objects: bObjects };
    if (inA && inB) {
      baseObjects = applyTransformToVersion(tmpBase, null, transform);
      aObjects = applyTransformToVersion(tmpBase, tmpA, transform);
      bObjects = applyTransformToVersion(tmpBase, tmpB, transform);
    } else if (inA) {
      baseObjects = applyTransformToVersion(tmpBase, null, transform);
      aObjects = applyTransformToVersion(tmpBase, tmpA, transform);
      bObjects = reverseTransformToBase(tmpBase, tmpB, transform);
      if (transform.kind === 'split') {
        transform.targetObjectIds.forEach((targetId) => splitTargets.set(targetId, { sourceId: transform.sourceObjectIds[0], side: 'a' }));
      }
    } else if (inB) {
      baseObjects = applyTransformToVersion(tmpBase, null, transform);
      aObjects = reverseTransformToBase(tmpBase, tmpA, transform);
      bObjects = applyTransformToVersion(tmpBase, tmpB, transform);
      if (transform.kind === 'split') {
        transform.targetObjectIds.forEach((targetId) => splitTargets.set(targetId, { sourceId: transform.sourceObjectIds[0], side: 'b' }));
      }
    }
  }
  same.forEach((transform) => {
    if (transform.kind === 'split') {
      transform.targetObjectIds.forEach((targetId) => splitTargets.set(targetId, { sourceId: transform.sourceObjectIds[0], side: 'a' }));
    }
  });
  return { baseObjects, aObjects, bObjects, conflicts: [], selectedRelations: chosen.map((transform) => ({ id: transformId(transform), transform })), splitTargets };
}

export type MergeRelationChoice = 'a' | 'b' | 'discard' | 'disputed';

function runMerge(
  base: ImageVersion,
  a: ImageVersion,
  b: ImageVersion,
  resolutions: Record<string, MergeResolution>,
  relations: Record<string, MergeRelationChoice>,
  strict: boolean,
): { objects: AnnotationObject[]; conflicts: MergeConflict[] } {
  const topology = normalizeTopology(base, a, b, relations);
  if (topology.conflicts.length > 0) {
    return { objects: topology.baseObjects, conflicts: topology.conflicts };
  }
  const ctx: Ctx = {
    conflicts: [],
    resolutions,
    strict,
    baseVersion: base.version,
    aVersion: a.version,
    bVersion: b.version,
  };
  const byId = (objects: AnnotationObject[]) => new Map(objects.map((o) => [o.id, o]));
  const mb = byId(topology.baseObjects);
  const ma = byId(topology.aObjects);
  const mbb = byId(topology.bObjects);
  const ids = new Set<string>([...mb.keys(), ...ma.keys(), ...mbb.keys()]);
  const objects: AnnotationObject[] = [];
  for (const id of ids) {
    const splitInfo = topology.splitTargets.get(id);
    const relation = topology.selectedRelations.find((r) => r.transform.targetObjectIds.includes(id));
    ctx.relationId = relation?.id;
    ctx.sourceObjectIds = relation?.transform.sourceObjectIds;
    ctx.targetObjectIds = relation?.transform.targetObjectIds;
    ctx.forceOneSidedRelationChange = topology.splitTargets.has(id);
    const merged = mergeObject(
      ctx,
      id,
      mb.get(id),
      ma.get(id),
      mbb.get(id),
      splitInfo ? { kind: 'split' as const, sourceId: splitInfo.sourceId, side: splitInfo.side } : null,
    );
    if (merged) {
      merged.origins = merged.contours.map((c) => c.origin ?? {
        version: base.version,
        objectId: id,
        contourId: c.id,
      });
      objects.push(merged);
    }
  }
  for (const conflict of ctx.conflicts) {
    const match = topology.selectedRelations.find(({ transform }) => transform.targetObjectIds.includes(conflict.objectId));
    if (match) {
      conflict.relationId = match.id;
      conflict.sourceObjectIds = [...match.transform.sourceObjectIds];
      conflict.targetObjectIds = [...match.transform.targetObjectIds];
    }
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
  return planMergeWithRelations(image, aVersion, bVersion, {});
}

export function planMergeWithRelations(
  image: ImageRecord,
  aVersion: number,
  bVersion: number,
  relations: Record<string, MergeRelationChoice>,
): MergePlan {
  const baseVersion = resolveMergeBase(image, aVersion, bVersion);
  const { conflicts } = runMerge(
    getSubmitted(image, baseVersion),
    getSubmitted(image, aVersion),
    getSubmitted(image, bVersion),
    {},
    relations,
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
    relations: {},
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
  const { objects, conflicts } = runMerge(base, a, b, session.resolutions, session.relations, true);
  const unresolved = conflicts.filter((c) =>
    c.part === 'split-relation' || c.part === 'merge-relation'
      ? !session.relations[c.id] || session.relations[c.id] === 'disputed'
      : !session.resolutions[c.id],
  );
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
    objectTransforms: objects.some((o) => o.origins?.length)
      ? [
          ...(a.objectTransforms ?? []).filter((t) => {
            const id = transformId(t);
            const same = (b.objectTransforms ?? []).some((other) => signature(other) === signature(t));
            return same || session.relations[id] === 'a';
          }),
          ...(b.objectTransforms ?? []).filter((t) => session.relations[transformId(t)] === 'b'),
        ]
      : undefined,
    mergeAudit: {
      sessionId: session.id,
      relationChoices: Object.entries(session.relations)
        .filter(([, choice]) => choice !== 'discard')
        .map(([id, choice]) => ({ id, choice: choice as 'a' | 'b', at: nowIso() })),
      decisions: Object.entries(session.resolutions)
        .filter(([, choice]) => choice !== 'disputed')
        .map(([conflictId, choice]) => ({ conflictId: conflictId as string, choice: choice as 'a' | 'b' | 'discard', at: nowIso() })),
    },
    note: note ?? ('合并 v' + session.aVersion + ' 与 v' + session.bVersion + '（基线 v' + session.baseVersion + '）'),
  });
  return next;
}
