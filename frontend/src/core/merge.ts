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

function objectContours(obj: AnnotationObject | undefined): { contour: Contour; object: AnnotationObject }[] {
  return (obj?.contours ?? []).map((contour) => ({ contour, object: obj! }));
}

function contourOverlapsObject(contour: Contour, obj: AnnotationObject): boolean {
  return obj.contours.some((other) => polygonsShareArea(contour.points, other.points));
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

function detectSideRelations(side: 'a' | 'b', base: ImageVersion, revised: ImageVersion): MergeRelation[] {
  const revisedById = new Map(revised.objects.map((o) => [o.id, o]));
  const out: MergeRelation[] = [];

  for (const source of base.objects) {
    const targets = revised.objects.filter((target) =>
      target.contours.some((tc) => source.contours.some((sc) => polygonsShareArea(tc.points, sc.points))),
    );
    const newTargets = targets.filter((t) => !base.objects.some((b) => b.id === t.id));
    if (newTargets.length > 1) {
      const id = 'relation:split:' + side + ':' + source.id + ':' + relationKey(newTargets.map((t) => t.id));
      if (!out.some((r) => r.id === id)) {
        out.push({
          id,
          kind: 'split',
          side,
          sourceObjectIds: [source.id],
          targetObjectIds: newTargets.map((t) => t.id),
          message: '修订 ' + side.toUpperCase() + ' 将物体 ' + source.id + ' 拆分为 ' + newTargets.length + ' 个物体',
        });
      }
    }

    for (const sc of source.contours) {
      for (const hole of sc.holes) {
        const promoted = revised.objects.filter((obj) =>
          obj.contours.some((c) =>
            obj.id !== source.id &&
              polygonsShareArea(c.points, hole.points) &&
              polygonArea(c.points) <= polygonArea(hole.points) * 3,
          ),
        );
        if (promoted.length > 0) {
          out.push({
            id: 'relation:hole-promotion:' + side + ':' + source.id + ':' + sc.id + ':' + hole.id,
            kind: 'hole-to-outline',
            side,
            sourceObjectIds: [source.id],
            sourceContourIds: [sc.id],
            sourceHoleIds: [hole.id],
            targetObjectIds: promoted.map((o) => o.id),
            message: '修订 ' + side.toUpperCase() + ' 将物体 ' + source.id + ' 的孔洞 ' + hole.id + ' 用作外轮廓，需要明确确认',
          });
        }
      }
    }
  }

  for (const target of revised.objects) {
    if (base.objects.some((o) => o.id === target.id)) continue;
    const sources = base.objects.filter((source) => contourOverlapsObject(target.contours[0], source));
    if (sources.length > 1) {
      out.push({
        id: 'relation:merge:' + side + ':' + relationKey(sources.map((s) => s.id)) + ':' + target.id,
        kind: 'merge',
        side,
        sourceObjectIds: sources.map((s) => s.id),
        targetObjectIds: [target.id],
        message: '修订 ' + side.toUpperCase() + ' 将 ' + sources.length + ' 个物体合并为 ' + target.id,
      });
    }
  }

  return out.filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i);
}

export function detectMergeRelations(base: ImageVersion, a: ImageVersion, b: ImageVersion): MergeRelation[] {
  return [...detectSideRelations('a', base, a), ...detectSideRelations('b', base, b)];
}

function normalizeSession(session: MergeSession): MergeSession {
  return { ...session, resolutions: { ...session.resolutions }, relations: { ...(session.relations ?? {}) } };
}

function provenanceSources(relation: MergeRelation): RegionSource[] {
  return relation.sourceObjectIds.map((objectId) => {
    const source: RegionSource = { objectId };
    source.contourId = relation.sourceContourIds?.[0];
    source.holeId = relation.sourceHoleIds?.[0];
    return source;
  });
}

