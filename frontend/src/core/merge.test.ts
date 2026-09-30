import { describe, expect, it } from 'vitest';
import {
  addDraftObject,
  createContour,
  createHole,
  createImage,
  defaultCategories,
  removeDraftObject,
  startRework,
  submitDraft,
  updateDraftObject,
} from './versioning';
import {
  cancelMerge,
  computeMerge,
  finalizeMerge,
  resolveMergeConflict,
  startMergeSession,
  unresolveMergeConflict,
} from './merge';
import type { ImageRecord } from '../types';

const cats = defaultCategories();

const square = (dx = 0) => [
  { x: 10 + dx, y: 10 }, { x: 90 + dx, y: 10 }, { x: 90 + dx, y: 90 }, { x: 10 + dx, y: 90 },
];
const hole = () => [
  { x: 30, y: 30 }, { x: 70, y: 30 }, { x: 70, y: 70 }, { x: 30, y: 70 },
];

/** v1 提交一个带轮廓+孔洞的物体，返回 [图片, 物体id, 轮廓id, 孔洞id] */
function baseImage(): [ImageRecord, string, string, string] {
  let img = createImage({ name: 'a.png', width: 100, height: 100 });
  const r = addDraftObject(img, cats[0].id);
  img = r.image;
  let ctrId = '';
  let holeId = '';
  img = updateDraftObject(img, r.objectId, (o) => {
    const c = createContour(square());
    const h = createHole(hole());
    c.holes.push(h);
    o.contours.push(c);
    ctrId = c.id;
    holeId = h.id;
  });
  img = submitDraft(img);
  return [img, r.objectId, ctrId, holeId];
}

/** 从指定版本返工、修改、提交 */
function revise(img: ImageRecord, from: number, fn: (img: ImageRecord) => ImageRecord): ImageRecord {
  return submitDraft(fn(startRework(img, undefined, from)));
}

function twoRevisions(): { img: ImageRecord; objId: string; ctrId: string; holeId: string } {
  const [v1, objId, ctrId, holeId] = baseImage();
  // 左侧 v2：改类别 + 移动轮廓
  let img = revise(v1, 1, (i) =>
    updateDraftObject(i, objId, (o) => {
      o.categoryId = cats[1].id;
      o.contours[0].points = square(5);
    }),
  );
  // 右侧 v3：修改孔洞 + 新增一个物体
  img = revise(img, 1, (i) => {
    let next = updateDraftObject(i, objId, (o) => {
      o.contours[0].holes[0].points = hole().map((p) => ({ x: p.x + 2, y: p.y }));
    });
    const added = addDraftObject(next, cats[2].id);
    next = updateDraftObject(added.image, added.objectId, (o) => {
      o.contours.push(createContour(square(200)));
    });
    return next;
  });
  return { img, objId, ctrId, holeId };
}

