import { describe, expect, it } from 'vitest';
import { polygonOverlaps, pointInPolygon, polygonSelfIntersects } from './geometry';
import {
  addDraftObject,
  createImage,
  defaultCategories,
  getLatestSubmitted,
  startRework,
  submitDraft,
  updateDraftObject,
} from './versioning';
import { createContour, createHole } from './versioning';
import { exportProject, importProject } from './exchange';
import type { ImageRecord, ProjectData } from '../types';

const cats = defaultCategories();

function imageWithObject(): ImageRecord {
  let img = createImage({ name: 'a.png', width: 100, height: 100, dataUrl: 'data:image/png;base64,STUB' });
  const r = addDraftObject(img, cats[0].id);
  img = r.image;
  img = updateDraftObject(img, r.objectId, (o) => {
    const outer = createContour([
      { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 },
    ]);
    outer.holes.push(
      createHole([
        { x: 30, y: 30 }, { x: 70, y: 30 }, { x: 70, y: 70 }, { x: 30, y: 70 },
      ]),
    );
    o.contours.push(outer);
  });
  return img;
}

describe('geometry', () => {
  it('detects crossing polygons and holes inside', () => {
    const square = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ];
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 50, y: 50 }, square)).toBe(false);
    const crossed = [
      { x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 },
    ];
    expect(polygonSelfIntersects(crossed)).toBe(true);
    expect(polygonOverlaps(square, [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }, { x: 5, y: 15 }])).toBe(true);
    expect(polygonOverlaps(square, [{ x: 20, y: 20 }, { x: 30, y: 20 }, { x: 30, y: 30 }, { x: 20, y: 30 }])).toBe(false);
  });
});

describe('versioning', () => {
  it('keeps object id stable across category change, submit and rework', () => {
    let img = imageWithObject();
    const objectId = img.versions[0].objects[0].id;
    img = updateDraftObject(img, objectId, (o) => {
      o.categoryId = cats[1].id;
      o.contours[0].points[0] = { x: 5, y: 5 };
    });
    img = submitDraft(img, 'first');
    expect(getLatestSubmitted(img)?.version).toBe(1);
    // 已提交版本冻结
    img = startRework(img);
    const draft = img.versions.find((v) => v.status === 'draft')!;
    expect(draft.version).toBe(2);
    expect(draft.basedOn).toBe(1);
    expect(draft.objects[0].id).toBe(objectId);
    expect(draft.objects[0].categoryId).toBe(cats[1].id);
    // 修改返工草稿不影响已冻结的 v1
    img = updateDraftObject(img, objectId, (o) => {
      o.categoryId = cats[2].id;
    });
    const v1 = img.versions.find((v) => v.version === 1)!;
    expect(v1.objects[0].categoryId).toBe(cats[1].id);
    expect(v1.status).toBe('submitted');
  });
});

describe('export/import', () => {
  it('round-trips submitted versions and preserves holes/categories', () => {
    let img = submitDraft(imageWithObject());
    const data = exportProject([img], cats);
    expect(data.images[0].submittedVersions).toHaveLength(1);
    const out = importProject(JSON.stringify(data), { existingImages: [], existingCategories: cats });
    expect(out.result.accepted).toEqual([img.id]);
    expect(out.result.issues).toHaveLength(0);
    const imported = out.images[0];
    expect(imported.versions[0].objects[0].contours[0].holes).toHaveLength(1);
    expect(imported.versions[0].status).toBe('submitted');
  });

  it('does not export drafts', () => {
    const img = imageWithObject();
    expect(exportProject([img], cats).images).toHaveLength(0);
  });

  it('reports missing image, crossing and corrupt records with location', () => {
    const good = submitDraft(imageWithObject());
    const data = exportProject([good], cats);
    const clone = JSON.parse(JSON.stringify(data)) as ProjectData;
    // 删除图片数据且本地不存在 -> MISSING_IMAGE
    delete clone.images[0].dataUrl;
    let out = importProject(JSON.stringify(clone), { existingImages: [], existingCategories: cats });
    expect(out.result.rejected).toContain(good.id);
    expect(out.result.issues.some((i) => i.code === 'MISSING_IMAGE' && i.imageId === good.id)).toBe(true);
    expect(out.images).toHaveLength(0);

    // 轮廓交叉 -> CONTOUR_CROSSING，逐图拒绝
    const crossed = JSON.parse(JSON.stringify(data)) as ProjectData;
    const objs = crossed.images[0].submittedVersions[0].objects;
    objs[0].contours[0].points = [
      { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 },
    ];
    const second = structuredClone(objs[0]);
    second.id = 'obj_second';
    second.contours[0].points = [
      { x: 50, y: 50 }, { x: 120, y: 50 }, { x: 120, y: 120 }, { x: 50, y: 120 },
    ];
    objs.push(second);
    out = importProject(JSON.stringify(crossed), { existingImages: [], existingCategories: cats });
    expect(out.result.issues.some((i) => i.code === 'CONTOUR_CROSSING')).toBe(true);
    expect(out.result.accepted).toHaveLength(0);

    // 整体损坏 JSON -> CORRUPT_RECORD，不抛异常
    out = importProject('{broken', { existingImages: [], existingCategories: cats });
    expect(out.result.issues[0].code).toBe('CORRUPT_RECORD');
  });

  it('one bad image does not overwrite other submitted results', () => {
    const goodA = submitDraft(imageWithObject());
    const goodB = submitDraft(imageWithObject());
    const local: ImageRecord[] = structuredClone([goodA, goodB]);
    const data = exportProject([goodA, goodB], cats);
    const clone = JSON.parse(JSON.stringify(data)) as ProjectData;
    // B 的记录被篡改：字段损坏
    (clone.images[1] as unknown) = { id: goodB.id, name: 'b.png' };
    const out = importProject(JSON.stringify(clone), { existingImages: local, existingCategories: cats });
    expect(out.result.accepted).toEqual([goodA.id]);
    expect(out.result.rejected).toEqual([goodB.id]);
    // 本地 B 的已提交结果仍然保留未被覆盖
    const keptB = out.images.find((i) => i.id === goodB.id)!;
    expect(keptB.versions.find((v) => v.status === 'submitted')?.objects).toHaveLength(1);
  });
});
