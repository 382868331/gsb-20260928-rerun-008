import { describe, expect, it } from 'vitest';
import {
  applyMergeSession,
  createMergeSession,
  planMerge,
  resolveMergeBase,
} from './merge';
import {
  addDraftObject,
  createContour,
  createHole,
  createImage,
  defaultCategories,
  submitDraft,
  updateDraftObject,
} from './versioning';
import { exportProject } from './exchange';
import type { AnnotationObject, ImageRecord, MergeSession } from '../types';

const cats = defaultCategories();

/** 构造基线 v1：两个物体，obj1 带一个外轮廓和一个孔洞 */
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

/** 从指定版本派生一条新修订（模拟另一个人从同一版本另起修订） */
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

function merged(img: ImageRecord, session: MergeSession) {
  const out = applyMergeSession(img, session);
  return out.versions[out.versions.length - 1];
}

describe('merge', () => {
  it('auto-keeps non-conflicting changes from both revisions', () => {
    const { img: base, obj1, obj2 } = baseImage();
    let img = revise(base, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.categoryId = cats[2].id;
    });
    img = revise(img, 1, (objs) => {
      objs.find((o) => o.id === obj2)!.contours[0].points[0] = { x: 100, y: 100 };
    });
    const plan = planMerge(img, 2, 3);
    expect(plan.baseVersion).toBe(1);
    expect(plan.conflicts).toHaveLength(0);
    const v = merged(img, createMergeSession(img, 2, 3));
    const o1 = v.objects.find((o) => o.id === obj1)!;
    const o2 = v.objects.find((o) => o.id === obj2)!;
    expect(o1.categoryId).toBe(cats[2].id);
    expect(o2.contours[0].points[0]).toEqual({ x: 100, y: 100 });
  });

  it('conflicts on same part, resolves per item, undo keeps other decisions', () => {
    const { img: base, obj1, obj2 } = baseImage();
    let img = revise(base, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.categoryId = cats[1].id;
      objs.find((o) => o.id === obj2)!.categoryId = cats[2].id;
    });
    img = revise(img, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.categoryId = cats[2].id;
      objs.find((o) => o.id === obj2)!.categoryId = cats[0].id;
    });
    const session = createMergeSession(img, 2, 3);
    const plan = planMerge(img, 2, 3);
    expect(plan.conflicts).toHaveLength(2);
    expect(() => applyMergeSession(img, session)).toThrow(/未确认|未裁决/);

    session.resolutions['category:' + obj1] = 'a';
    session.resolutions['category:' + obj2] = 'b';
    expect(() => applyMergeSession(img, session)).not.toThrow();

    // 撤回其中一项：其他决定保留，合并再次变得不可完成
    delete session.resolutions['category:' + obj1];
    expect(session.resolutions['category:' + obj2]).toBe('b');
    expect(() => applyMergeSession(img, session)).toThrow();

    session.resolutions['category:' + obj1] = 'b';
    const v = merged(img, session);
    expect(v.objects.find((o) => o.id === obj1)!.categoryId).toBe(cats[2].id);
    expect(v.objects.find((o) => o.id === obj2)!.categoryId).toBe(cats[0].id);
  });

  it('never silently drops delete-object vs hole-modification', () => {
    const { img: base, obj1, obj2 } = baseImage();
    let img = revise(base, 1, (objs) => {
      const i = objs.findIndex((o) => o.id === obj1);
      objs.splice(i, 1); // A 删除物体
    });
    img = revise(img, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.contours[0].holes[0].points[0] = { x: 35, y: 35 }; // B 改它的孔洞
    });
    const plan = planMerge(img, 2, 3);
    expect(plan.conflicts.map((c) => c.part)).toContain('object-existence');

    const keepDelete = createMergeSession(img, 2, 3);
    keepDelete.resolutions['object:' + obj1] = 'a';
    expect(merged(img, keepDelete).objects.find((o) => o.id === obj1)).toBeUndefined();

    const keepModified = createMergeSession(img, 2, 3);
    keepModified.resolutions['object:' + obj1] = 'b';
    const v = merged(img, keepModified);
    expect(v.objects.find((o) => o.id === obj1)!.contours[0].holes[0].points[0]).toEqual({ x: 35, y: 35 });
  });

  it('keeps stable object ids, records both sources, never rewrites history', () => {
    const { img: base, obj1 } = baseImage();
    let img = revise(base, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.categoryId = cats[1].id;
    });
    img = revise(img, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.contours[0].points[0] = { x: 5, y: 5 };
    });
    const before = structuredClone(img.versions);
    const v = merged(img, createMergeSession(img, 2, 3));
    expect(v.status).toBe('submitted');
    expect(v.mergeOf).toEqual({ base: 1, a: 2, b: 3 });
    expect(v.basedOn).toBe(1);
    expect(v.objects.map((o) => o.id).sort()).toEqual(
      base.versions[0].objects.map((o) => o.id).sort(),
    );
    // 旧提交逐字节不变
    const out = applyMergeSession(img, createMergeSession(img, 2, 3));
    expect(out.versions.slice(0, before.length)).toEqual(before);
    // 导出包含合并来源
    const exported = exportProject([out], cats);
    const last = exported.images[0].submittedVersions.at(-1)!;
    expect(last.mergeOf).toEqual({ base: 1, a: 2, b: 3 });
  });

  it('rejects revisions from different bases', () => {
    const { img: base } = baseImage();
    let img = revise(base, 1, () => {});
    img = revise(img, 2, () => {}); // v3 基于 v2，而 v2 基于 v1
    expect(() => resolveMergeBase(img, 2, 3)).toThrow(/同一版本/);
  });

  it('merges holes added on one side and removed on the other independently', () => {
    const { img: base, obj1, obj2 } = baseImage();
    let img = revise(base, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.contours[0].holes.push(
        createHole([{ x: 40, y: 40 }, { x: 50, y: 40 }, { x: 50, y: 50 }, { x: 40, y: 50 }]),
      );
    });
    img = revise(img, 1, (objs) => {
      objs.find((o) => o.id === obj2)!.contours[0].points[1] = { x: 185, y: 110 };
    });
    const session = createMergeSession(img, 2, 3);
    const v = merged(img, session);
    expect(v.objects.find((o) => o.id === obj1)!.contours[0].holes).toHaveLength(2);
    expect(v.objects.find((o) => o.id === obj2)!.contours[0].points[1]).toEqual({ x: 185, y: 110 });
  });

  it('tracks split provenance and routes category and hole edits to applicable parts', () => {
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
    img = revise(img, 1, (objs) => {
      const obj = objs.find((o) => o.id === obj1)!;
      obj.categoryId = cats[2].id;
      obj.contours[0].holes[0].points[0] = { x: 35, y: 35 };
    });
    const plan = planMerge(img, 2, 3);
    const relation = plan.relations.find((r) => r.kind === 'split' && r.side === 'a')!;
    expect(relation.sourceObjectIds).toEqual([obj1]);
    expect(relation.targetObjectIds).toEqual(['split-left', 'split-right']);
    const session = createMergeSession(img, 2, 3);
    expect(() => applyMergeSession(img, session)).toThrow(/拆合关系未确认/);
    session.relations[relation.id] = 'confirmed';
    const partialPlan = planMerge(img, 2, 3);
    const sourceConflicts = partialPlan.conflicts.filter((c) => c.dependsOn === relation.id);
    expect(sourceConflicts.filter((c) => c.part === 'category').map((c) => c.objectId).sort()).toEqual(['split-left', 'split-right']);
    expect(sourceConflicts.filter((c) => c.part === 'hole').map((c) => c.objectId)).toEqual(['split-left']);
    for (const conflict of sourceConflicts) session.resolutions[conflict.id] = 'adopt-b';
    const v = merged(img, session);
    expect(v.objects.map((o) => o.id).sort()).toEqual([obj2, 'split-left', 'split-right'].sort());
    const left = v.objects.find((o) => o.id === 'split-left')!;
    const right = v.objects.find((o) => o.id === 'split-right')!;
    expect(left.categoryId).toBe(cats[2].id);
    expect(right.categoryId).toBe(cats[2].id);
    expect(left.contours[0].holes[0].points[0]).toEqual({ x: 35, y: 35 });
    expect(right.contours[0].holes).toEqual([]);
    expect(left.provenance).toMatchObject({ transformation: 'split', sources: [{ objectId: obj1 }] });
    expect(v.mergeAudit?.relations.some((r) => r.relationId === relation.id && r.decision === 'confirmed')).toBe(true);
    expect(img.versions.map((version) => version.version)).toEqual([1, 2, 3]);
  });

  it('records every old object behind a merged result and avoids duplicate export', () => {
    const { img: base, obj1, obj2 } = baseImage();
    let img = revise(base, 1, (objs) => {
      const createdAt = new Date().toISOString();
      objs.splice(0, objs.length, {
        id: 'merged-one',
        categoryId: cats[1].id,
        createdAt,
        updatedAt: createdAt,
        contours: [createContour([
          { x: 10, y: 10 }, { x: 190, y: 10 }, { x: 190, y: 190 }, { x: 10, y: 190 },
        ])],
      });
    });
    img = revise(img, 1, () => {});
    const plan = planMerge(img, 2, 3);
    const relation = plan.relations.find((r) => r.kind === 'merge')!;
    expect(relation.sourceObjectIds.sort()).toEqual([obj1, obj2].sort());
    const session = createMergeSession(img, 2, 3);
    session.relations[relation.id] = 'confirmed';
    const v = merged(img, session);
    expect(v.objects).toHaveLength(1);
    expect(v.objects[0].id).toBe('merged-one');
    expect(v.objects[0].provenance?.transformation).toBe('merge');
    expect(v.objects[0].provenance?.sources.map((s) => s.objectId).sort()).toEqual([obj1, obj2].sort());
    expect(v.mergeAudit?.decisions.length).toBeGreaterThan(0);
  });

  it('follows a continuous split then partial-merge chain and never exports intermediates', () => {
    const { img: base, obj1, obj2 } = baseImage();
    const createdAt = new Date().toISOString();
    // A 连续返工：obj1 先拆成 split-left / split-right，split-right 随后扩张并与 obj2 局部合并为 merged-2
    let img = revise(base, 1, (objs) => {
      objs.splice(0, objs.length,
        {
          id: 'split-left', categoryId: cats[0].id, createdAt, updatedAt: createdAt,
          contours: [createContour([{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 90 }, { x: 10, y: 90 }])],
        },
        {
          id: 'merged-2', categoryId: cats[1].id, createdAt, updatedAt: createdAt,
          contours: [createContour([
            { x: 50, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 100 }, { x: 190, y: 100 },
            { x: 190, y: 190 }, { x: 110, y: 190 }, { x: 110, y: 100 }, { x: 50, y: 100 },
          ])],
        },
      );
    });
    // B 仍在修改最早物体 obj1 的类别
    img = revise(img, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.categoryId = cats[2].id;
    });
    const plan = planMerge(img, 2, 3);
    const split = plan.relations.find((r) => r.kind === 'split' && r.side === 'a')!;
    const mergeRel = plan.relations.find((r) => r.kind === 'merge' && r.side === 'a')!;
    expect(split.targetObjectIds.sort()).toEqual(['merged-2', 'split-left']);
    // 该场景没有独立的中间物体：直接来源记录根物体 obj1 与 obj2，上游拆分是其前置
    expect(mergeRel.sourceObjectIds.sort()).toEqual([obj1, obj2].sort());
    expect(mergeRel.prerequisiteRelationIds).toContain(split.id);
    // 最终来源始终追溯到基线，中间物体不出现
    expect(mergeRel.baseSourceObjectIds?.sort()).toEqual([obj1, obj2].sort());

    const session = createMergeSession(img, 2, 3);
    // 允许只确认来源链的一部分（先确认拆分）后“保存继续”：不抛错且不会落地半成品
    session.relations[split.id] = 'confirmed';
    expect(() => applyMergeSession(img, session)).toThrow(/未确认/);

    session.relations[mergeRel.id] = 'confirmed';
    const sourceConflicts = plan.conflicts.filter((c) => c.dependsOn);
    // 同一处类别修改沿链映射到每个最终区域，逐区域决定
    const catTargets = sourceConflicts.filter((c) => c.part === 'category').map((c) => c.objectId).sort();
    expect(catTargets).toEqual(['merged-2', 'split-left']);
    for (const c of sourceConflicts) session.resolutions[c.id] = 'adopt-b';
    const v = merged(img, session);
    expect(v.objects.map((o) => o.id).sort()).toEqual(['merged-2', 'split-left']);
    const finalMerged = v.objects.find((o) => o.id === 'merged-2')!;
    const leafSources = finalMerged.provenance!.sources.map((s) => s.objectId).sort();
    expect(leafSources).toEqual([obj1, obj2].sort());
    expect(finalMerged.provenance!.sources.some((s) => s.objectId === 'split-right')).toBe(false);
    expect(finalMerged.categoryId).toBe(cats[2].id);
  });

    it('undoing an upstream split reopens only dependent downstream decisions', () => {
    const { img: base, obj1, obj2 } = baseImage();
    const createdAt = new Date().toISOString();
    let img = revise(base, 1, (objs) => {
      objs.splice(0, objs.length,
        {
          id: 'split-left', categoryId: cats[0].id, createdAt, updatedAt: createdAt,
          contours: [createContour([{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 90 }, { x: 10, y: 90 }])],
        },
        {
          id: 'merged-2', categoryId: cats[1].id, createdAt, updatedAt: createdAt,
          contours: [createContour([
            { x: 50, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 100 }, { x: 190, y: 100 },
            { x: 190, y: 190 }, { x: 110, y: 190 }, { x: 110, y: 100 }, { x: 50, y: 100 },
          ])],
        },
      );
    });
    img = revise(img, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.categoryId = cats[2].id;
    });
    const plan = planMerge(img, 2, 3);
    const split = plan.relations.find((r) => r.kind === 'split')!;
    const mergeRel = plan.relations.find((r) => r.kind === 'merge')!;
    const session = createMergeSession(img, 2, 3);
    session.relations[split.id] = 'confirmed';
    session.relations[mergeRel.id] = 'confirmed';
    for (const c of plan.conflicts.filter((c) => c.dependsOn)) session.resolutions[c.id] = 'adopt-b';
    // 撤回上游拆分：模拟 store 的级联——拆分、下游合并及依赖它们的片段决定全部重开
    delete session.relations[split.id];
    delete session.relations[mergeRel.id];
    for (const c of plan.conflicts.filter((c) => c.dependsOn === split.id || c.dependsOn === mergeRel.id)) delete session.resolutions[c.id];
    expect(session.relations[mergeRel.id]).toBeUndefined();
    expect(Object.values(session.resolutions).filter((x) => x === 'adopt-b')).toHaveLength(0);
    expect(() => applyMergeSession(img, session)).toThrow();
    // obj2 不依赖该链：这里没有其它决定，但其它图片/区域的会话数据天然保留在 session 中
    expect(mergeRel.prerequisiteRelationIds).toContain(split.id);
  });

  it('surfaces holes that cross the split boundary instead of silently duplicating them', () => {
    const { img: base, obj1, obj2 } = baseImage();
    // 孔洞跨在拆分边界 x=70 上：30..80
    let img = revise(base, 1, (objs) => {
      const obj = objs.find((o) => o.id === obj1)!;
      obj.contours[0].holes[0].points = [
        { x: 30, y: 30 }, { x: 80, y: 30 }, { x: 80, y: 60 }, { x: 30, y: 60 },
      ];
    });
    const createdAt = new Date().toISOString();
    img = revise(img, 1, (objs) => {
      objs.splice(objs.findIndex((o) => o.id === obj1), 1,
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
    const plan = planMerge(img, 2, 3);
    const split = plan.relations.find((r) => r.kind === 'split')!;
    expect(plan.conflicts.some((c) => c.part === 'hole-cross')).toBe(true);
    const session = createMergeSession(img, 2, 3);
    session.relations[split.id] = 'confirmed';
    // 歧义未裁决不能提交
    expect(() => applyMergeSession(img, session)).toThrow(/片段冲突未确认/);
    for (const c of plan.conflicts.filter((c) => !c.id.startsWith('conflict:relation:') && c.dependsOn)) {
      session.resolutions[c.id] = 'adopt-a';
    }
    const v = merged(img, session);
    expect(v.objects.map((o) => o.id).sort()).toEqual(['split-left', 'split-right', obj2].sort());
  });
});
