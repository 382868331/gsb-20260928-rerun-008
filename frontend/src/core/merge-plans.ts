import type {
  AnnotationObject,
  ImageRecord,
  IncompatibleDecisionSet,
  MergeConflict,
  MergeConstraint,
  MergePlanComparison,
  MergePlanOption,
  MergeRelation,
  MergeRelationDecision,
  MergeSession,
  RegionSource,
} from '../types';
import { polygonsShareArea, simulateMerge } from './merge';

/**
 * 多分支物体来源的最小冲突合并规划。
 *
 * 用户对部分物体指定必须保留的类别/分组约束后，系统沿拆分、合并来源
 * 枚举每条拆合关系的 确认/舍弃 组合，逐一试算最终物体：
 * - 共享祖先不能被重复算成两个独立物体（duplicate-region 即矛盾分配）；
 * - 不能为消除冲突删除仍有独立来源的对象（被舍弃关系的目标若不被任何
 *   最终物体覆盖，该方案不可行）；
 * - 违反用户约束的方案标记为不可行。
 * 可行方案按待裁决冲突数排序（最小冲突优先），同时给出无法同时满足的
 * 决定集合，用户只批准其中一份或一部分依赖闭合范围。
 */

function sourcesOf(obj: AnnotationObject): RegionSource[] {
  return obj.provenance?.sources ?? [{ objectId: obj.id }];
}

function coverageMap(objects: AnnotationObject[]): Map<string, AnnotationObject> {
  const covered = new Map<string, AnnotationObject>();
  for (const obj of objects) {
    covered.set(obj.id, obj);
    for (const source of sourcesOf(obj)) {
      if (!covered.has(source.objectId)) covered.set(source.objectId, obj);
    }
  }
  return covered;
}

function constraintLabel(constraint: MergeConstraint): string {
  if (constraint.note) return constraint.note;
  const targets = constraint.objectIds.join(', ');
  return constraint.kind === 'keep-category'
    ? '物体 ' + targets + ' 必须保留类别 ' + (constraint.categoryId ?? '?')
    : '物体 ' + targets + ' 必须保持在同一组';
}

function checkConstraints(
  constraints: MergeConstraint[],
  objects: AnnotationObject[],
  pendingConflicts: MergeConflict[],
): string[] {
  const covered = coverageMap(objects);
  const violations: string[] = [];
  for (const constraint of constraints) {
    const label = constraintLabel(constraint);
    const targets = constraint.objectIds.map((id) => covered.get(id));
    if (constraint.kind === 'keep-category') {
      for (let i = 0; i < constraint.objectIds.length; i++) {
        const target = targets[i];
        if (!target) {
          violations.push(label + '：物体 ' + constraint.objectIds[i] + ' 在该方案中消失');
        } else if (target.categoryId !== constraint.categoryId) {
          // 预览取的是未裁决值；若存在可裁决到目标类别的待决冲突，则仍可满足
          const satisfiable = pendingConflicts.some(
            (c) =>
              c.part === 'category' &&
              c.objectId === target.id &&
              (c.aValue === constraint.categoryId || c.bValue === constraint.categoryId),
          );
          if (!satisfiable) {
            violations.push(
              label + '：物体 ' + constraint.objectIds[i] + ' 最终类别为 ' + target.categoryId,
            );
          }
        }
      }
    } else {
      // 同一来源可能沿拆分进入多个最终物体：取每个物体id的全部覆盖者，
      // 存在共同覆盖者即仍同组
      const coveringSets = constraint.objectIds.map((oid) =>
        objects.filter(
          (o) => o.id === oid || sourcesOf(o).some((s) => s.objectId === oid),
        ),
      );
      if (coveringSets.some((set) => set.length === 0)) {
        const missing = constraint.objectIds.filter((_, i) => coveringSets[i].length === 0);
        violations.push(label + '：物体 ' + missing.join(', ') + ' 在该方案中消失');
      } else {
        const common = coveringSets.reduce((acc, set) =>
          acc.filter((o) => set.some((x) => x.id === o.id)),
        );
        if (common.length === 0) {
        violations.push(label + '：这些物体在该方案中被分到了不同物体');
        }
      }
    }
  }
  return violations;
}

