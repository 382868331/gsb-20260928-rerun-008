import type {
  AnnotationObject,
  ImageRecord,
  ImageVersion,
  MergeConstraint,
  MergeDecisionSet,
  MergeIncompatibility,
  MergePlanOption,
  MergeRelation,
  MergeSession,
  MergeWithdrawalImpact,
} from '../types';
import { detectMergeRelations, planMerge, resolveMergeBase } from './merge';
import { pointInPolygon, pointOnPolygonBoundary, polygonArea } from './geometry';

function clone<T>(v: T): T {
  return structuredClone(v);
}

function contourCenter(points: { x: number; y: number }[]): { x: number; y: number } {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/** 两个多边形是否共享正面积区域（与关系检测口径一致） */
export function polygonsShareArea(a: { x: number; y: number }[], b: { x: number; y: number }[]): boolean {
  if (polygonArea(a) === 0 || polygonArea(b) === 0) return false;
  const strictlyInside = (p: { x: number; y: number }, poly: { x: number; y: number }[]) =>
    pointInPolygon(p, poly) && !pointOnPolygonBoundary(p, poly);
  const samples = (points: { x: number; y: number }[]) =>
    [contourCenter(points), ...points.flatMap((p, i) => {
      const q = points[(i + 1) % points.length];
      return [{ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, p];
    })];
  return samples(a).some((p) => strictlyInside(p, b)) || samples(b).some((p) => strictlyInside(p, a));
}

function getSubmitted(image: ImageRecord, version: number): ImageVersion {
  const v = image.versions.find((x) => x.version === version && x.status === 'submitted');
  if (!v) throw new Error('图片 ' + image.id + ' 没有已提交版本 v' + version);
  return v;
}

export interface CandidateCoverage {
  sourceId: string;
  objectId: string;
  categoryId: string;
}

export interface PlannedCandidate {
  id: string;
  objectIds: string[];
  coveredSourceIds: string[];
  coverage: CandidateCoverage[];
  relationId: string;
  relationDecision: 'confirmed' | 'rejected' | 'disputed';
  side: 'a' | 'b' | 'base';
  categoryId: string;
  independent: boolean;
  label: string;
}

function structuralObjects(relation: MergeRelation, version: ImageVersion): AnnotationObject[] {
  return relation.targetObjectIds
    .map((id) => version.objects.find((o) => o.id === id))
    .filter((o): o is AnnotationObject => !!o);
}

/** 候选覆盖的基线来源：几何共享区域 + provenance 追溯（连续多代拆合同样成立） */
function coverageOf(
  relation: MergeRelation,
  outputs: AnnotationObject[],
  base: ImageVersion,
  fallbackSourceIds: string[],
): CandidateCoverage[] {
  const provenanceSources = new Set<string>();
  for (const obj of outputs) {
    const seen = new Set<string>();
    const queue = [obj];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (seen.has(cur.id)) continue;
      seen.add(cur.id);
      for (const src of cur.provenance?.sources ?? []) provenanceSources.add(src.objectId);
      const parents = base.objects.filter((o) =>
        cur.provenance?.sources.some((s) => s.objectId === o.id),
      );
      queue.push(...parents);
    }
  }

  const out: CandidateCoverage[] = [];
  for (const baseObj of base.objects) {
    for (const output of outputs) {
      const touches = output.contours.some((oc) =>
        baseObj.contours.some((bc) => polygonsShareArea(oc.points, bc.points)),
      );
      const claimed =
        relation.sourceObjectIds.includes(baseObj.id) ||
        (provenanceSources.size > 0 && provenanceSources.has(baseObj.id));
      if (touches && claimed) {
        out.push({ sourceId: baseObj.id, objectId: output.id, categoryId: output.categoryId });
      }
    }
  }
  // 几何未命中（例如整体孔洞提升）时用关系声明的来源补齐
  for (const sourceId of fallbackSourceIds) {
    if (!out.some((c) => c.sourceId === sourceId)) {
      const owner = outputs[0];
      if (owner) out.push({ sourceId, objectId: owner.id, categoryId: owner.categoryId });
    }
  }
  return out;
}

/** 沿 provenance 收集一个最终物体可追溯到的全部来源 id（三代共同来源） */
export function traceAncestorObjects(obj: AnnotationObject, version: ImageVersion): string[] {
  const found = new Set<string>();
  const queue = [obj];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    for (const src of cur.provenance?.sources ?? []) {
      found.add(src.objectId);
      const parent = version.objects.find((o) => o.id === src.objectId);
      if (parent) queue.push(parent);
    }
  }
  return [...found];
}

