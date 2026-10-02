import type {
  AnnotationObject,
  Contour,
  ImageRecord,
  ImageVersion,
  MergeConflict,
  MergeRelation,
  MergeRelationDecision,
  MergeResolution,
  MergeSession,
  Point,
  RegionSource,
} from '../types';
import { pointInPolygon, polygonArea, pointOnPolygonBoundary, uid } from './geometry';
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
  relations: MergeRelation[];
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
  if (pick === 'discard' || pick === 'disputed') {
    if (pick === 'disputed' && ctx.strict) throw new Error('冲突仍有争议：' + conflict.message);
    return base;
  }
  return (pick === 'b' || pick === 'adopt-b') ? b : a;
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

function contourCenter(points: Point[]): Point {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function polygonsShareArea(a: Point[], b: Point[]): boolean {
  if (polygonArea(a) === 0 || polygonArea(b) === 0) return false;
  const strictlyInside = (p: Point, poly: Point[]) => pointInPolygon(p, poly) && !pointOnPolygonBoundary(p, poly);
  const samples = (points: Point[]) =>
    [contourCenter(points), ...points.flatMap((p, i) => {
      const q = points[(i + 1) % points.length];
      return [{ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, p];
    })];
  return samples(a).some((p) => strictlyInside(p, b)) || samples(b).some((p) => strictlyInside(p, a));
}

function relationKey(parts: string[]): string {
  return [...new Set(parts)].sort().join('+');
}

interface FlowCell {
  target: AnnotationObject;
  shares: boolean;
}

/** 基线物体与修订中新结构物体之间的区域流动矩阵 */
function flowMatrix(base: ImageVersion, revised: ImageVersion, structuralIds: Set<string>) {
  const targets = revised.objects.filter((o) => structuralIds.has(o.id));
  const rows = new Map<string, Map<string, FlowCell>>();
  for (const source of base.objects) {
    const row = new Map<string, FlowCell>();
    for (const target of targets) {
      const shares = target.contours.some((tc) =>
        source.contours.some((sc) => polygonsShareArea(tc.points, sc.points)),
      );
      if (shares) row.set(target.id, { target, shares });
    }
    rows.set(source.id, row);
  }
  return { targets, rows };
}

/**
 * 识别一侧修订中的拆合结构，支持连续返工链：
 * 一个基线物体先拆成多个中间物体，其中某个中间物体又与别的（中间）物体合并。
 * 直接来源记录中间物体 id，baseSourceObjectIds 始终追溯到基线物体。
 */
function detectSideRelations(side: 'a' | 'b', base: ImageVersion, revised: ImageVersion): MergeRelation[] {
  const out: MergeRelation[] = [];
  const baseIds = new Set(base.objects.map((o) => o.id));
  // 结构物体：修订中新出现的 id（id 不变、只改类别/孔洞的物体不参与拆合）
  const structuralIds = new Set(revised.objects.filter((o) => !baseIds.has(o.id)).map((o) => o.id));
  const { targets, rows } = flowMatrix(base, revised, structuralIds);
  const targetById = new Map(targets.map((t) => [t.id, t]));

  // 孔洞提升为外轮廓：始终保留为独立关系，要求人工确认
  for (const source of base.objects) {
    for (const sc of source.contours) {
      for (const hole of sc.holes) {
        const promoted = revised.objects.filter((obj) =>
          structuralIds.has(obj.id) &&
            obj.contours.some((c) =>
              polygonsShareArea(c.points, hole.points) &&
                polygonArea(c.points) <= polygonArea(hole.points) * 3,
            ),
        );
        for (const obj of promoted) {
          out.push({
            id: 'relation:hole-promotion:' + side + ':' + source.id + ':' + sc.id + ':' + hole.id + ':' + obj.id,
            kind: 'hole-to-outline',
            side,
            sourceObjectIds: [source.id],
            baseSourceObjectIds: [source.id],
            sourceContourIds: [sc.id],
            sourceHoleIds: [hole.id],
            targetObjectIds: [obj.id],
            prerequisiteRelationIds: [],
            message: '修订 ' + side.toUpperCase() + ' 将物体 ' + source.id + ' 的孔洞 ' + hole.id + ' 提升为物体 ' + obj.id + ' 的外轮廓',
          });
        }
      }
    }
  }

  // 结构目标 -> 它覆盖到的基线物体（合并的祖先来源）
  const targetRoots = new Map<string, Set<string>>();
  for (const target of targets) {
    const roots = new Set<string>();
    for (const source of base.objects) {
      if (rows.get(source.id)?.has(target.id)) roots.add(source.id);
    }
    targetRoots.set(target.id, roots);
  }

  // 1) 拆分：同一基线物体的区域流向了多个新物体
  const splitTargetsByRoot = new Map<string, Set<string>>();
  for (const source of base.objects) {
    const reached = [...(rows.get(source.id)?.keys() ?? [])];
    if (reached.length > 1) {
      splitTargetsByRoot.set(source.id, new Set(reached));
      out.push({
        id: 'relation:split:' + side + ':' + source.id + ':' + relationKey(reached),
        kind: 'split',
        side,
        sourceObjectIds: [source.id],
        baseSourceObjectIds: [source.id],
        targetObjectIds: reached.slice().sort(),
        prerequisiteRelationIds: [],
        message: '修订 ' + side.toUpperCase() + ' 将物体 ' + source.id + ' 拆分为 ' + reached.length + ' 个物体（' + reached.sort().join('、') + '）',
      });
    }
  }

  // 2) 合并 / 局部合并：一个新物体覆盖了多个（追溯到基线的）来源物体。
  //    直接来源按几何关系给出：能对上拆分产物时引用中间物体，否则直接引用基线物体。
  for (const target of targets) {
    const roots = [...(targetRoots.get(target.id) ?? [])].sort();
    if (roots.length < 2) continue;
    const directSources: string[] = [];
    const prerequisites: string[] = [];
    for (const rootId of roots) {
      const splitSet = splitTargetsByRoot.get(rootId);
      const splitRelId = 'relation:split:' + side + ':' + rootId + ':' + relationKey([...(splitSet ?? [])].sort());
      if (splitSet?.has(target.id)) {
        // 目标本身就是拆分产物之一（可能就地扩张完成局部合并）：根来源经由拆分链到达，
        // 但拆分产物中没有独立的中间物体可引用
        prerequisites.push(splitRelId);
        directSources.push(rootId);
      } else {
        // 目标不是拆分产物：与它区域重合的拆分中间物体即为直接来源
        const intermediates = splitSet
          ? [...splitSet].filter((tid) => shareArea(targetById.get(tid)!, target))
          : [];
        if (intermediates.length > 0) {
          for (const tid of intermediates) directSources.push(tid);
          prerequisites.push(splitRelId);
        } else {
          directSources.push(rootId);
        }
      }
    }
    const uniqSources = [...new Set(directSources)].sort();
    if (uniqSources.length < 2) continue; // 不是真合并（同一来源的碎片相触）
    out.push({
      id: 'relation:merge:' + side + ':' + relationKey(uniqSources) + ':' + target.id,
      kind: 'merge',
      side,
      sourceObjectIds: uniqSources,
      baseSourceObjectIds: roots,
      targetObjectIds: [target.id],
      prerequisiteRelationIds: [...new Set(prerequisites)].sort(),
      message: '修订 ' + side.toUpperCase() + ' 将 ' + uniqSources.length + ' 个来源（' + uniqSources.join('、') + '）局部合并为 ' + target.id,
    });
  }

  return out;
}

function shareArea(a: AnnotationObject, b: AnnotationObject): boolean {
  return a.contours.some((ca) => b.contours.some((cb) => polygonsShareArea(ca.points, cb.points)));
}

export function detectMergeRelations(base: ImageVersion, a: ImageVersion, b: ImageVersion): MergeRelation[] {
  return [...detectSideRelations('a', base, a), ...detectSideRelations('b', base, b)];
}

function normalizeSession(session: MergeSession): MergeSession {
  return { ...session, resolutions: { ...session.resolutions }, relations: { ...(session.relations ?? {}) } };
}

function provenanceSources(relation: MergeRelation): RegionSource[] {
  // 始终追溯到基线物体：连续返工链中的中间物体不能作为最终来源导出
  return (relation.baseSourceObjectIds ?? relation.sourceObjectIds).map((objectId) => ({
    objectId,
    contourId: relation.sourceContourIds?.find((cid) => cid) as string | undefined,
    holeId: relation.sourceHoleIds?.find((hid) => hid) as string | undefined,
  }));
}

/** 把已有 provenance 与本关系的基线来源拍平：去重，中间物体不进入来源链 */
function flattenSources(
  relation: MergeRelation,
  sourceObjects: Map<string, AnnotationObject>,
  baseIds: Set<string>,
): RegionSource[] {
  const merged: RegionSource[] = [];
  const seen = new Set<string>();
  const push = (source: RegionSource) => {
    const key = source.objectId + ':' + (source.contourId ?? '') + ':' + (source.holeId ?? '');
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(source);
    }
  };
  for (const sourceId of relation.sourceObjectIds) {
    const sourceObj = sourceObjects.get(sourceId);
    const fromBase = baseIds.has(sourceId);
    if (fromBase || !sourceObj?.provenance) {
      push({ objectId: sourceId, holeId: relation.sourceHoleIds?.[0] });
    } else {
      for (const leaf of sourceObj.provenance.sources) push(leaf);
    }
  }
  for (const rootId of relation.baseSourceObjectIds ?? []) push({ objectId: rootId });
  return merged;
}

function addRelationConflict(ctx: Ctx, relation: MergeRelation, decision: MergeRelationDecision | undefined): void {
  const id = 'conflict:' + relation.id;
  if (!ctx.conflicts.some((c) => c.id === id)) {
    ctx.conflicts.push({
      id,
      objectId: relation.targetObjectIds[0] ?? relation.sourceObjectIds[0],
      part: relation.kind === 'split' ? 'split-relation' : relation.kind === 'merge' ? 'merge-relation' : 'hole-promotion',
      sources: provenanceSources(relation),
      baseValue: relation.sourceObjectIds.join(', '),
      aValue: relation.side === 'a' ? relation.targetObjectIds.join(', ') : null,
      bValue: relation.side === 'b' ? relation.targetObjectIds.join(', ') : null,
      message: relation.message,
    });
  }
  if (!decision && ctx.strict) throw new Error('拆合关系未确认：' + relation.message);
  if (decision === 'disputed' && ctx.strict) throw new Error('拆合关系仍有争议：' + relation.message);
}

function mergeByIds(
  ctx: Ctx,
  base: ImageVersion,
  a: ImageVersion,
  b: ImageVersion,
): { objects: AnnotationObject[]; conflicts: MergeConflict[] } {
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

function attachProvenance(
  obj: AnnotationObject,
  relation: MergeRelation,
  available: Map<string, AnnotationObject>,
  base: ImageVersion,
): AnnotationObject {
  const next = finalizeObject(obj);
  const sources: RegionSource[] = [];
  const baseIds = new Set(base.objects.map((o) => o.id));
  const flat = flattenSources(relation, available, baseIds);
  for (const leaf of flat) {
    const baseObj = base.objects.find((o) => o.id === leaf.objectId);
    const matching = (baseObj?.contours ?? []).filter((sc) =>
      obj.contours.some((tc) => polygonsShareArea(tc.points, sc.points)),
    );
    if (matching.length > 0) {
      for (const sc of matching) sources.push({ objectId: leaf.objectId, contourId: sc.id, holeId: leaf.holeId });
    } else {
      sources.push(leaf);
    }
  }
  next.provenance = {
    sources: sources.length > 0 ? sources : provenanceSources(relation),
    transformation: relation.kind === 'merge' ? 'merge' : relation.kind === 'split' ? 'split' : 'identity',
  };
  for (const contour of next.contours) {
    if (relation.kind === 'hole-to-outline') {
      contour.sourceContourId = relation.sourceContourIds?.[0];
      contour.sourceHoleId = relation.sourceHoleIds?.[0];
    }
    for (const hole of contour.holes) hole.sourceHoleId ??= hole.id;
  }
  return next;
}

/** 从直接来源（可能是拆分中间产物，其孔洞已经带 sourceHoleId）继承孔洞 */
function carrySourceHoles(obj: AnnotationObject, sourceObjects: Map<string, AnnotationObject>): AnnotationObject {
  for (const contour of obj.contours) {
    for (const sourceObj of sourceObjects.values()) {
      for (const sourceContour of sourceObj.contours) {
        for (const hole of sourceContour.holes) {
          const inside = hole.points.every((p) => pointInPolygon(p, contour.points));
          const already = contour.holes.some((existing) =>
            existing.id === hole.id || existing.sourceHoleId === (hole.sourceHoleId ?? hole.id) || eq(existing.points, hole.points));
          if (inside && !already) {
            contour.holes.push({ ...clone(hole), sourceHoleId: hole.sourceHoleId ?? hole.id });
          }
        }
      }
    }
  }
  return obj;
}

function addSourceLevelConflicts(
  ctx: Ctx,
  relation: MergeRelation,
  targets: AnnotationObject[],
  structuralVersion: ImageVersion,
  sourceObjects: Map<string, AnnotationObject>,
  otherVersion: ImageVersion,
  pushedIds: Set<string>,
): void {
  const leafRoots = relation.baseSourceObjectIds ?? relation.sourceObjectIds;
  for (const sourceId of leafRoots) {
    const baseObj = sourceObjects.get(sourceId);
    const otherObj = otherVersion.objects.find((o) => o.id === sourceId);
    if (!baseObj || !otherObj) continue;
    const applicableTargets = targets.filter((t) =>
      t.contours.some((tc) => {
        const center = contourCenter(tc.points);
        return baseObj.contours.some((sc) => pointInPolygon(center, sc.points)) ||
          t.provenance?.sources.some((s) => s.objectId === sourceId);
      }),
    );
    for (const target of applicableTargets) {
      if (otherObj.categoryId !== baseObj.categoryId) {
        // id 只绑定“来源编辑 + 最终区域”：同一编辑沿拆合链映射到同一最终区域时只问一次，
        // 上游关系与下游关系共享同一条已映射决定
        const id = 'category-source:' + sourceId + ':' + target.id;
        if (!pushedIds.has(id)) {
          pushedIds.add(id);
          ctx.conflicts.push({
            id,
            objectId: target.id,
            part: 'category',
            dependsOn: (relation.prerequisiteRelationIds ?? [])[0] ?? relation.id,
            sources: [{ objectId: sourceId }],
            baseValue: baseObj.categoryId,
            aValue: relation.side === 'a' ? target.categoryId : otherObj.categoryId,
            bValue: relation.side === 'b' ? target.categoryId : otherObj.categoryId,
            message: '来源物体 ' + sourceId + ' 的类别修改对应拆合后的最终区域 ' + target.id,
          });
        }
        const decision = ctx.resolutions[id];
        if (!decision && ctx.strict) throw new Error('片段冲突未确认：' + id);
        if (decision === 'disputed' && ctx.strict) throw new Error('片段冲突仍有争议：' + id);
        const adoptOther = decision === (relation.side === 'a' ? 'adopt-b' : 'adopt-a');
        if (adoptOther) target.categoryId = otherObj.categoryId;
      }

      const sourceHoles = baseObj.contours.flatMap((sc) =>
        sc.holes.map((hole) => ({ contour: sc, hole, sourceObjectId: sourceId })),
      );
      for (const entry of sourceHoles) {
        const otherHole = otherObj.contours
          .find((c) => c.id === entry.contour.id)?.holes
          .find((h) => h.id === entry.hole.id);
        if (!otherHole) continue;
        const hostContours = target.contours.filter((tc) =>
          entry.hole.points.some((p) => pointInPolygon(p, tc.points)),
        );
        if (hostContours.length === 0) continue;
        const targetHole = hostContours.flatMap((tc) => tc.holes).find((h) =>
          h.id === entry.hole.id || h.sourceHoleId === (entry.hole.sourceHoleId ?? entry.hole.id));
        const fullyInside = hostContours.some((tc) => entry.hole.points.every((p) => pointInPolygon(p, tc.points)));
        const structuralPoints = targetHole?.points ?? DELETED;
        const otherPoints = otherHole.points;
        const otherChanged = !eq(otherHole.points, entry.hole.points);
        // 该孔洞在本关系的几个最终区域上都有落点：跨拆合边界，每一侧都需决定形态
        const rawStructuralTargets = relation.targetObjectIds
          .map((tid) => structuralVersion.objects.find((o) => o.id === tid))
          .filter((o): o is AnnotationObject => !!o);
        const holeLandsOn = (t: AnnotationObject) =>
          t.contours.some((tc) => entry.hole.points.some((p) => pointInPolygon(p, tc.points)));
        const siblingTargets = rawStructuralTargets.filter(holeLandsOn);
        const crosses = siblingTargets.length > 1;
        const id = 'hole-source:' + sourceId + ':' + target.id + ':' + entry.hole.id;
        if (otherChanged || crosses) {
          if (!pushedIds.has(id)) {
            pushedIds.add(id);
            ctx.conflicts.push({
              id,
              objectId: target.id,
              part: crosses ? 'hole-cross' : 'hole',
              contourId: entry.contour.id,
              holeId: entry.hole.id,
              dependsOn: (relation.prerequisiteRelationIds ?? [])[0] ?? relation.id,
              sources: [{ objectId: sourceId, contourId: entry.contour.id, holeId: entry.hole.id }],
              baseValue: entry.hole.points,
              aValue: relation.side === 'a' ? structuralPoints : otherPoints,
              bValue: relation.side === 'b' ? structuralPoints : otherPoints,
              message: crosses
                ? '来源物体 ' + sourceId + ' 的孔洞 ' + entry.hole.id + ' 跨过拆分边界（同时落入 ' + siblingTargets.map((t) => t.id).join('、') + '），需要决定最终区域 ' + target.id + ' 上的孔洞形态'
                : '来源物体 ' + sourceId + ' 的孔洞修改对应拆合后的最终区域 ' + target.id,
            });
          }
          const decision = ctx.resolutions[id];
          if (!decision && ctx.strict) throw new Error('片段冲突未确认：' + id);
          if (decision === 'disputed' && ctx.strict) throw new Error('片段冲突仍有争议：' + id);
          const adoptOther = decision === (relation.side === 'a' ? 'adopt-b' : 'adopt-a');
          if (adoptOther && otherChanged) {
            for (const tc of hostContours) {
              const idx = tc.holes.findIndex((h) => h.id === entry.hole.id || h.sourceHoleId === (entry.hole.sourceHoleId ?? entry.hole.id));
              if (idx >= 0) tc.holes[idx] = { ...otherHole, sourceHoleId: entry.hole.sourceHoleId ?? entry.hole.id };
            }
          }
        }
      }
    }
    // 跨拆合边界的孔洞：即使某个最终区域不再“包含”原孔，只要有孔点落在其中就必须让用户决定形态
    for (const entry of baseObj.contours.flatMap((sc) => sc.holes.map((hole) => ({ contour: sc, hole })))) {
      const otherHole = otherObj.contours
        .find((c) => c.id === entry.contour.id)?.holes
        .find((h) => h.id === entry.hole.id);
      if (!otherHole) continue;
      const rawTargets = relation.targetObjectIds
        .map((tid) => structuralVersion.objects.find((o) => o.id === tid))
        .filter((o): o is AnnotationObject => !!o);
      const geometryHole = otherHole;
      const landed = rawTargets.filter((rt) =>
        rt.contours.some((tc) => geometryHole.points.some((p) => pointInPolygon(p, tc.points))),
      );
      if (landed.length <= 1) continue;
      for (const raw of landed) {
        const target = targets.find((t) => t.id === raw.id);
        if (!target) continue;
        const id = 'hole-source:' + sourceId + ':' + target.id + ':' + entry.hole.id;
        const already = pushedIds.has(id);
        pushedIds.add(id);
        const existing = ctx.conflicts.find((c) => c.id === id);
        if (existing) existing.part = 'hole-cross';
        const hostContours = target.contours.filter((tc) =>
          entry.hole.points.some((p) => pointInPolygon(p, tc.points)),
        );
        if (!existing) {
          ctx.conflicts.push({
            id,
            objectId: target.id,
            part: 'hole-cross',
            contourId: entry.contour.id,
            holeId: entry.hole.id,
            dependsOn: (relation.prerequisiteRelationIds ?? [])[0] ?? relation.id,
            sources: [{ objectId: sourceId, contourId: entry.contour.id, holeId: entry.hole.id }],
            baseValue: entry.hole.points,
            aValue: relation.side === 'a' ? DELETED : otherHole.points,
            bValue: relation.side === 'b' ? DELETED : otherHole.points,
            message: '来源物体 ' + sourceId + ' 的孔洞 ' + entry.hole.id + ' 跨过拆分边界（同时落入 ' + landed.map((t) => t.id).join('、') + '），需要决定最终区域 ' + target.id + ' 上的孔洞形态',
          });
        }
        const decision = ctx.resolutions[id];
        if (!decision && ctx.strict) throw new Error('片段冲突未确认：' + id);
        if (decision === 'disputed' && ctx.strict) throw new Error('片段冲突仍有争议：' + id);
        const adoptOther = decision === (relation.side === 'a' ? 'adopt-b' : 'adopt-a');
        if (adoptOther && (!already || existing?.part === 'hole-cross')) {
          for (const tc of hostContours) tc.holes.push({ ...otherHole, sourceHoleId: entry.hole.sourceHoleId ?? entry.hole.id });
        }
      }
    }
  }
}

function runRelationMerge(
  ctx: Ctx,
  base: ImageVersion,
  a: ImageVersion,
  b: ImageVersion,
  relations: MergeRelation[],
  relationDecisions: Record<string, MergeRelationDecision>,
): { objects: AnnotationObject[]; conflicts: MergeConflict[] } {
  const legacyCtx: Ctx = { conflicts: [], resolutions: {}, strict: false };
  const byIdResult = mergeByIds(legacyCtx, base, a, b);
  const outputs = new Map(byIdResult.objects.map((o) => [o.id, o]));
  const baseIds = new Set(base.objects.map((o) => o.id));
  const bySide = {
    a: new Map(a.objects.map((o) => [o.id, o])),
    b: new Map(b.objects.map((o) => [o.id, o])),
  };
  // 已经生成的中间/最终结构物体，供下游关系拍平来源链
  const produced = new Map<string, AnnotationObject>();
  const baseById = new Map(base.objects.map((o) => [o.id, o]));
  const pushedConflictIds = new Set<string>();

  // 拓扑排序：先做被依赖的上游拆分，再做引用其产物的合并；同层按 id 稳定排序
  const relationById = new Map(relations.map((r) => [r.id, r]));
  const order: MergeRelation[] = [];
  const visiting = new Set<string>();
  const visit = (relation: MergeRelation) => {
    if (order.includes(relation) || visiting.has(relation.id)) return;
    visiting.add(relation.id);
    for (const prereqId of relation.prerequisiteRelationIds ?? []) {
      const prereq = relationById.get(prereqId);
      if (prereq) visit(prereq);
    }
    visiting.delete(relation.id);
    order.push(relation);
  };
  [...relations].sort((x, y) => x.id.localeCompare(y.id)).forEach(visit);

  // 先落地所有非确认关系对基线物体的保留；确认关系随后按拓扑顺序移除/替换它们消费的来源，
  // 避免已确认拆分的根物体被“未决定”分支又当作原样保留导出
  for (const relation of order) {
    const decision = relationDecisions[relation.id];
    if (decision === 'confirmed') continue;
    const otherById = relation.side === 'a' ? bySide.b : bySide.a;
    for (const sourceId of relation.sourceObjectIds) {
      if (baseIds.has(sourceId)) {
        const kept = otherById.get(sourceId) ?? baseById.get(sourceId);
        if (kept) outputs.set(sourceId, finalizeObject(kept));
      }
    }
    for (const targetId of relation.targetObjectIds) {
      outputs.delete(targetId);
      produced.delete(targetId);
    }
  }

  for (const relation of order) {
    const decision = relationDecisions[relation.id];
    const structural = relation.side === 'a' ? bySide.a : bySide.b;
    const otherById = relation.side === 'a' ? bySide.b : bySide.a;
    const otherVersion = relation.side === 'a' ? b : a;

    if (decision === 'rejected') {
      // 舍弃结构的恢复已在上方统一完成；这里不再落地任何结构产物
      continue;
    }

    // 无论确认与否，都生成带 provenance 的临时结果用于派生片段冲突（允许只确认部分后保存继续）
    const available = new Map<string, AnnotationObject>([
      ...baseById,
      ...produced,
      ...[...structural].filter(([id]) => !baseIds.has(id)),
    ]);
    const targets = relation.targetObjectIds
      .map((id) => structural.get(id))
      .filter((o): o is AnnotationObject => !!o)
      .map((o) => {
        const withProv = attachProvenance(o, relation, available, base);
        const directSources = new Map<string, AnnotationObject>();
        for (const sourceId of relation.sourceObjectIds) {
          const src = produced.get(sourceId) ?? baseById.get(sourceId);
          if (src) directSources.set(sourceId, src);
        }
        return carrySourceHoles(withProv, directSources);
      });
    addSourceLevelConflicts(ctx, relation, targets, (relation.side === 'a' ? a : b), available, otherVersion, pushedConflictIds);

    if (decision === 'disputed' && ctx.strict) throw new Error('拆合关系仍有争议：' + relation.message);
    if (!decision && ctx.strict) throw new Error('拆合关系未确认：' + relation.message);
    if (decision !== 'confirmed') continue;

    for (const id of [...relation.sourceObjectIds, ...relation.targetObjectIds]) {
      outputs.delete(id);
    }
    for (const target of targets) {
      outputs.set(target.id, target);
      produced.set(target.id, target);
    }
    // 已被确认关系消费的基线物体：避免中间来源再次导出
    for (const rootId of relation.baseSourceObjectIds ?? relation.sourceObjectIds) outputs.delete(rootId);
  }

  const finalObjects = [...outputs.values()];
  const removedObjects = new Set<string>();
  const dupSeen = new Set<string>();
  for (let i = 0; i < finalObjects.length; i++) {
    for (let j = i + 1; j < finalObjects.length; j++) {
      const x = finalObjects[i];
      const y = finalObjects[j];
      const overlaps = x.contours.some((cx) => y.contours.some((cy) => polygonsShareArea(cx.points, cy.points)));
      const xSources = new Set((x.provenance?.sources ?? [{ objectId: x.id }]).map((s) => s.objectId));
      const ySources = new Set((y.provenance?.sources ?? [{ objectId: y.id }]).map((s) => s.objectId));
      const sharedSource = [...xSources].some((id) => ySources.has(id));
      // 同一来源被多次引用、或一边结构一边原样保留：歧义必须交给用户，半成品不能重复导出
      if (overlaps && (sharedSource || xSources.has(y.id) || ySources.has(x.id))) {
        const id = 'duplicate-region:' + [x.id, y.id].sort().join(':');
        if (!dupSeen.has(id)) {
          dupSeen.add(id);
          ctx.conflicts.push({
            id,
            objectId: x.id,
            part: 'duplicate-region',
            baseValue: [...xSources, ...ySources],
            aValue: x.id,
            bValue: y.id,
            message: '物体 ' + x.id + ' 与 ' + y.id + ' 重复覆盖同一来源区域，歧义保留：请舍弃其一或回去调整拆合关系',
          });
        }
        const duplicateChoice = ctx.resolutions[id];
        if (!duplicateChoice && ctx.strict) throw new Error('来源区域被重复导出：' + x.id + ', ' + y.id);
        if (duplicateChoice === 'adopt-b') removedObjects.add(x.id);
        else if (duplicateChoice === 'adopt-a') removedObjects.add(y.id);
        // discard/disputed 不能消歧：strict 下上面已抛出，预览时两者都保留并提示
      }
    }
  }

  return { objects: finalObjects.filter((o) => !removedObjects.has(o.id)), conflicts: ctx.conflicts };
}

function runMerge(
  base: ImageVersion,
  a: ImageVersion,
  b: ImageVersion,
  resolutions: Record<string, MergeResolution>,
  relationDecisions: Record<string, MergeRelationDecision> = {},
  strict: boolean,
): { objects: AnnotationObject[]; conflicts: MergeConflict[] } {
  const ctx: Ctx = { conflicts: [], resolutions, strict };
  const relations = detectMergeRelations(base, a, b);
  for (const relation of relations) addRelationConflict(ctx, relation, relationDecisions[relation.id]);
  if (relations.length > 0) {
    return runRelationMerge(ctx, base, a, b, relations, relationDecisions);
  }
  return mergeByIds(ctx, base, a, b);
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
  const baseSubmitted = getSubmitted(image, baseVersion);
  const aSubmitted = getSubmitted(image, aVersion);
  const bSubmitted = getSubmitted(image, bVersion);
  const relations = detectMergeRelations(baseSubmitted, aSubmitted, bSubmitted);
  const { conflicts } = runMerge(
    baseSubmitted,
    aSubmitted,
    bSubmitted,
    {},
    {},
    false,
  );
  return { baseVersion, aVersion, bVersion, conflicts, relations };
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

function effectiveResolutions(session: MergeSession, relations: MergeRelation[]): Record<string, MergeResolution> {
  const resolutions = { ...session.resolutions };
  for (const relation of relations) {
    const decision = session.relations?.[relation.id];
    if (!decision) continue;
    resolutions['conflict:' + relation.id] = decision === 'confirmed' ? relation.side : decision;
  }
  return resolutions;
}

/**
 * 落地合并：所有冲突必须已裁决；生成一个新的已提交版本。
 * 物体 id 全部保留，mergeOf 记录基线与两条修订来源；历史版本不被修改。
 */
export function applyMergeSession(image: ImageRecord, session: MergeSession, note?: string): ImageRecord {
  const base = getSubmitted(image, session.baseVersion);
  const a = getSubmitted(image, session.aVersion);
  const b = getSubmitted(image, session.bVersion);
  const normalized = normalizeSession(session);
  const planRelations = detectMergeRelations(base, a, b);
  const effective = effectiveResolutions(normalized, planRelations);
  const { objects, conflicts } = runMerge(base, a, b, effective, normalized.relations, true);
  const unresolved = conflicts.filter((c) => !effective[c.id]);
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
    mergeAudit: {
      relations: Object.entries(normalized.relations).map(([relationId, decision]) => ({
        relationId,
        decision,
        decidedAt: nowIso(),
      })),
      decisions: Object.entries(effective).map(([conflictId, choice]) => ({
        conflictId,
        choice,
        decidedAt: nowIso(),
      })),
    },
    note: note ?? ('合并 v' + session.aVersion + ' 与 v' + session.bVersion + '（基线 v' + session.baseVersion + '）'),
  });
  return next;
}