describe('三方合并', () => {
  it('互不冲突的修改一起保留，物体 id 稳定，mergeOf 记录两条来源', () => {
    const { img, objId } = twoRevisions();
    const merged = finalizeMerge(startMergeSession(img, 2, 3), '合并返工');
    const v4 = merged.versions.find((v) => v.version === 4)!;
    expect(v4.status).toBe('submitted');
    expect(v4.mergeOf).toEqual([2, 3]);
    expect(v4.basedOn).toBe(1);
    const obj = v4.objects.find((o) => o.id === objId)!;
    expect(obj.categoryId).toBe(cats[1].id); // 左侧类别
    expect(obj.contours[0].points[0].x).toBe(15); // 左侧轮廓
    expect(obj.contours[0].holes[0].points[0].x).toBe(32); // 右侧孔洞
    expect(v4.objects).toHaveLength(2); // 右侧新增物体保留
    // 旧提交不可改写
    expect(merged.versions.find((v) => v.version === 2)).toEqual(img.versions.find((v) => v.version === 2));
    expect(merged.versions.find((v) => v.version === 3)).toEqual(img.versions.find((v) => v.version === 3));
  });

  it('同一部分的不同修改产生冲突，逐项确认，可撤回单项而不丢其他决定', () => {
    const [v1, objId, ctrId] = baseImage();
    // 左右两侧都改类别（不同值）且都改轮廓（不同点）
    let img = revise(v1, 1, (i) =>
      updateDraftObject(i, objId, (o) => {
        o.categoryId = cats[1].id;
        o.contours[0].points = square(5);
      }),
    );
    img = revise(img, 1, (i) =>
      updateDraftObject(i, objId, (o) => {
        o.categoryId = cats[2].id;
        o.contours[0].points = square(9);
      }),
    );
    let m = startMergeSession(img, 2, 3);
    const s = m.mergeSession!;
    expect(s.conflicts.map((c) => c.kind).sort()).toEqual(['category', 'contour-points']);
    // 未全部确认不能提交
    m = resolveMergeConflict(m, `obj:${objId}:category`, 'left');
    expect(() => finalizeMerge(m)).toThrow(/未确认/);
    m = resolveMergeConflict(m, `obj:${objId}:ctr:${ctrId}:points`, 'right');
    // 撤回类别确认：轮廓确认保留
    m = unresolveMergeConflict(m, `obj:${objId}:category`);
    expect(m.mergeSession!.resolutions[`obj:${objId}:ctr:${ctrId}:points`]).toBe('right');
    expect(m.mergeSession!.resolutions[`obj:${objId}:category`]).toBeUndefined();
    expect(() => finalizeMerge(m)).toThrow(/未确认/);
    // 重新确认后完成
    m = resolveMergeConflict(m, `obj:${objId}:category`, 'right');
    const done = finalizeMerge(m);
    const obj = done.versions.at(-1)!.objects.find((o) => o.id === objId)!;
    expect(obj.categoryId).toBe(cats[2].id);
    expect(obj.contours[0].points[0].x).toBe(19);
    expect(done.mergeSession).toBeNull();
  });

  it('删除物体与修改其孔洞同时发生时产生冲突，不静默吞掉任何一方', () => {
    const [v1, objId] = baseImage();
    // 左侧删除物体；右侧修改它的孔洞
    let img = revise(v1, 1, (i) => removeDraftObject(i, objId));
    img = revise(img, 1, (i) =>
      updateDraftObject(i, objId, (o) => {
        o.contours[0].holes[0].points = hole().map((p) => ({ x: p.x + 3, y: p.y }));
      }),
    );
    let m = startMergeSession(img, 2, 3);
    const conflict = m.mergeSession!.conflicts.find((c) => c.kind === 'object-delete-vs-modify')!;
    expect(conflict).toBeDefined();
    expect(conflict.left).toBeNull();
    // 选左侧：物体被删除
    const dropped = finalizeMerge(resolveMergeConflict(m, conflict.id, 'left'));
    expect(dropped.versions.at(-1)!.objects.find((o) => o.id === objId)).toBeUndefined();
    // 选右侧：物体保留且孔洞是右侧修改后的
    m = startMergeSession(img, 2, 3);
    const kept = finalizeMerge(resolveMergeConflict(m, conflict.id, 'right'));
    const obj = kept.versions.at(-1)!.objects.find((o) => o.id === objId)!;
    expect(obj.contours[0].holes[0].points[0].x).toBe(33);
  });

  it('一侧删除、另一侧未动时按删除处理（无冲突）；双方各自新增全部保留', () => {
    const [v1, objId] = baseImage();
    let img = revise(v1, 1, (i) => removeDraftObject(i, objId));
    img = revise(img, 1, (i) => {
      const added = addDraftObject(i, cats[2].id);
      return updateDraftObject(added.image, added.objectId, (o) => {
        o.contours.push(createContour(square(300)));
      });
    });
    const m = startMergeSession(img, 2, 3);
    expect(m.mergeSession!.conflicts).toHaveLength(0);
    const done = finalizeMerge(m);
    const objects = done.versions.at(-1)!.objects;
    expect(objects.find((o) => o.id === objId)).toBeUndefined();
    expect(objects).toHaveLength(1);
  });

  it('合并会话可中途保存再打开继续（会话与确认状态随图片记录持久化）', () => {
    const { img, objId } = twoRevisions();
    let m = startMergeSession(img, 2, 3);
    m = cancelMerge(m);
    expect(m.mergeSession).toBeNull();
    // 重新发起后冲突 id 稳定，可继续处理
    m = startMergeSession(m, 2, 3);
    const reopened = JSON.parse(JSON.stringify(m)) as ImageRecord;
    expect(reopened.mergeSession!.conflicts).toEqual(m.mergeSession!.conflicts);
    const done = finalizeMerge(reopened);
    expect(done.versions.at(-1)!.objects.find((o) => o.id === objId)).toBeDefined();
  });

  it('拒绝不合规的合并来源', () => {
    const { img } = twoRevisions();
    expect(() => startMergeSession(img, 2, 2)).toThrow(/同一个版本/);
    // v4 基于 v3，与基于 v1 的 v2 不能合并
    const v4 = revise(img, 3, (i) => i);
    expect(() => startMergeSession(v4, 2, 4)).toThrow(/同一版本/);
  });

  it('computeMerge 未确认时使用占位值，确认后生效', () => {
    const base = [{ id: 'o1', categoryId: 'a', contours: [], createdAt: '', updatedAt: '' }];
    const left = [{ ...base[0], categoryId: 'b' }];
    const right = [{ ...base[0], categoryId: 'c' }];
    const r1 = computeMerge(base, left, right, {});
    expect(r1.unresolved).toHaveLength(1);
    const r2 = computeMerge(base, left, right, { 'obj:o1:category': 'right' });
    expect(r2.unresolved).toHaveLength(0);
    expect(r2.objects[0].categoryId).toBe('c');
  });
});