export interface PendingDecision {
  id: string;
  kind: 'relation' | 'conflict';
  objectIds: string[];
  dependsOn?: string;
  message: string;
}

export interface MergePlanning {
  baseVersion: number;
  aVersion: number;
  bVersion: number;
  baseSourceIds: string[];
  relations: MergeRelation[];
  candidates: PlannedCandidate[];
  incompatibilities: MergeIncompatibility[];
  options: MergePlanOption[];
  unsatisfiableSets: MergeDecisionSet[];
  conflicts: import('../types').MergeConflict[];
  pending: PendingDecision[];
}

function buildCandidates(
  relations: MergeRelation[],
  base: ImageVersion,
  a: ImageVersion,
  b: ImageVersion,
): PlannedCandidate[] {
  const candidates: PlannedCandidate[] = [];
  for (const relation of relations) {
    const structural = relation.side === 'a' ? a : b;
    const other = relation.side === 'a' ? b : a;
    const targets = structuralObjects(relation, structural);
    if (targets.length > 0) {
      const coverage = coverageOf(relation, targets, base, relation.sourceObjectIds);
      const categories = new Set(coverage.map((c) => c.categoryId));
      candidates.push({
        id: 'candidate:confirm:' + relation.id,
        objectIds: targets.map((t) => t.id),
        coveredSourceIds: [...new Set(coverage.map((c) => c.sourceId))],
        coverage,
        relationId: relation.id,
        relationDecision: 'confirmed',
        side: relation.side,
        independent: false,
        categoryId: categories.size === 1 ? [...categories][0] : '',
        label: '采用修订 ' + relation.side.toUpperCase() + '：' + relation.message,
      });
    }

    // 舍弃关系：每个来源在对侧修订中保留为独立物体
    const retained = relation.sourceObjectIds
      .map((id) => other.objects.find((o) => o.id === id))
      .filter((o): o is AnnotationObject => !!o);
    if (retained.length > 0) {
      const coverage: CandidateCoverage[] = retained.map((o) => ({
        sourceId: o.id,
        objectId: o.id,
        categoryId: o.categoryId,
      }));
      candidates.push({
        id: 'candidate:reject:' + relation.id,
        objectIds: retained.map((o) => o.id),
        coveredSourceIds: retained.map((o) => o.id),
        coverage,
        relationId: relation.id,
        relationDecision: 'rejected',
        side: relation.side === 'a' ? 'b' : 'a',
        independent: false,
        categoryId: new Set(coverage.map((c) => c.categoryId)).size === 1
          ? coverage[0].categoryId
          : '',
        label: '舍弃修订 ' + relation.side.toUpperCase() + ' 的关系，保留原物体（取对侧修订）',
      });
    }
  }

  // 未被任何关系触及的基线物体拥有独立来源，删除不允许：固定保留候选
  const touched = new Set(relations.flatMap((r) => r.sourceObjectIds));
  for (const baseObj of base.objects) {
    if (touched.has(baseObj.id)) continue;
    candidates.push({
      id: 'candidate:independent:' + baseObj.id,
      objectIds: [baseObj.id],
      coveredSourceIds: [baseObj.id],
      coverage: [{ sourceId: baseObj.id, objectId: baseObj.id, categoryId: baseObj.categoryId }],
      relationId: '',
      relationDecision: 'confirmed',
      side: 'base',
      independent: true,
      categoryId: baseObj.categoryId,
      label: '独立来源物体 ' + baseObj.id + '（必须保留）',
    });
  }
  return candidates;
}

