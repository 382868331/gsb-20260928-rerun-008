import { describe, expect, it } from 'vitest';
import {
  applyMergeSession,
  createMergeSession,
} from './merge';
import {
  applyPlanningOption,
  buildMergePlanning,
  withdrawDecision,
} from './planning';
import {
  createContour,
  createImage,
  defaultCategories,
} from './versioning';
import type { AnnotationObject, ImageRecord, MergeConstraint } from '../types';

const cats = defaultCategories();

function revise(img: ImageRecord, fromVersion: number, mutate: (objects: AnnotationObject[]) => void): ImageRecord {
  const base = img.versions.find((v) => v.version === fromVersion)!;
  const objects = structuredClone(base.objects);
  mutate(objects);
  const next = structuredClone(img);
  next.versions.push({
    version: next.versions.length + 1,
    status: 'submitted',
    objects,
    createdAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    basedOn: fromVersion,
  });
  return next;
}

/** v1 三个并排物体：left/mid/right；之后连续拆分再交叉合并 */
function chainImage(): { img: ImageRecord; left: string; mid: string; right: string } {
  const img0 = createImage({ name: 'a.png', width: 300, height: 100, dataUrl: 'data:image/png;base64,STUB' });
  const ts = new Date().toISOString();
  const obj = (id: string, categoryId: string, x0: number, x1: number): AnnotationObject => ({
    id,
    categoryId,
    createdAt: ts,
    updatedAt: ts,
    contours: [createContour([
      { x: x0, y: 10 }, { x: x1, y: 10 }, { x: x1, y: 90 }, { x: x0, y: 90 },
    ])],
  });
  let img = structuredClone(img0);
  img.versions = [{
    version: 1,
    status: 'submitted',
    objects: [obj('left', cats[0].id, 10, 100), obj('mid', cats[0].id, 101, 200), obj('right', cats[1].id, 201, 290)],
    createdAt: ts,
    submittedAt: ts,
    basedOn: null,
  }];
  // v2（链 A 一代）：left 拆成 split-a/split-b
  img = revise(img, 1, (objs) => {
    const i = objs.findIndex((o) => o.id === 'left');
    objs.splice(i, 1, obj('split-a', cats[0].id, 10, 55), obj('split-b', cats[0].id, 56, 100));
  });
  // v3（链 A 二代）：split-b 与 mid 交叉合并成 cross；三代共同来源 left 同时到达 split-a 与 cross
  img = revise(img, 2, (objs) => {
    objs.splice(0, objs.length,
      objs.find((o) => o.id === 'split-a')!,
      obj('cross', cats[1].id, 56, 200),
      objs.find((o) => o.id === 'right')!,
    );
  });
  // v4（链 B）：仍在最早物体 left 上修改类别
  img = revise(img, 1, (objs) => {
    objs.find((o) => o.id === 'left')!.categoryId = cats[2].id;
  });
  return { img, left: 'left', mid: 'mid', right: 'right' };
}

