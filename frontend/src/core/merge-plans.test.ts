import { describe, expect, it } from 'vitest';
import {
  applyMergeSession,
  createMergeSession,
  planMerge,
} from './merge';
import {
  applyPlanToSession,
  compareMergePlans,
  mergeScope,
  withdrawalImpact,
} from './merge-plans';
import {
  addDraftObject,
  createContour,
  createHole,
  createImage,
  defaultCategories,
  submitDraft,
  updateDraftObject,
} from './versioning';
import type { AnnotationObject, ImageRecord } from '../types';

const cats = defaultCategories();

function baseImage(): { img: ImageRecord; obj1: string; obj2: string } {
  let img = createImage({ name: 'a.png', width: 200, height: 200, dataUrl: 'data:image/png;base64,STUB' });
  const r1 = addDraftObject(img, cats[0].id);
  img = updateDraftObject(r1.image, r1.objectId, (o) => {
    const c = createContour([
      { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 },
    ]);
    c.holes.push(createHole([
      { x: 30, y: 30 }, { x: 60, y: 30 }, { x: 60, y: 60 }, { x: 30, y: 60 },
    ]));
    o.contours.push(c);
  });
  const r2 = addDraftObject(img, cats[1].id);
  img = updateDraftObject(r2.image, r2.objectId, (o) => {
    o.contours.push(createContour([
      { x: 110, y: 110 }, { x: 190, y: 110 }, { x: 190, y: 190 }, { x: 110, y: 190 },
    ]));
  });
  img = submitDraft(img, 'base');
  return { img, obj1: r1.objectId, obj2: r2.objectId };
}

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

/** 连续拆分后交叉合并：v2 拆 obj1 为左右两半，v3 右半与 obj2 合并，v4 从 v1 改类别与孔洞 */
function crossMergeImage(): { img: ImageRecord; obj1: string; obj2: string } {
  const { img: base, obj1, obj2 } = baseImage();
  let img = revise(base, 1, (objs) => {
    const i = objs.findIndex((o) => o.id === obj1);
    const createdAt = new Date().toISOString();
    objs.splice(i, 1,
      {
        id: 'split-left', categoryId: cats[0].id, createdAt, updatedAt: createdAt,
        contours: [createContour([{ x: 10, y: 10 }, { x: 70, y: 10 }, { x: 70, y: 90 }, { x: 10, y: 90 }])],
      },
      {
        id: 'split-right', categoryId: cats[0].id, createdAt, updatedAt: createdAt,
        contours: [createContour([{ x: 70, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 70, y: 90 }])],
      },
    );
  });
  img = revise(img, 2, (objs) => {
    const createdAt = new Date().toISOString();
    objs.splice(0, objs.length,
      objs.find((o) => o.id === 'split-left')!,
      {
        id: 'merged-obj', categoryId: cats[1].id, createdAt, updatedAt: createdAt,
        contours: [createContour([{ x: 70, y: 10 }, { x: 190, y: 10 }, { x: 190, y: 190 }, { x: 70, y: 190 }])],
      },
    );
  });
  img = revise(img, 1, (objs) => {
    const obj = objs.find((o) => o.id === obj1)!;
    obj.categoryId = cats[2].id;
    obj.contours[0].holes[0].points[0] = { x: 35, y: 35 };
  });
  return { img, obj1, obj2 };
}