function buildIncompatibilities(
  candidates: PlannedCandidate[],
  versions: ImageVersion[],
): MergeIncompatibility[] {
  const out: MergeIncompatibility[] = [];
  const push = (x: PlannedCandidate, y: PlannedCandidate, reason: MergeIncompatibility['reason'], message: string) => {
    const pairKey = [x.id, y.id].sort().join('|');
    if (!out.some((i) => [i.candidateAId, i.candidateBId].sort().join('|') === pairKey && i.reason === reason)) {
      out.push({ candidateAId: x.id, candidateBId: y.id, reason, message });
    }
  };
  const geometryById = new Map<string, { x: number; y: number }[][]>();
  for (const version of versions) {
    for (const obj of version.objects) {
      if (!geometryById.has(obj.id)) geometryById.set(obj.id, obj.contours.map((c) => c.points));
    }
  }
  const outputsOverlap = (idA: string, idB: string): boolean => {
    const pa = geometryById.get(idA);
    const pb = geometryById.get(idB);
    if (!pa || !pb) return true; // 查不到几何时保守视为重叠，避免静默吞掉冲突
    return pa.some((xa) => pb.some((xb) => polygonsShareArea(xa, xb)));
  };
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const x = candidates[i];
      const y = candidates[j];
      if (x.independent || y.independent) continue;
      // 对同一条关系同时确认与舍弃
      if (x.relationId && x.relationId === y.relationId && x.relationDecision !== y.relationDecision) {
        push(x, y, 'relation-conflict', '对同一拆合关系既要采用又要舍弃');
      }
      // 同一来源被两个候选分配到不同最终物体且几何重叠，才是矛盾分配；
      // 共享祖先汇聚到同一物体（连续拆分后交叉合并）合法，不能重复算成两个物体
      const disputed: string[] = [];
      for (const cx of x.coverage) {
        for (const cy of y.coverage) {
          if (cx.sourceId !== cy.sourceId) continue;
          if (cx.objectId === cy.objectId && cx.categoryId === cy.categoryId) continue;
          if (cx.objectId === cy.objectId || outputsOverlap(cx.objectId, cy.objectId)) {
            disputed.push(cx.sourceId);
          }
        }
      }
      if (disputed.length > 0) {
        push(x, y, 'shared-source', '来源 ' + [...new Set(disputed)].join(', ') + ' 被两个候选矛盾地分配到重叠物体');
      }
    }
  }
  return out;
}

interface Evaluation {
  ids: Set<string>;
  uncoveredSourceIds: string[];
  violated: MergeConstraint[];
  satisfied: MergeConstraint[];
  compatible: boolean;
}

function candidateByRelation(candidates: PlannedCandidate[]): Map<string, PlannedCandidate[]> {
  const map = new Map<string, PlannedCandidate[]>();
  for (const c of candidates) {
    if (!c.relationId) continue;
    map.set(c.relationId, [...(map.get(c.relationId) ?? []), c]);
  }
  return map;
}

/** 评估一个候选集合：兼容性、来源覆盖、约束满足 */
function evaluateSelection(
  selected: PlannedCandidate[],
  candidates: PlannedCandidate[],
  incompatibilities: MergeIncompatibility[],
  baseSourceIds: string[],
  constraints: MergeConstraint[],
): Evaluation {
  const ids = new Set(selected.map((c) => c.id));
  const covered = new Set<string>();
  for (const c of selected) for (const id of c.coveredSourceIds) covered.add(id);
  const uncoveredSourceIds = baseSourceIds.filter((id) => !covered.has(id));

  const incompatible = incompatibilities.some((inc) => ids.has(inc.candidateAId) && ids.has(inc.candidateBId));

  const coveringsOf = (sourceId: string) => selected.filter((c) => c.coveredSourceIds.includes(sourceId));
  const satisfied: MergeConstraint[] = [];
  const violated: MergeConstraint[] = [];
  for (const constraint of constraints) {
    const relevant = constraint.sourceObjectIds.filter((id) => baseSourceIds.includes(id));
    if (relevant.length === 0) continue;
    let ok = true;
    if (constraint.kind === 'category') {
      ok = relevant.every((sourceId) =>
        coveringsOf(sourceId).every((c) =>
          c.coverage.some((cov) => cov.sourceId === sourceId && cov.categoryId === constraint.categoryId),
        ),
      );
    } else {
      // 分组约束：整组来源必须共同汇聚到同一个最终物体
      // （舍弃合并的保留候选虽同属一个候选，实际仍是独立物体，不满足分组）
      ok = candidates.some(
        (c) =>
          ids.has(c.id) &&
          c.objectIds.some((objectId) =>
            relevant.every((sourceId) =>
              c.coverage.some((cov) => cov.sourceId === sourceId && cov.objectId === objectId),
            ),
          ),
      );
    }
    if (ok && uncoveredSourceIds.length === 0 && !incompatible) satisfied.push(constraint);
    else violated.push(constraint);
  }
  return { ids, uncoveredSourceIds, violated, satisfied, compatible: !incompatible };
}