/** 被舍弃/未采纳关系涉及、且仍存在于任一修订中的物体，必须仍被最终物体覆盖 */
function checkDroppedIndependent(
  relations: MergeRelation[],
  aObjects: AnnotationObject[],
  bObjects: AnnotationObject[],
  finalObjects: AnnotationObject[],
): string[] {
  const covered = coverageMap(finalObjects);
  const revisedIds = new Set([...aObjects, ...bObjects].map((o) => o.id));
  const dropped: string[] = [];
  const involved = new Set<string>();
  for (const relation of relations) {
    for (const id of [...relation.sourceObjectIds, ...relation.targetObjectIds]) involved.add(id);
  }
  for (const id of involved) {
    if (!revisedIds.has(id) || covered.has(id)) continue;
    const revised = [...aObjects, ...bObjects].find((o) => o.id === id)!;
    const overlapsFinal = revised.contours.some((c) =>
      finalObjects.some((fo) => fo.contours.some((fc) => polygonsShareArea(c.points, fc.points))),
    );
    if (!overlapsFinal) {
      dropped.push('物体 ' + id + ' 仍有独立来源，却不能为消除冲突被删除');
    }
  }
  return dropped;
}

interface ComboEval {
  decisions: Record<string, MergeRelationDecision>;
  option: MergePlanOption;
}

function evaluateCombo(
  image: ImageRecord,
  aVersion: number,
  bVersion: number,
  relations: MergeRelation[],
  decisions: Record<string, MergeRelationDecision>,
  constraints: MergeConstraint[],
  aObjects: AnnotationObject[],
  bObjects: AnnotationObject[],
): ComboEval {
  const { objects, conflicts } = simulateMerge(image, aVersion, bVersion, decisions);
  const pendingConflicts = conflicts.filter((c) => !c.id.startsWith('conflict:relation:'));
  const duplicateSources = conflicts
    .filter((c) => c.part === 'duplicate-region')
    .map((c) => c.message);
  const violations = checkConstraints(constraints, objects, pendingConflicts);
  const droppedIndependent = checkDroppedIndependent(relations, aObjects, bObjects, objects);
  const feasible =
    violations.length === 0 && duplicateSources.length === 0 && droppedIndependent.length === 0;
  const key = relations
    .map((r) => r.id + '=' + decisions[r.id])
    .sort()
    .join('|');
  return {
    decisions,
    option: {
      id: 'plan:' + (key || 'no-relations'),
      label: '',
      relationDecisions: decisions,
      pendingConflicts,
      finalObjects: objects.map((o) => ({
        id: o.id,
        categoryId: o.categoryId,
        sources: sourcesOf(o),
      })),
      violations,
      duplicateSources,
      droppedIndependent,
      feasible,
    },
  };
}

function decisionFeasible(evaluations: ComboEval[], relationId: string, decision: MergeRelationDecision): boolean {
  return evaluations.some((e) => e.decisions[relationId] === decision && e.option.feasible);
}

function bestMessages(evaluations: ComboEval[], match: (e: ComboEval) => boolean): string {
  const candidates = evaluations.filter(match);
  if (candidates.length === 0) return '组合不可行';
  candidates.sort(
    (x, y) =>
      x.option.violations.length + x.option.duplicateSources.length + x.option.droppedIndependent.length -
      (y.option.violations.length + y.option.duplicateSources.length + y.option.droppedIndependent.length),
  );
  const best = candidates[0].option;
  const messages = [...best.duplicateSources, ...best.droppedIndependent, ...best.violations];
  return messages.length > 0 ? messages.join('；') : '组合不可行';
}

function findIncompatibilities(
  relations: MergeRelation[],
  evaluations: ComboEval[],
): IncompatibleDecisionSet[] {
  const out: IncompatibleDecisionSet[] = [];
  const decisions: { relationId: string; decision: MergeRelationDecision }[] = [];
  for (const relation of relations) {
    for (const decision of ['confirmed', 'rejected'] as const) {
      decisions.push({ relationId: relation.id, decision });
    }
  }
  const impossible = decisions.filter(
    (d) => !decisionFeasible(evaluations, d.relationId, d.decision),
  );
  for (const d of impossible) {
    out.push({
      decisions: [d.relationId + '=' + d.decision],
      reason: bestMessages(evaluations, (e) => e.decisions[d.relationId] === d.decision),
    });
  }
  const possible = decisions.filter(
    (d) => !impossible.some((x) => x.relationId === d.relationId && x.decision === d.decision),
  );
  for (let i = 0; i < possible.length; i++) {
    for (let j = i + 1; j < possible.length; j++) {
      const d1 = possible[i];
      const d2 = possible[j];
      if (d1.relationId === d2.relationId) continue;
      const together = evaluations.some(
        (e) =>
          e.decisions[d1.relationId] === d1.decision &&
          e.decisions[d2.relationId] === d2.decision &&
          e.option.feasible,
      );
      if (!together) {
        out.push({
          decisions: [d1.relationId + '=' + d1.decision, d2.relationId + '=' + d2.decision],
          reason: bestMessages(
            evaluations,
            (e) => e.decisions[d1.relationId] === d1.decision && e.decisions[d2.relationId] === d2.decision,
          ),
        });
      }
    }
  }
  return out;
}