describe('merge plan comparison', () => {
  it('连续拆分后交叉合并：给出可比较方案，共享祖先不重复计数', () => {
    const { img, obj1, obj2 } = crossMergeImage();
    const comparison = compareMergePlans(img, 3, 4);
    expect(comparison.baseVersion).toBe(1);
    // 两条拆合关系 → 四份候选方案
    expect(comparison.options).toHaveLength(4);

    // 方案按最小冲突排序，可行方案均列出且可比较
    expect(comparison.options[0].feasible).toBe(true);
    const plan = planMerge(img, 3, 4);
    const splitRel = plan.relations.find((r) => r.kind === 'split')!;
    const mergeRel = plan.relations.find((r) => r.kind === 'merge')!;
    const best = comparison.options.find(
      (o) => o.relationDecisions[splitRel.id] === 'confirmed' && o.relationDecisions[mergeRel.id] === 'confirmed',
    )!;
    expect(best.feasible).toBe(true);
    // 最终只有两个区域：左半与合并体；共享祖先 obj1 不被重复算成两个独立物体
    expect(best.finalObjects.map((o) => o.id).sort()).toEqual(['merged-obj', 'split-left']);
    expect(best.duplicateSources).toEqual([]);
    expect(best.droppedIndependent).toEqual([]);
    const merged = best.finalObjects.find((o) => o.id === 'merged-obj')!;
    expect(merged.sources.map((s) => s.objectId).sort()).toEqual([obj1, obj2].sort());
    // obj2 只被覆盖一次
    const coverage = best.finalObjects.flatMap((o) => o.sources.map((s) => s.objectId));
    expect(coverage.filter((id) => id === obj2)).toHaveLength(1);

    // 舍弃拆分却确认合并的方案会丢掉仍有独立来源的 split-left，不可行
    const bad = comparison.options.find(
      (o) => o.relationDecisions[splitRel.id] === 'rejected' && o.relationDecisions[mergeRel.id] === 'confirmed',
    )!;
    expect(bad.feasible).toBe(false);
    expect(bad.droppedIndependent.join()).toContain('split-left');

    // 无法同时满足的决定集合包含这对组合
    const pair = comparison.incompatibilities.find(
      (inc) =>
        inc.decisions.includes(splitRel.id + '=rejected') &&
        inc.decisions.includes(mergeRel.id + '=confirmed'),
    );
    expect(pair).toBeDefined();
    expect(pair!.reason).toContain('split-left');

    // 分组约束：obj1 与 obj2 必须同组 → 只有确认合并的方案可行
    const constrained = compareMergePlans(img, 3, 4, [
      { id: 'mc1', kind: 'keep-group', objectIds: [obj1, obj2] },
    ]);
    const feasible = constrained.options.filter((o) => o.feasible);
    expect(feasible).toHaveLength(1);
    expect(feasible[0].relationDecisions[mergeRel.id]).toBe('confirmed');
    const rejectedMerge = constrained.options.find(
      (o) => o.relationDecisions[mergeRel.id] === 'rejected' && o.relationDecisions[splitRel.id] === 'confirmed',
    )!;
    expect(rejectedMerge.feasible).toBe(false);
    expect(rejectedMerge.violations.join()).toContain('同一组');

    // 类别约束：obj1 必须保留 cats[2]（B 链的修改可经裁决满足）
    const catConstrained = compareMergePlans(img, 3, 4, [
      { id: 'mc2', kind: 'keep-category', objectIds: [obj1], categoryId: cats[2].id },
    ]);
    expect(catConstrained.options[0].feasible).toBe(true);
    // 任何修订都未曾使用的类别：所有方案都不可行
    const impossible = compareMergePlans(img, 3, 4, [
      { id: 'mc3', kind: 'keep-category', objectIds: [obj2], categoryId: 'cat-nonexistent' },
    ]);
    expect(impossible.options.every((o) => !o.feasible)).toBe(true);
    expect(impossible.options[0].violations.join()).toContain(obj2);

    // 批准最优方案并完成合并：最终物体与来源稳定
    let session = createMergeSession(img, 3, 4);
    session = applyPlanToSession(session, best, plan.conflicts);
    expect(session.relations[splitRel.id]).toBe('confirmed');
    expect(session.relations[mergeRel.id]).toBe('confirmed');
    for (const c of plan.conflicts.filter((c) => c.dependsOn)) {
      session.resolutions[c.id] = 'adopt-b';
    }
    const out = applyMergeSession(img, session);
    const v = out.versions.at(-1)!;
    expect(v.objects.map((o) => o.id).sort()).toEqual(['merged-obj', 'split-left']);
    expect(v.objects.find((o) => o.id === 'merged-obj')!.categoryId).toBe(cats[2].id);
  });

  it('三代共同来源：无拆合关系时方案唯一，约束筛选仍生效', () => {
    const { img: base, obj1, obj2 } = baseImage();
    // 链 A 三代：v2 改 obj1 类别，v3 再改 obj2 类别
    let img = revise(base, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.categoryId = cats[1].id;
    });
    img = revise(img, 2, (objs) => {
      objs.find((o) => o.id === obj2)!.categoryId = cats[2].id;
    });
    // 链 B 从 v1 改 obj1 的孔洞
    img = revise(img, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.contours[0].holes[0].points[0] = { x: 33, y: 33 };
    });

    const comparison = compareMergePlans(img, 3, 4);
    expect(comparison.baseVersion).toBe(1);
    expect(comparison.options).toHaveLength(1);
    const only = comparison.options[0];
    expect(only.feasible).toBe(true);
    expect(only.relationDecisions).toEqual({});
    // 互不冲突的修改自动一起保留，没有待裁决冲突
    expect(only.pendingConflicts).toHaveLength(0);
    expect(only.finalObjects.map((o) => o.id).sort()).toEqual([obj1, obj2].sort());
    expect(only.finalObjects.find((o) => o.id === obj1)!.categoryId).toBe(cats[1].id);
    expect(only.finalObjects.find((o) => o.id === obj2)!.categoryId).toBe(cats[2].id);
    expect(comparison.incompatibilities).toEqual([]);

    // 类别约束与自动合并结果一致时可行，矛盾时唯一方案也不可行
    const ok = compareMergePlans(img, 3, 4, [
      { id: 'mc1', kind: 'keep-category', objectIds: [obj1], categoryId: cats[1].id },
    ]);
    expect(ok.options[0].feasible).toBe(true);
    const bad = compareMergePlans(img, 3, 4, [
      { id: 'mc2', kind: 'keep-category', objectIds: [obj1], categoryId: cats[0].id },
    ]);
    expect(bad.options[0].feasible).toBe(false);
    expect(bad.options[0].violations.join()).toContain(obj1);
    // 分组约束：两个物体本就各自独立，要求同组不可满足
    const grouped = compareMergePlans(img, 3, 4, [
      { id: 'mc3', kind: 'keep-group', objectIds: [obj1, obj2] },
    ]);
    expect(grouped.options[0].feasible).toBe(false);
  });

  it('部分已裁决：依赖闭合范围、最终物体与撤回影响', () => {
    const { img, obj1 } = crossMergeImage();
    const plan = planMerge(img, 3, 4);
    const splitRel = plan.relations.find((r) => r.kind === 'split')!;
    const mergeRel = plan.relations.find((r) => r.kind === 'merge')!;
    let session = createMergeSession(img, 3, 4);

    // 初始：关系决定可裁决，片段冲突因依赖未闭合而冻结
    let scope = mergeScope(plan.conflicts, session);
    expect(scope.decided).toEqual([]);
    expect(scope.actionable.sort()).toEqual(
      plan.conflicts.filter((c) => c.id.startsWith('conflict:relation:')).map((c) => c.id).sort(),
    );
    expect(scope.blocked.length).toBeGreaterThan(0);
    expect(scope.blocked).toEqual(
      plan.conflicts.filter((c) => !!c.dependsOn).map((c) => c.id),
    );

    // 只批准方案的一部分（依赖闭合的关系子集）：先确认拆分
    const comparison = compareMergePlans(img, 3, 4);
    const best = comparison.options.find(
      (o) => o.relationDecisions[splitRel.id] === 'confirmed' && o.relationDecisions[mergeRel.id] === 'confirmed',
    )!;
    session = applyPlanToSession(session, best, plan.conflicts, [splitRel.id]);
    expect(session.relations[splitRel.id]).toBe('confirmed');
    expect(session.relations[mergeRel.id]).toBeUndefined();

    // 拆分下的片段冲突变为可裁决，合并关系下的仍冻结
    scope = mergeScope(plan.conflicts, session);
    const splitFragments = plan.conflicts.filter((c) => c.dependsOn === splitRel.id).map((c) => c.id);
    const mergeFragments = plan.conflicts.filter((c) => c.dependsOn === mergeRel.id).map((c) => c.id);
    for (const id of splitFragments) expect(scope.actionable).toContain(id);
    for (const id of mergeFragments) expect(scope.blocked).toContain(id);

    // 对拆分下一个片段作出裁决，撤回拆分关系会级联重开它
    const fragmentId = splitFragments[0];
    session.resolutions[fragmentId] = 'adopt-b';
    const impact = withdrawalImpact(plan.conflicts, session, 'conflict:' + splitRel.id);
    expect(impact).toContain('conflict:' + splitRel.id);
    expect(impact).toContain(fragmentId);
    // 撤回片段决定只影响自身
    expect(withdrawalImpact(plan.conflicts, session, fragmentId)).toEqual([fragmentId]);
    // 撤回其他关系不影响该片段
    expect(withdrawalImpact(plan.conflicts, session, 'conflict:' + mergeRel.id)).toEqual([
      'conflict:' + mergeRel.id,
    ]);

    // 改批一份舍弃拆分的方案，依赖闭合：拆分下的片段决定被撤回，其余保留
    const otherFragment = plan.conflicts.find(
      (c) => c.dependsOn && c.dependsOn !== splitRel.id,
    );
    if (otherFragment) session.resolutions[otherFragment.id] = 'adopt-a';
    const rejectSplit = comparison.options.find(
      (o) => o.relationDecisions[splitRel.id] === 'rejected' && o.feasible,
    )!;
    session = applyPlanToSession(session, rejectSplit, plan.conflicts, [splitRel.id]);
    expect(session.relations[splitRel.id]).toBe('rejected');
    expect(session.resolutions[fragmentId]).toBeUndefined();
    if (otherFragment) expect(session.resolutions[otherFragment.id]).toBe('adopt-a');

    // 重新批准最优方案并完成：最终物体与未决范围正确
    session = applyPlanToSession(session, best, plan.conflicts);
    expect(session.relations[mergeRel.id]).toBe('confirmed');
    scope = mergeScope(plan.conflicts, session);
    expect(scope.blocked).toEqual([]);
    for (const c of plan.conflicts.filter((c) => c.dependsOn && !session.resolutions[c.id])) {
      session.resolutions[c.id] = 'adopt-b';
    }
    const out = applyMergeSession(img, session);
    const v = out.versions.at(-1)!;
    expect(v.objects.map((o) => o.id).sort()).toEqual(['merged-obj', 'split-left']);
    expect(v.mergeAudit?.relations).toHaveLength(2);
    expect(img.versions.map((ver) => ver.version)).toEqual([1, 2, 3, 4]);
  });
});