function enumerateSelections(
  candidates: PlannedCandidate[],
): PlannedCandidate[][] {
  const groups = [...candidateByRelation(candidates).values()];
  const independents = candidates.filter((c) => c.independent);
  let results: PlannedCandidate[][] = [independents];
  for (const group of groups) {
    const next: PlannedCandidate[][] = [];
    for (const acc of results) {
      next.push(acc); // 该关系暂不决定
      for (const choice of group) next.push([...acc, choice]);
    }
    results = next;
  }
  return results;
}

/** 计算采用某方案后仍需裁决的冲突：被舍弃关系上的片段冲突随关系消失 */
function remainingConflicts(
  conflicts: import('../types').MergeConflict[],
  selected: PlannedCandidate[],
): import('../types').MergeConflict[] {
  const rejectedRelations = new Set(
    selected.filter((c) => c.relationDecision === 'rejected').map((c) => c.relationId),
  );
  return conflicts.filter((conflict) => {
    if (conflict.id.startsWith('conflict:relation:')) {
      return !rejectedRelations.has(conflict.id.slice('conflict:'.length));
    }
    if (conflict.dependsOn && rejectedRelations.has(conflict.dependsOn)) return false;
    return true;
  });
}

function relationDecisionOf(session: MergeSession, relationId: string) {
  return session.relations?.[relationId];
}

function buildOptions(
  candidates: PlannedCandidate[],
  incompatibilities: MergeIncompatibility[],
  baseSourceIds: string[],
  constraints: MergeConstraint[],
  allConflicts: import('../types').MergeConflict[],
  session: MergeSession | undefined,
): MergePlanOption[] {
  const options: MergePlanOption[] = [];
  const seen = new Set<string>();
  for (const selection of enumerateSelections(candidates)) {
    const evaluation = evaluateSelection(selection, candidates, incompatibilities, baseSourceIds, constraints);
    const key = [...evaluation.ids].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const candidateIds = [...evaluation.ids];
    const remaining = remainingConflicts(allConflicts, selection);
    const conflictingDecisionIds: string[] = [];
    let additional = 0;
    if (session) {
      for (const c of selection) {
        if (!c.relationId) continue;
        const current = relationDecisionOf(session, c.relationId);
        if (!current) additional += 1;
        else if (current !== c.relationDecision) conflictingDecisionIds.push(c.relationId);
      }
      // 已裁决但本方案不再需要的片段决定也算冲突，需要撤回
      const selectedRelationIds = new Set(selection.map((c) => c.relationId).filter(Boolean));
      for (const conflictId of Object.keys(session.resolutions)) {
        const conflict = allConflicts.find((x) => x.id === conflictId);
        if (conflict?.dependsOn && !selectedRelationIds.has(conflict.dependsOn)) {
          conflictingDecisionIds.push(conflictId);
        }
      }
    }
    options.push({
      id: key ? 'option:' + key : 'option:empty',
      candidateIds,
      complete: evaluation.compatible && evaluation.uncoveredSourceIds.length === 0,
      uncoveredSourceIds: evaluation.uncoveredSourceIds,
      satisfiedConstraintIds: evaluation.satisfied.map((c) => c.id),
      violatedConstraintIds: evaluation.violated.map((c) => c.id),
      remainingConflictCount: remaining.length,
      additionalDecisionCount: additional,
      conflictingDecisionIds,
      summary:
        '保留 ' + selection.length + ' 个候选、覆盖 ' +
        (baseSourceIds.length - evaluation.uncoveredSourceIds.length) + '/' + baseSourceIds.length +
        ' 个来源、剩余 ' + remaining.length + ' 处待裁决冲突' +
        (evaluation.violated.length > 0 ? '、违反 ' + evaluation.violated.length + ' 条约束' : ''),
    });
  }
  return options.sort((x, y) => {
    if (x.complete !== y.complete) return x.complete ? -1 : 1;
    if (x.violatedConstraintIds.length !== y.violatedConstraintIds.length) {
      return x.violatedConstraintIds.length - y.violatedConstraintIds.length;
    }
    if (x.remainingConflictCount !== y.remainingConflictCount) {
      return x.remainingConflictCount - y.remainingConflictCount;
    }
    if (x.additionalDecisionCount !== y.additionalDecisionCount) {
      return x.additionalDecisionCount - y.additionalDecisionCount;
    }
    return x.candidateIds.length - y.candidateIds.length;
  });
}

