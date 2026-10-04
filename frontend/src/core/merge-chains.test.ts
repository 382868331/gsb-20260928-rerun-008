import { describe, expect, it } from 'vitest';
import {
  applyMergeSession,
  createMergeSession,
  planMerge,
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
import { exportProject, importProject } from './exchange';
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

describe('multi-generation merge chains', () => {
  it('merges tips of multi-generation chains without squashing intermediate commits', () => {
    const { img: base, obj1, obj2 } = baseImage();
    // 链 A 第一代 v2：obj1 拆成左右两半
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
    // 链 A 第二代 v3：右半再与邻区 obj2 合并为 merged-obj
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
    // 链 B v4：仍基于 v1 修改最早物体的类别与跨拆分边界的孔洞
    img = revise(img, 1, (objs) => {
      const obj = objs.find((o) => o.id === obj1)!;
      obj.categoryId = cats[2].id;
      obj.contours[0].holes[0].points[0] = { x: 35, y: 35 };
    });

    const plan = planMerge(img, 3, 4);
    expect(plan.baseVersion).toBe(1);
    const splitRel = plan.relations.find((r) => r.kind === 'split')!;
    const mergeRel = plan.relations.find((r) => r.kind === 'merge')!;
    expect(splitRel.sourceObjectIds).toEqual([obj1]);
    expect(splitRel.targetObjectIds.sort()).toEqual(['merged-obj', 'split-left']);
    expect(mergeRel.sourceObjectIds.sort()).toEqual([obj1, obj2].sort());

    // 允许只保存部分决定：先确认拆分，合并关系未确认时不能完成
    const session = createMergeSession(img, 3, 4);
    session.relations[splitRel.id] = 'confirmed';
    expect(() => applyMergeSession(img, session)).toThrow(/未确认/);

    session.relations[mergeRel.id] = 'confirmed';
    const sourceConflicts = planMerge(img, 3, 4).conflicts.filter((c) => c.dependsOn);
    // 同一编辑沿拆分与合并两条路径到达 merged-obj，只裁决一次
    const categoryConflicts = sourceConflicts.filter((c) => c.part === 'category');
    expect(categoryConflicts.map((c) => c.objectId).sort()).toEqual(['merged-obj', 'split-left']);
    expect(new Set(categoryConflicts.map((c) => c.id)).size).toBe(categoryConflicts.length);
    expect(sourceConflicts.filter((c) => c.part === 'hole').map((c) => c.objectId))
      .toEqual(['split-left']);
    for (const conflict of sourceConflicts) session.resolutions[conflict.id] = 'adopt-b';

    const out = applyMergeSession(img, session);
    const v = out.versions[out.versions.length - 1];
    // 中间物体 split-right 不重复输出，只有两个最终区域
    expect(v.objects.map((o) => o.id).sort()).toEqual(['merged-obj', 'split-left']);
    const left = v.objects.find((o) => o.id === 'split-left')!;
    const big = v.objects.find((o) => o.id === 'merged-obj')!;
    expect(left.categoryId).toBe(cats[2].id);
    expect(big.categoryId).toBe(cats[2].id);
    expect(left.contours[0].holes[0].points[0]).toEqual({ x: 35, y: 35 });
    expect(left.provenance?.sources.map((s) => s.objectId)).toEqual([obj1]);
    expect(big.provenance?.transformation).toBe('merge');
    expect(big.provenance?.sources.map((s) => s.objectId).sort()).toEqual([obj1, obj2].sort());
    // 原修订与已冻结合并的采用依据保持不变
    expect(v.mergeOf).toEqual({ base: 1, a: 3, b: 4 });
    expect(v.mergeAudit?.relations).toHaveLength(2);
    expect(img.versions.map((version) => version.version)).toEqual([1, 2, 3, 4]);
    expect(out.versions.slice(0, 4).map((version) => version.version)).toEqual([1, 2, 3, 4]);
  });

  it('export/import carries unfinished merge sessions so comparison can continue', () => {
    const { img: base, obj1 } = baseImage();
    let img = revise(base, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.categoryId = cats[1].id;
    });
    img = revise(img, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.categoryId = cats[2].id;
    });
    const session = createMergeSession(img, 2, 3);
    // 保存部分决定后导出
    session.resolutions['category:' + obj1] = 'adopt-a';
    const data = exportProject([img], cats, [session]);
    expect(data.mergeSessions).toHaveLength(1);

    const out = importProject(JSON.stringify(data), {
      existingImages: [],
      existingCategories: cats,
    });
    expect(out.result.accepted).toEqual([img.id]);
    expect(out.mergeSessions).toHaveLength(1);
    const restored = out.mergeSessions[0];
    expect(restored.resolutions['category:' + obj1]).toBe('adopt-a');
    // 重新导入后未完成的比较可以继续并完成
    const importedImg = out.images.find((i) => i.id === img.id)!;
    expect(planMerge(importedImg, restored.aVersion, restored.bVersion).conflicts)
      .toHaveLength(1);
    const mergedOut = applyMergeSession(importedImg, restored);
    expect(
      mergedOut.versions.at(-1)!.objects.find((o) => o.id === obj1)!.categoryId,
    ).toBe(cats[1].id);

    // 本地已有同图会话时保留本地进度，不被文件覆盖
    const again = importProject(JSON.stringify(data), {
      existingImages: out.images,
      existingCategories: out.categories,
      existingMergeSessions: [{ ...restored, resolutions: { ['category:' + obj1]: 'adopt-b' } }],
    });
    expect(again.mergeSessions.find((s) => s.imageId === img.id)!.resolutions['category:' + obj1])
      .toBe('adopt-b');
  });
});