/** 枚举全部拆合关系决定组合，给出可比较的合并方案与互斥决定集合 */
export function compareMergePlans(
  image: ImageRecord,
  aVersion: number,
  bVersion: number,
  constraints: MergeConstraint[] = [],
): MergePlanComparison {
  const probe = simulateMerge(image, aVersion, bVersion, {});
  const { relations, baseVersion } = probe;
  const aObjects = image.versions.find((v) => v.version === aVersion)!.objects;
  const bObjects = image.versions.find((v) => v.version === bVersion)!.objects;

  const evaluations: ComboEval[] = [];
  const total = 1 << relations.length;
  for (let mask = 0; mask < total; mask++) {
    const decisions: Record<string, MergeRelationDecision> = {};
    relations.forEach((relation, index) => {
      decisions[relation.id] = mask & (1 << index) ? 'confirmed' : 'rejected';
    });
    evaluations.push(
      evaluateCombo(image, aVersion, bVersion, relations, decisions, constraints, aObjects, bObjects),
    );
  }

  const options = evaluations.map((e) => e.option);
  options.sort((x, y) => {
    if (x.feasible !== y.feasible) return x.feasible ? -1 : 1;
    return x.pendingConflicts.length - y.pendingConflicts.length;
  });
  options.forEach((option, index) => {
    option.label = '方案 ' + (index + 1);
  });

  return {
    baseVersion,
    options,
    incompatibilities: findIncompatibilities(relations, evaluations),
  };
}

export interface MergeScopeResult {
  /** 已裁决的冲突 id */
  decided: string[];
  /** 待裁决且依赖已闭合（所依赖的拆合关系已确认） */
  actionable: string[];
  /** 依赖的拆合关系尚未确认或已被舍弃，暂不可裁决 */
  blocked: string[];
}

/** 计算当前会话下各项冲突的依赖闭合范围 */
export function mergeScope(
  conflicts: MergeConflict[],
  session: Pick<MergeSession, 'resolutions' | 'relations'>,
): MergeScopeResult {
  const decided: string[] = [];
  const actionable: string[] = [];
  const blocked: string[] = [];
  for (const conflict of conflicts) {
    const isRelation = conflict.id.startsWith('conflict:relation:');
    const relationId = isRelation ? conflict.id.slice('conflict:'.length) : conflict.dependsOn;
    const done = isRelation
      ? !!session.relations?.[relationId!]
      : !!session.resolutions[conflict.id];
    if (done) {
      decided.push(conflict.id);
    } else if (!isRelation && conflict.dependsOn && session.relations?.[conflict.dependsOn] !== 'confirmed') {
      blocked.push(conflict.id);
    } else {
      actionable.push(conflict.id);
    }
  }
  return { decided, actionable, blocked };
}

/** 撤回某项决定会一并重开的决定 id（含自身）；只撤回片段决定不影响其他区域 */
export function withdrawalImpact(
  conflicts: MergeConflict[],
  session: Pick<MergeSession, 'resolutions' | 'relations'>,
  conflictId: string,
): string[] {
  const impacted = [conflictId];
  if (conflictId.startsWith('conflict:relation:')) {
    const relationId = conflictId.slice('conflict:'.length);
    for (const conflict of conflicts) {
      if (conflict.dependsOn === relationId && session.resolutions[conflict.id]) {
        impacted.push(conflict.id);
      }
    }
  }
  return impacted;
}

/**
 * 把一份方案（或其中一部分依赖闭合的关系子集）批准到会话：
 * - 只写入选中的关系决定；
 * - 被舍弃关系下已裁决的片段决定一并撤回（依赖闭合）。
 */
export function applyPlanToSession(
  session: MergeSession,
  option: MergePlanOption,
  conflicts: MergeConflict[],
  onlyRelationIds?: string[],
): MergeSession {
  const allow = onlyRelationIds ? new Set(onlyRelationIds) : null;
  const relations = { ...(session.relations ?? {}) };
  const resolutions = { ...session.resolutions };
  for (const [relationId, decision] of Object.entries(option.relationDecisions)) {
    if (allow && !allow.has(relationId)) continue;
    relations[relationId] = decision;
    if (decision === 'rejected') {
      for (const conflict of conflicts) {
        if (conflict.dependsOn === relationId) delete resolutions[conflict.id];
      }
    }
  }
  return { ...session, relations, resolutions };
}