/** 找出无法同时满足的最小集合：互斥候选对、约束的最小不可满足核、已有决定间冲突 */
function buildUnsatisfiableSets(
  candidates: PlannedCandidate[],
  incompatibilities: MergeIncompatibility[],
  baseSourceIds: string[],
  constraints: MergeConstraint[],
  options: MergePlanOption[],
  session: MergeSession | undefined,
): MergeDecisionSet[] {
  const sets: MergeDecisionSet[] = [];

  for (const inc of incompatibilities) {
    sets.push({
      memberIds: [inc.candidateAId, inc.candidateBId],
      kind: 'candidate-conflict',
      message: inc.message,
    });
  }

  // 约束最小不可满足核：子集内每条约束都必不可少（去掉任一条即可满足其余）
  const satisfiedBy = (subset: MergeConstraint[]): boolean =>
    options.some(
      (opt) =>
        opt.complete && subset.every((c) => opt.satisfiedConstraintIds.includes(c.id)),
    );
  const relevant = constraints.filter((c) => c.sourceObjectIds.some((id) => baseSourceIds.includes(id)));
  const reported = new Set<string>();
  for (let size = 1; size <= relevant.length; size++) {
    const combos = combinations(relevant, size);
    for (const subset of combos) {
      if (satisfiedBy(subset)) continue;
      const minimal = subset.every((c) => satisfiedBy(subset.filter((x) => x.id !== c.id)));
      if (!minimal) continue;
      const key = subset.map((c) => c.id).sort().join('|');
      if (reported.has(key)) continue;
      reported.add(key);
      sets.push({
        memberIds: subset.map((c) => c.id),
        kind: 'constraint-unsatisfiable',
        message:
          size === 1
            ? '约束「' + constraintLabel(subset[0]) + '」在任何来源分配方案下都无法满足'
            : '约束「' + subset.map(constraintLabel).join('」与「') + '」无法同时满足',
      });
    }
  }

  // 已裁决决定之间的冲突：两个已确认关系的结构候选互斥（同一来源被矛盾分配）
  if (session) {
    const confirmedRelations = Object.entries(session.relations ?? {})
      .filter(([, decision]) => decision === 'confirmed')
      .map(([id]) => id);
    for (let i = 0; i < confirmedRelations.length; i++) {
      for (let j = i + 1; j < confirmedRelations.length; j++) {
        const ca = candidates.find((c) => c.relationId === confirmedRelations[i] && c.relationDecision === 'confirmed');
        const cb = candidates.find((c) => c.relationId === confirmedRelations[j] && c.relationDecision === 'confirmed');
        if (!ca || !cb) continue;
        if (incompatibilities.some(
          (inc) =>
            (inc.candidateAId === ca.id && inc.candidateBId === cb.id) ||
            (inc.candidateAId === cb.id && inc.candidateBId === ca.id),
        )) {
          sets.push({
            memberIds: [confirmedRelations[i], confirmedRelations[j]],
            kind: 'decision-conflict',
            message: '已确认的两条拆合关系重复分配同一来源，必须撤回其一',
          });
        }
      }
    }
  }
  return sets;
}

