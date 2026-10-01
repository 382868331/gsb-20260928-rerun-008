import { describe, expect, it } from 'vitest';
import { planMergeWithRelations } from './merge';
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
  img = updateDraftObject(img, r1.objectId, (o) => {
    o.contours.push(createContour([
      { x: 110, y: 10 }, { x: 180, y: 10 }, { x: 180, y: 80 }, { x: 110, y: 80 },
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
    const { img: base, obj1 } = baseImage();
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

  it('tracks split sources, maps category/hole edits to parts, and undo reopens only dependencies', () => {
    const { img: base, obj1, obj2 } = baseImage();
    const source = base.versions[0].objects.find((o) => o.id === obj1)!;
    const c0 = source.contours[0].id;
    const h0 = source.contours[0].holes[0].id;
    const c1 = source.contours[1].id;
    const newId = 'obj_split_part';

    let img = revise(base, 1, (objs) => {
      const old = objs.find((o) => o.id === obj1)!;
      const moved = old.contours.splice(1, 1)[0];
      moved.origin = { version: 1, objectId: obj1, contourId: c1 };
      old.contours[0].origin = { version: 1, objectId: obj1, contourId: c0 };
      old.origins = [old.contours[0].origin];
      objs.push({
        ...old,
        id: newId,
        contours: [moved],
        origins: [moved.origin],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      objs.find((o) => o.id === obj2)!.categoryId = cats[2].id;
    });
    const splitVersion = img.versions.at(-1)!;
    splitVersion.objectTransforms = [{
      id: 'split-test', kind: 'split', sourceObjectIds: [obj1], targetObjectIds: [obj1, newId],
      mappings: [
        { sourceObjectId: obj1, sourceContourId: c0, targetObjectId: obj1, targetContourId: c0, holes: [{ sourceHoleId: h0, targetHoleId: h0 }] },
        { sourceObjectId: obj1, sourceContourId: c1, targetObjectId: newId, targetContourId: c1, holes: [] },
      ],
      createdAt: new Date().toISOString(),
    }];

    img = revise(img, 1, (objs) => {
      const old = objs.find((o) => o.id === obj1)!;
      old.categoryId = cats[1].id;
      old.contours[0].holes[0].points[0] = { x: 34, y: 34 };
      objs.find((o) => o.id === obj2)!.categoryId = cats[0].id;
    });

    const session = createMergeSession(img, 2, 3);
    let plan = planMerge(img, 2, 3);
    expect(plan.conflicts.map((c) => c.part)).toEqual(['split-relation']);
    const relationId = plan.conflicts[0].id;
    expect(() => applyMergeSession(img, session)).toThrow(/未确认/);

    session.relations[relationId] = 'a';
    plan = planMergeWithRelations(img, 2, 3, session.relations);
    expect(plan.conflicts.filter((c) => c.relationId === relationId).map((c) => c.objectId).sort()).toEqual([newId, obj1, obj1].sort());
    expect(plan.conflicts.some((c) => c.part === 'hole' && c.objectId === obj1 && c.holeId === h0)).toBe(true);
    expect(plan.conflicts.some((c) => c.part === 'category' && c.objectId === newId)).toBe(true);
    expect(plan.conflicts.some((c) => c.objectId === obj2)).toBe(true);

    for (const conflict of plan.conflicts) {
      session.resolutions[conflict.id] = conflict.part === 'hole' ? 'b' : 'a';
    }
    expect(() => applyMergeSession(img, session)).not.toThrow();
    delete session.relations[relationId];
    session.resolutions = {};
    session.relations[relationId] = 'a';
    for (const conflict of planMergeWithRelations(img, 2, 3, session.relations).conflicts) session.resolutions[conflict.id] = 'a';
    expect(session.resolutions['category:' + obj2]).toBeDefined();
    const dependentIds = planMergeWithRelations(img, 2, 3, session.relations).conflicts
      .filter((c) => c.relationId === relationId)
      .map((c) => c.id);
    delete session.relations[relationId];
    session.resolutions = Object.fromEntries(Object.entries(session.resolutions).filter(([id]) => !dependentIds.includes(id)));
    expect(session.resolutions['category:' + obj1]).toBeUndefined();
    expect(session.resolutions['category:' + newId]).toBeUndefined();
    expect(session.resolutions['category:' + obj2]).toBe('a');

    session.relations[relationId] = 'a';
    for (const conflict of planMergeWithRelations(img, 2, 3, session.relations).conflicts.filter((c) => !session.resolutions[c.id])) {
      session.resolutions[conflict.id] = conflict.part === 'hole' ? 'b' : 'a';
    }
    const v = merged(img, session);
    const parts = v.objects.filter((o) => o.id === obj1 || o.id === newId);
    expect(parts).toHaveLength(2);
    expect(parts.flatMap((o) => o.origins ?? []).map((o) => o.contourId).sort()).toEqual([c0, c1]);
    expect(parts.find((o) => o.id === obj1)!.contours[0].holes).toHaveLength(1);
    expect(parts.find((o) => o.id === obj1)!.contours[0].holes[0].points[0]).toEqual({ x: 34, y: 34 });
    expect(v.mergeAudit?.relationChoices[0].id).toBe(relationId);
  });

  it('tracks merged object sources and keeps holes attached to their original outlines', () => {
    const { img: base, obj1, obj2 } = baseImage();
    const c1 = base.versions[0].objects.find((o) => o.id === obj1)!.contours[0].id;
    const c2 = base.versions[0].objects.find((o) => o.id === obj2)!.contours[0].id;
    const h1 = base.versions[0].objects.find((o) => o.id === obj1)!.contours[0].holes[0].id;
    let img = revise(base, 1, (objs) => {
      const first = objs.find((o) => o.id === obj1)!;
      const second = objs.splice(objs.findIndex((o) => o.id === obj2), 1)[0];
      first.contours.push(...second.contours);
      first.origins = first.contours.map((c) => ({ version: 1, objectId: c === first.contours[0] ? obj1 : obj2, contourId: c.id }));
    });
    img.versions.at(-1)!.objectTransforms = [{
      id: 'merge-test', kind: 'merge', sourceObjectIds: [obj1, obj2], targetObjectIds: [obj1],
      mappings: [
        { sourceObjectId: obj1, sourceContourId: c1, targetObjectId: obj1, targetContourId: c1, holes: [{ sourceHoleId: h1, targetHoleId: h1 }] },
        { sourceObjectId: obj2, sourceContourId: c2, targetObjectId: obj1, targetContourId: c2, holes: [] },
      ],
      createdAt: new Date().toISOString(),
    }];
    img = revise(img, 1, (objs) => {
      objs.find((o) => o.id === obj1)!.contours[0].holes[0].points[0] = { x: 36, y: 36 };
      objs.find((o) => o.id === obj2)!.contours[0].points[1] = { x: 188, y: 110 };
    });
    const session = createMergeSession(img, 2, 3);
    const relationId = planMerge(img, 2, 3).conflicts[0].id;
    session.relations[relationId] = 'a';
    const v = merged(img, session);
    const mergedObj = v.objects.find((o) => o.id === obj1)!;
    expect(v.objects.some((o) => o.id === obj2)).toBe(false);
    expect(mergedObj.contours.map((c) => c.origin?.objectId)).toEqual([obj1, obj2]);
    expect(mergedObj.contours[0].holes).toHaveLength(1);
    expect(mergedObj.contours[0].holes[0].origin).toMatchObject({ objectId: obj1, contourId: c1, holeId: h1 });
    expect(mergedObj.contours[1].points[1]).toEqual({ x: 188, y: 110 });
  });
});