function addRelationConflict(ctx: Ctx, relation: MergeRelation, decision: MergeRelationDecision | undefined): void {
  const id = 'conflict:' + relation.id;
  const conflict: MergeConflict = {
    id,
    objectId: relation.targetObjectIds[0] ?? relation.sourceObjectIds[0],
    part: relation.kind === 'split' ? 'split-relation' : relation.kind === 'merge' ? 'merge-relation' : 'hole-promotion',
    sources: provenanceSources(relation),
    baseValue: relation.sourceObjectIds.join(', '),
    aValue: relation.side === 'a' ? relation.targetObjectIds.join(', ') : null,
    bValue: relation.side === 'b' ? relation.targetObjectIds.join(', ') : null,
    message: relation.message,
  };
  if (!ctx.conflicts.some((c) => c.id === id)) ctx.conflicts.push(conflict);
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

function sourceContours(base: ImageVersion, sourceIds: string[]) {
  return base.objects.filter((o) => sourceIds.includes(o.id)).flatMap(objectContours);
}

function holesInsideTarget(target: AnnotationObject, sourceHoles: { contour: Contour; hole: Contour['holes'][number]; sourceObjectId: string }[]) {
  return sourceHoles.filter((entry) =>
    target.contours.some((tc) => entry.hole.points.every((p) => pointInPolygon(p, tc.points))),
  );
}

function attachProvenance(obj: AnnotationObject, relation: MergeRelation, base: ImageVersion): AnnotationObject {
  const next = finalizeObject(obj);
  const sources: RegionSource[] = [];
  const baseObjectsById = new Map(base.objects.map((sourceObj) => [sourceObj.id, sourceObj]));
  for (const sourceId of relation.sourceObjectIds) {
    const sourceContours = baseObjectsById.get(sourceId)?.contours ?? [];
    for (const sourceContour of sourceContours) {
      if (obj.contours.some((targetContour) => polygonsShareArea(targetContour.points, sourceContour.points))) {
        sources.push({ objectId: sourceId, contourId: sourceContour.id, holeId: relation.sourceHoleIds?.[0] });
      }
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

function carrySourceHoles(obj: AnnotationObject, base: ImageVersion, relation: MergeRelation): AnnotationObject {
  for (const contour of obj.contours) {
    for (const sourceId of relation.sourceObjectIds) {
      const sourceObj = base.objects.find((o) => o.id === sourceId);
      for (const sourceContour of sourceObj?.contours ?? []) {
        for (const hole of sourceContour.holes) {
          const inside = hole.points.every((p) => pointInPolygon(p, contour.points));
          const already = contour.holes.some((existing) => existing.id === hole.id || eq(existing.points, hole.points));
          if (inside && !already) contour.holes.push({ ...clone(hole), sourceHoleId: hole.id });
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
  base: ImageVersion,
  a: ImageVersion,
  b: ImageVersion,
): void {
  const structuralVersion = relation.side === 'a' ? a : b;
  const otherVersion = relation.side === 'a' ? b : a;
  for (const sourceId of relation.sourceObjectIds) {
    const baseObj = base.objects.find((o) => o.id === sourceId);
    const otherObj = otherVersion.objects.find((o) => o.id === sourceId);
    if (!baseObj || !otherObj) continue;
    const applicableTargets = targets.filter((t) =>
      t.contours.some((tc) => {
        const center = contourCenter(tc.points);
        return baseObj.contours.some((sc) => pointInPolygon(center, sc.points));
      }),
    );
    for (const target of applicableTargets) {
      if (otherObj.categoryId !== baseObj.categoryId) {
        const id = 'category-source:' + relation.id + ':' + sourceId + ':' + target.id;
        const conflict: MergeConflict = {
          id,
          objectId: target.id,
          part: 'category',
          dependsOn: relation.id,
          sources: [{ objectId: sourceId }],
          baseValue: baseObj.categoryId,
          aValue: relation.side === 'a' ? target.categoryId : otherObj.categoryId,
          bValue: relation.side === 'b' ? target.categoryId : otherObj.categoryId,
          message: '来源物体 ' + sourceId + ' 的类别修改对应拆分/合并后的物体 ' + target.id,
        };
        ctx.conflicts.push(conflict);
        const decision = ctx.resolutions[id];
        if (!decision && ctx.strict) throw new Error('片段冲突未确认：' + conflict.message);
        if (decision === 'disputed' && ctx.strict) throw new Error('片段冲突仍有争议：' + conflict.message);
        const adoptOther = decision === (relation.side === 'a' ? 'adopt-b' : 'adopt-a');
        if (adoptOther) target.categoryId = otherObj.categoryId;
      }

      const sourceHoles = baseObj.contours.flatMap((sc) =>
        sc.holes.map((hole) => ({ contour: sc, hole, sourceObjectId: sourceId })),
      );
      const targetHoles = holesInsideTarget(target, sourceHoles);
      for (const entry of targetHoles) {
        const otherHole = otherVersion.objects
          .find((o) => o.id === sourceId)?.contours
          .find((c) => c.id === entry.contour.id)?.holes
          .find((h) => h.id === entry.hole.id);
        const targetHole = target.contours
          .flatMap((c) => c.holes)
          .find((h) => h.id === entry.hole.id || h.points.some((p) => pointInPolygon(p, entry.hole.points)));
        const structuralPoints = targetHole?.points ?? DELETED;
        const otherPoints = otherHole?.points ?? DELETED;
        if (otherHole && !eq(otherHole.points, entry.hole.points) && !eq(structuralPoints, otherPoints)) {
          const id = 'hole-source:' + relation.id + ':' + sourceId + ':' + target.id + ':' + entry.hole.id;
          const conflict: MergeConflict = {
            id,
            objectId: target.id,
            part: 'hole',
            contourId: entry.contour.id,
            holeId: entry.hole.id,
            dependsOn: relation.id,
            sources: [{ objectId: sourceId, contourId: entry.contour.id, holeId: entry.hole.id }],
            baseValue: entry.hole.points,
            aValue: relation.side === 'a' ? structuralPoints : otherPoints,
            bValue: relation.side === 'b' ? structuralPoints : otherPoints,
            message: '来源物体 ' + sourceId + ' 的孔洞修改对应拆分/合并后的物体 ' + target.id,
          };
          ctx.conflicts.push(conflict);
          const decision = ctx.resolutions[id];
          if (!decision && ctx.strict) throw new Error('片段冲突未确认：' + conflict.message);
          if (decision === 'disputed' && ctx.strict) throw new Error('片段冲突仍有争议：' + conflict.message);
          const adoptOther = decision === (relation.side === 'a' ? 'adopt-b' : 'adopt-a');
          if (adoptOther) {
            for (const c of target.contours) {
              const idx = c.holes.findIndex((h) => h.id === entry.hole.id);
              if (idx >= 0) c.holes[idx] = { ...otherHole, sourceHoleId: entry.hole.id };
            }
          }
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
  const handled = new Set<string>();
  const provisionalTargets = new Map<string, AnnotationObject[]>();

  for (const relation of relations) {
    if (relationDecisions[relation.id] === 'rejected') continue;
    const structuralVersion = relation.side === 'a' ? a : b;
    const targets = relation.targetObjectIds
      .map((id) => structuralVersion.objects.find((o) => o.id === id))
      .filter((o): o is AnnotationObject => !!o)
      .map((o) => carrySourceHoles(attachProvenance(o, relation, base), base, relation));
    provisionalTargets.set(relation.id, targets);
    addSourceLevelConflicts(ctx, relation, targets, base, a, b);
  }

  for (const relation of relations) {
    const decision = relationDecisions[relation.id];
    if (decision === 'disputed' && ctx.strict) throw new Error('拆合关系仍有争议：' + relation.message);
    if (!decision && ctx.strict) throw new Error('拆合关系未确认：' + relation.message);
    if (decision === 'rejected') {
      const keepVersion = relation.side === 'a' ? b : a;
      for (const sourceId of relation.sourceObjectIds) {
        const kept = keepVersion.objects.find((o) => o.id === sourceId);
        if (kept) outputs.set(sourceId, finalizeObject(kept));
      }
      for (const targetId of relation.targetObjectIds) outputs.delete(targetId);
      continue;
    }
    if (decision !== 'confirmed') continue;

    const targets = provisionalTargets.get(relation.id) ?? [];
    for (const id of [...relation.sourceObjectIds, ...relation.targetObjectIds]) {
      handled.add(id);
      outputs.delete(id);
    }
    for (const target of targets) outputs.set(target.id, target);
  }

  const finalObjects = [...outputs.values()];
  const removedObjects = new Set<string>();
  for (let i = 0; i < finalObjects.length; i++) {
    for (let j = i + 1; j < finalObjects.length; j++) {
      const x = finalObjects[i];
      const y = finalObjects[j];
      const sharedSource = (x.provenance?.sources ?? []).some((sx) =>
        y.provenance?.sources.some((sy) => sy.objectId === sx.objectId),
      );
      const overlaps = x.contours.some((cx) => y.contours.some((cy) => polygonsShareArea(cx.points, cy.points)));
      if (sharedSource && overlaps) {
        const id = 'duplicate-region:' + [x.id, y.id].sort().join(':');
        ctx.conflicts.push({
          id,
          objectId: x.id,
          part: 'duplicate-region',
          baseValue: x.provenance?.sources ?? [],
          aValue: x.id,
          bValue: y.id,
          message: '物体 ' + x.id + ' 与 ' + y.id + ' 重复覆盖同一来源区域，需要调整拆分或舍弃其一',
        });
        const duplicateChoice = ctx.resolutions[id];
        if (!duplicateChoice && ctx.strict) throw new Error('来源区域被重复导出：' + x.id + ', ' + y.id);
        if (duplicateChoice === 'adopt-b') removedObjects.add(x.id);
        else if (duplicateChoice) removedObjects.add(y.id);
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