function constraintLabel(constraint: MergeConstraint): string {
  if (constraint.kind === 'category') {
    return '来源 ' + constraint.sourceObjectIds.join(', ') + ' 必须保留指定类别';
  }
  return '来源 ' + constraint.sourceObjectIds.join(', ') + ' 必须同组（分组 ' + constraint.groupId + '）';
}

function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [head, ...rest] = items;
  return [
    ...combinations(rest, size - 1).map((combo) => [head, ...combo]),
    ...combinations(rest, size),
  ];
}

function buildPending(
  conflicts: import('../types').MergeConflict[],
  session: MergeSession | undefined,
): PendingDecision[] {
  const pending: PendingDecision[] = [];
  for (const conflict of conflicts) {
    const isRelation = conflict.id.startsWith('conflict:relation:');
    const relationId = isRelation ? conflict.id.slice('conflict:'.length) : conflict.dependsOn;
    if (relationId) {
      const decision = session?.relations?.[relationId];
      if (!decision || decision === 'disputed') {
        pending.push({
          id: conflict.id,
          kind: 'relation',
          objectIds: [conflict.objectId],
          message: conflict.message,
        });
        continue;
      }
      if (decision === 'rejected') continue;
      // 关系已确认：片段冲突进入待决闭合范围
      if (!isRelation && !session?.resolutions[conflict.id]) {
        pending.push({
          id: conflict.id,
          kind: 'conflict',
          objectIds: [conflict.objectId],
          dependsOn: relationId,
          message: conflict.message,
        });
      }
      continue;
    }
    if (!session?.resolutions[conflict.id]) {
      pending.push({
        id: conflict.id,
        kind: 'conflict',
        objectIds: [conflict.objectId],
        message: conflict.message,
      });
    }
  }
  return pending;
}

/**
 * 生成多分支来源的最小冲突合并规划：
 * 沿拆分/合并来源枚举可共同采用的候选，比较方案完整度、约束违反与剩余冲突。
 */
export function buildMergePlanning(
  image: ImageRecord,
  aVersion: number,
  bVersion: number,
  constraints: MergeConstraint[] = [],
  session?: MergeSession,
): MergePlanning {
  const baseVersion = resolveMergeBase(image, aVersion, bVersion);
  const base = getSubmitted(image, baseVersion);
  const a = getSubmitted(image, aVersion);
  const b = getSubmitted(image, bVersion);
  const relations = detectMergeRelations(base, a, b);
  const candidates = buildCandidates(relations, base, a, b);
  const incompatibilities = buildIncompatibilities(candidates, [base, a, b]);
  const baseSourceIds = base.objects.map((o) => o.id);
  const allConflicts = planMerge(image, aVersion, bVersion).conflicts;
  const options = buildOptions(candidates, incompatibilities, baseSourceIds, constraints, allConflicts, session);
  const unsatisfiableSets = buildUnsatisfiableSets(
    candidates,
    incompatibilities,
    baseSourceIds,
    constraints,
    options,
    session,
  );
  const pending = buildPending(allConflicts, session);
  return {
    baseVersion,
    aVersion,
    bVersion,
    baseSourceIds,
    relations,
    candidates,
    incompatibilities,
    options,
    unsatisfiableSets,
    conflicts: allConflicts,
    pending,
  };
}

/**
 * 批准一份方案（或其中一部分候选）：写入关系决定并完成依赖闭合——
 * 结构候选确认后，其片段级冲突默认采用结构侧结果，仍允许用户逐项改选。
 * 与方案冲突的既有决定会被撤回；不触碰批准范围外的决定。
 */
