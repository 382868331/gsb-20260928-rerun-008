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
import { importProject } from './exchange';
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

  it('rejects ancestor-descendant pairs', () => {
    const { img: base } = baseImage();
    let img = revise(base, 1, () => {});
    img = revise(img, 2, () => {}); // v3 基于 v2，而 v2 基于 v1
    expect(() => resolveMergeBase(img, 2, 3)).toThrow(/祖先|后代/);
  });

  it('resolves a merge across multi-generation branches from their common ancestor', () => {
    const { img: root, obj1, obj2 } = baseImage();
    let img = revise(root, 1, (objs) => {
      const i = objs.findIndex((o) => o.id === obj1);
      const createdAt = new Date().toISOString();
      objs.splice(i, 1, {
        id: 'split-left', categoryId: cats[0].id, createdAt, updatedAt: createdAt,
        contours: [createContour([{ x: 10, y: 10 }, { x: 70, y: 10 }, { x: 70, y: 90 }, { x: 10, y: 90 }])],
      }, {
        id: 'split-right', categoryId: cats[0].id, createdAt, updatedAt: createdAt,
        contours: [createContour([{ x: 70, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 70, y: 90 }])],
      });
    });
    img = revise(img, 2, (objs) => {
      const createdAt = new Date().toISOString();
      objs.splice(0, objs.length, objs.find((o) => o.id === 'split-left')!, {
        id: 'merged-obj', categoryId: cats[1].id, createdAt, updatedAt: createdAt,
        contours: [createContour([{ x: 70, y: 10 }, { x: 190, y: 10 }, { x: 190, y: 190 }, { x: 70, y: 190 }])],
      });
    });
    img = revise(img, 1, (objs) => {
      const obj = objs.find((o) => o.id === obj1)!;
      obj.categoryId = cats[2].id;
      obj.contours[0].holes[0].points[0] = { x: 35, y: 35 };
    });
    expect(resolveMergeBase(img, 3, 4)).toBe(1);
    const plan = planMerge(img, 3, 4);
    const relations = plan.relations.filter((r) => r.side === 'a');
    expect(relations.map((r) => [r.fromVersion, r.toVersion, r.kind])).toEqual([
      [1, 2, 'split'],
      [2, 3, 'merge'],
    ]);
    expect(relations[1].rootSourceObjectIds?.sort()).toEqual([obj1, obj2].sort());
    const session = createMergeSession(img, 3, 4);
    for (const relation of plan.relations) session.relations[relation.id] = 'confirmed';
    for (const conflict of planMerge(img, 3, 4).conflicts.filter((c) => c.dependsOn)) {
      session.resolutions[conflict.id] = 'adopt-b';
    }
    const v = merged(img, session);
    expect(v.mergeOf).toEqual({ base: 1, a: 3, b: 4 });
    expect(v.objects.map((o) => o.id).sort()).toEqual(['merged-obj', 'split-left']);
    const big = v.objects.find((o) => o.id === 'merged-obj')!;
    expect(big.provenance?.sources.map((s) => s.objectId).sort()).toEqual([obj1, obj2].sort());
    expect(v.objects.find((o) => o.id === 'split-left')!.categoryId).toBe(cats[2].id);
    expect(big.categoryId).toBe(cats[2].id);
    expect(v.objects.find((o) => o.id === 'split-left')!.contours[0].holes[0].points[0]).toEqual({ x: 35, y: 35 });
    expect(big.contours[0].holes).toEqual([]);
    expect(Object.keys(session.resolutions).some((id) => id.includes('split-right'))).toBe(false);
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

  it('traces sources across chained split-then-merge while the other side edits the original', () => {
    const { img: base, obj1, obj2 } = baseImage();
    // 修订 A：obj1 先拆成左右两半，右半又与 obj2 合并为 merged-obj
    let img = revise(base, 1, (objs) => {
      const createdAt = new Date().toISOString();
      objs.splice(0, objs.length,
        {
          id: 'split-left', categoryId: cats[0].id, createdAt, updatedAt: createdAt,
          contours: [createContour([{ x: 10, y: 10 }, { x: 70, y: 10 }, { x: 70, y: 90 }, { x: 10, y: 90 }])],
        },
        {
          id: 'merged-obj', categoryId: cats[1].id, createdAt, updatedAt: createdAt,
          contours: [createContour([{ x: 70, y: 10 }, { x: 190, y: 10 }, { x: 190, y: 190 }, { x: 70, y: 190 }])],
        },
      );
    });
    // 修订 B：仍在修改最早物体 obj1 的类别和孔洞
    img = revise(img, 1, (objs) => {
      const obj = objs.find((o) => o.id === obj1)!;
      obj.categoryId = cats[2].id;
      obj.contours[0].holes[0].points[0] = { x: 35, y: 35 };
    });
    const plan = planMerge(img, 2, 3);
    const splitRel = plan.relations.find((r) => r.kind === 'split')!;
    const mergeRel = plan.relations.find((r) => r.kind === 'merge')!;
    expect(splitRel.sourceObjectIds).toEqual([obj1]);
    expect(mergeRel.sourceObjectIds.sort()).toEqual([obj1, obj2].sort());

    // 允许只确认来源链的一部分后保存继续：仅确认拆分，合并关系留待以后
    const session = createMergeSession(img, 2, 3);
    session.relations[splitRel.id] = 'confirmed';
    expect(() => applyMergeSession(img, session)).toThrow(/未确认/);

    session.relations[mergeRel.id] = 'confirmed';
    const sourceConflicts = planMerge(img, 2, 3).conflicts.filter((c) => c.dependsOn);
    // B 对 obj1 的类别修改映射到两个最终区域；孔洞修改只映射到包含它的 split-left
    expect(sourceConflicts.filter((c) => c.part === 'category').map((c) => c.objectId).sort())
      .toEqual(['merged-obj', 'split-left']);
    expect(sourceConflicts.filter((c) => c.part === 'hole').map((c) => c.objectId))
      .toEqual(['split-left']);
    for (const conflict of sourceConflicts) session.resolutions[conflict.id] = 'adopt-b';

    const v = merged(img, session);
    // 中间物体（拆分出的右半）不重复导出，只有两个最终区域
    expect(v.objects.map((o) => o.id).sort()).toEqual(['merged-obj', 'split-left']);
    const left = v.objects.find((o) => o.id === 'split-left')!;
    const big = v.objects.find((o) => o.id === 'merged-obj')!;
    expect(left.provenance?.sources.map((s) => s.objectId)).toEqual([obj1]);
    expect(big.provenance?.transformation).toBe('merge');
    expect(big.provenance?.sources.map((s) => s.objectId).sort()).toEqual([obj1, obj2].sort());
    expect(left.categoryId).toBe(cats[2].id);
    expect(big.categoryId).toBe(cats[2].id);
    expect(left.contours[0].holes[0].points[0]).toEqual({ x: 35, y: 35 });
    // 原修订与合并审计均可追溯
    expect(v.mergeOf).toEqual({ base: 1, a: 2, b: 3 });
    expect(img.versions.map((version) => version.version)).toEqual([1, 2, 3]);
  });

  it('continues a partially resolved merge after export and reimport', () => {
    const { img: base, obj1, obj2 } = baseImage();
    let img = revise(base, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.categoryId = cats[2].id;
      objs.find((o) => o.id === obj2)!.categoryId = cats[0].id;
    });
    img = revise(img, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.categoryId = cats[1].id;
      objs.find((o) => o.id === obj2)!.categoryId = cats[2].id;
    });
    const session = createMergeSession(img, 2, 3);
    session.resolutions['category:' + obj1] = 'a';
    const data = exportProject([img], cats, [session]);
    const imported = importProject(JSON.stringify(data), {
      existingImages: [structuredClone(base)],
      existingCategories: cats,
    });
    const restored = imported.mergeSessions[0];
    expect(imported.result.issues).toEqual([]);
    expect(imported.images[0].versions.map((version) => version.version)).toEqual([1, 2, 3]);
    expect(restored.baseVersion).toBe(1);
    expect(restored.resolutions['category:' + obj1]).toBe('a');
    const restoredImage = imported.images[0];
    expect(planMerge(restoredImage, restored.aVersion, restored.bVersion).conflicts).toHaveLength(2);
  });
});