describe('minimal-conflict merge planning', () => {
  it('enumerates comparable options through split then cross merge without double-counting a shared ancestor', () => {
    const { img, left, mid, right } = chainImage();
    const planning = buildMergePlanning(img, 3, 4);
    expect(planning.baseVersion).toBe(1);
    expect(planning.relations.length).toBeGreaterThanOrEqual(2);
    // 存在一份完整方案：同时确认拆分与交叉合并，覆盖三个基线来源
    const complete = planning.options.filter((o) => o.complete);
    expect(complete.length).toBeGreaterThan(0);
    const best = complete[0];
    expect(best.uncoveredSourceIds).toEqual([]);
    expect(best.candidateIds.some((id) => id.includes('independent:' + right))).toBe(true);

    // 确认拆分 + 确认合并的两个候选必须兼容：共享祖先 left 汇聚到不同物体但几何不重叠
    const splitConfirm = planning.candidates.find(
      (c) => c.relationDecision === 'confirmed' && c.objectIds.includes('split-a'),
    )!;
    const mergeConfirm = planning.candidates.find(
      (c) => c.relationDecision === 'confirmed' && c.objectIds.includes('cross') && c.objectIds.length === 1,
    )!;
    expect(mergeConfirm.coveredSourceIds.sort()).toEqual([left, mid].sort());
    const clash = planning.incompatibilities.find(
      (i) =>
        (i.candidateAId === splitConfirm.id && i.candidateBId === mergeConfirm.id) ||
        (i.candidateAId === mergeConfirm.id && i.candidateBId === splitConfirm.id),
    );
    expect(clash).toBeUndefined();

    // 同一条关系的确认与舍弃互斥
    const mergeReject = planning.candidates.find(
      (c) => c.relationDecision === 'rejected' && c.relationId === mergeConfirm.relationId,
    )!;
    expect(
      planning.incompatibilities.some(
        (i) =>
          [i.candidateAId, i.candidateBId].sort().join('|') ===
          [mergeConfirm.id, mergeReject.id].sort().join('|'),
      ),
    ).toBe(true);
  });

  it('keeps independent-source objects in every complete option; deletion cannot satisfy a conflict', () => {
    const { img, right } = chainImage();
    const planning = buildMergePlanning(img, 3, 4);
    const independent = planning.candidates.find((c) => c.id === 'candidate:independent:' + right)!;
    expect(independent.independent).toBe(true);
    for (const option of planning.options.filter((o) => o.complete)) {
      expect(option.candidateIds).toContain(independent.id);
    }
  });

  it('marks category and group constraints as satisfied or unsatisfiable', () => {
    const { img, left, mid } = chainImage();
    // 可行类别约束：left 最终两个落点在 v4 里改了类别，默认结构候选类别是 cats[0/1]，
    // 故约束要求 cats[1] 时 cross 落点满足、split-a 不满足 → 违反；要求 cats[0] 同理部分违反。
    // 构造一条必然不可满足的类别：要求 left 落到一个不存在的类别 cats[3]。
    const impossible: MergeConstraint = {
      id: 'k1',
      kind: 'category',
      sourceObjectIds: [left],
      categoryId: cats[3]?.id ?? 'no-such-category',
    };
    const p1 = buildMergePlanning(img, 3, 4, [impossible]);
    expect(p1.options.filter((o) => o.violatedConstraintIds.includes('k1')).length).toBeGreaterThan(0);
    expect(p1.options.some((o) => o.satisfiedConstraintIds.includes('k1'))).toBe(false);
    const core1 = p1.unsatisfiableSets.find((s) => s.kind === 'constraint-unsatisfiable' && s.memberIds.includes('k1'));
    expect(core1).toBeTruthy();

    // 分组约束：left 与 mid 必须共同落入同一候选；交叉合并 cross 同时承载二者 → 存在满足方案
    const together: MergeConstraint = {
      id: 'g1',
      kind: 'group',
      sourceObjectIds: [left, mid],
      groupId: 'grp-x',
    };
    const p2 = buildMergePlanning(img, 3, 4, [together]);
    const satisfied = p2.options.find((o) => o.satisfiedConstraintIds.includes('g1'))!;
    expect(satisfied).toBeTruthy();
    const crossConfirm = p2.candidates.find((c) => c.objectIds.length === 1 && c.objectIds[0] === 'cross')!;
    expect(satisfied.candidateIds).toContain(crossConfirm.id);

    // 分组约束与“必须舍弃合并”的既有决定构成最小冲突集合（候选互斥对已由不可满足集合给出）
    const rejectMerge = p2.candidates.find(
      (c) => c.relationDecision === 'rejected' && c.relationId === crossConfirm.relationId,
    )!;
    expect(
      p2.unsatisfiableSets.some(
        (s) => s.kind === 'candidate-conflict' && s.memberIds.includes(crossConfirm.id) && s.memberIds.includes(rejectMerge.id),
      ),
    ).toBe(true);
  });

  it('closes fragment decisions on approval and reports withdrawal impact with pending scope', () => {
    const { img } = chainImage();
    const session = createMergeSession(img, 3, 4);
    const planning0 = buildMergePlanning(img, 3, 4, [], session);
    // 初始：关系与片段冲突都在未决范围内
    expect(planning0.pending.some((p) => p.kind === 'relation')).toBe(true);

    // 只批准一部分候选（依赖闭合范围）：确认拆分关系，合并关系仍未决
    const splitConfirm = planning0.candidates.find(
      (c) => c.relationDecision === 'confirmed' && c.objectIds.includes('split-a'),
    )!;
    const partial = applyPlanningOption(session, planning0, [splitConfirm.id]);
    expect(partial.relations[splitConfirm.relationId]).toBe('confirmed');
    const planning1 = buildMergePlanning(img, 3, 4, [], partial);
    expect(planning1.pending.map((p) => p.id)).not.toContain('conflict:' + splitConfirm.relationId);
    expect(planning1.pending.some((p) => p.kind === 'relation')).toBe(true); // 合并关系仍未决

    // 批准完整方案：全部关系确认，片段冲突自动闭合到结构侧
    const allRelationIds = planning1.relations.map((r) => r.id);
    const best = planning1.options.find(
      (o) =>
        o.complete &&
        o.violatedConstraintIds.length === 0 &&
        allRelationIds.every((rid) =>
          o.candidateIds.includes('candidate:confirm:' + rid),
        ),
    )!;
    const full = applyPlanningOption(partial, planning1, best);
    const planning2 = buildMergePlanning(img, 3, 4, [], full);
    // 结构侧都是链 A，片段默认 adopt-a；仍可能存在与链 B 的非片段冲突，但方案已无关系未决
    expect(planning2.pending.some((p) => p.kind === 'relation')).toBe(false);
    for (const relation of planning2.relations) {
      expect(full.relations[relation.id]).toBe('confirmed');
    }
    const merged = applyMergeSession(img, full);
    const v = merged.versions.at(-1)!;
    expect(v.objects.map((o) => o.id).sort()).toEqual(['cross', 'right', 'split-a']);

    // 撤回拆分关系：依赖它的片段决定重开，split-a/cross 退回未决
    const { session: withdrawn, impact } = withdrawDecision(full, planning2, splitConfirm.relationId);
    expect(withdrawn.relations[splitConfirm.relationId]).toBeUndefined();
    expect(impact.affectedObjectIds).toContain('split-a');
    for (const id of impact.reopenedDecisionIds) {
      expect(withdrawn.resolutions[id]).toBeUndefined();
    }
    const planning3 = buildMergePlanning(img, 3, 4, [], withdrawn);
    expect(planning3.pending.some((p) => p.kind === 'relation' && p.id === 'conflict:' + splitConfirm.relationId)).toBe(true);
  });
});