export function applyPlanningOption(
  session: MergeSession,
  planning: MergePlanning,
  optionOrCandidateIds: MergePlanOption | string[],
): MergeSession {
  const ids = Array.isArray(optionOrCandidateIds)
    ? optionOrCandidateIds
    : optionOrCandidateIds.candidateIds;
  const next = clone(session);
  next.relations = { ...(next.relations ?? {}) };
  next.resolutions = { ...(next.resolutions ?? {}) };
  const chosen = planning.candidates.filter((c) => ids.includes(c.id));
  const chosenRelations = new Map<string, PlannedCandidate>();
  for (const candidate of chosen) {
    if (!candidate.relationId) continue;
    chosenRelations.set(candidate.relationId, candidate);
  }

  // 先撤回与本次批准矛盾的关系决定及其片段闭合决定
  for (const [relationId, candidate] of chosenRelations) {
    if (next.relations[relationId] && next.relations[relationId] !== candidate.relationDecision) {
      delete next.relations[relationId];
      for (const conflict of planning.pending) {
        if (conflict.dependsOn === relationId) delete next.resolutions[conflict.id];
      }
    }
  }
  for (const [relationId, candidate] of chosenRelations) {
    next.relations[relationId] = candidate.relationDecision;
  }

  // 依赖闭合：确认的关系上，未决片段冲突默认采用结构侧（关系来自 A 则保留 A 目标）
  for (const [relationId, candidate] of chosenRelations) {
    if (candidate.relationDecision !== 'confirmed') {
      for (const conflict of planning.conflicts) {
        if (conflict.dependsOn === relationId) delete next.resolutions[conflict.id];
      }
      continue;
    }
    for (const conflict of planning.conflicts) {
      if (conflict.dependsOn !== relationId) continue;
      if (!next.resolutions[conflict.id]) {
        next.resolutions[conflict.id] = candidate.side === 'a' ? 'adopt-a' : 'adopt-b';
      }
    }
  }
  next.updatedAt = new Date().toISOString();
  return next;
}

/**
 * 撤回一项决定并计算影响：撤回关系会重开依赖它的片段闭合决定，
 * 并使对应候选与最终物体退回未决；撤回片段决定只影响该物体。
 */
export function withdrawDecision(
  session: MergeSession,
  planning: MergePlanning,
  decisionId: string,
): { session: MergeSession; impact: MergeWithdrawalImpact } {
  const next = clone(session);
  next.relations = { ...(next.relations ?? {}) };
  next.resolutions = { ...(next.resolutions ?? {}) };
  const reopened: string[] = [];
  const affectedObjectIds = new Set<string>();
  const affectedCandidateIds = new Set<string>();

  const isRelation =
    decisionId.startsWith('relation:') || !!planning.relations.find((r) => r.id === decisionId);
  if (isRelation) {
    const relationId = decisionId.startsWith('relation:') ? decisionId : decisionId;
    delete next.relations[relationId];
    delete next.resolutions['conflict:' + relationId];
    for (const pending of planning.pending) {
      if (pending.dependsOn === relationId) reopened.push(pending.id);
    }
    for (const conflictId of Object.keys(next.resolutions)) {
      const pending = planning.pending.find((p) => p.id === conflictId && p.dependsOn === relationId);
      if (pending) {
        delete next.resolutions[conflictId];
        reopened.push(conflictId);
      }
    }
    for (const candidate of planning.candidates.filter((c) => c.relationId === relationId)) {
      affectedCandidateIds.add(candidate.id);
      candidate.objectIds.forEach((id) => affectedObjectIds.add(id));
      candidate.coveredSourceIds.forEach((id) => affectedObjectIds.add(id));
    }
  } else {
    delete next.resolutions[decisionId];
    const pending = planning.pending.find((p) => p.id === decisionId);
    (pending?.objectIds ?? [decisionId]).forEach((id) => affectedObjectIds.add(id));
    for (const candidate of planning.candidates) {
      if (candidate.objectIds.some((id) => affectedObjectIds.has(id))) affectedCandidateIds.add(candidate.id);
    }
  }
  next.updatedAt = new Date().toISOString();
  return {
    session: next,
    impact: {
      withdrawnId: decisionId,
      reopenedDecisionIds: [...new Set(reopened)],
      affectedObjectIds: [...affectedObjectIds],
      affectedCandidateIds: [...affectedCandidateIds],
    },
  };
}
