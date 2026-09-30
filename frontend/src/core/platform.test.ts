import { describe, expect, it } from 'vitest';
import { exportProject, importBundle, parseBundleText, serializeBundle } from './exchange';
import {
  addContour,
  addObject,
  createProject,
  ensureDraft,
  latestVersion,
  setObjectCategory,
  startReworkFromVersion,
  submitDraft,
  updateContourPoints,
} from './project';
import type { ExportBundleV1, Point, Project } from './types';

const CATEGORIES = ['person', 'vehicle'];

function rectPoints(x: number, y: number, w: number, h: number): Point[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

function seededProject(): Project {
  let project = createProject('p', CATEGORIES, '2026-01-01T00:00:00.000Z');
  const imageId = 'img_seed';
  project = {
    ...project,
    images: [
      {
        image: {
          imageId,
          name: 'seed.png',
          width: 100,
          height: 100,
          checksum: 'fnv1a-seed',
          dataUrl: 'data:image/png;base64,c2VlZA==',
          importedAt: '2026-01-01T00:00:00.000Z',
        },
        draft: null,
        versions: [],
      },
    ],
  };
  return project;
}

describe('标注与版本', () => {
  it('修改类别与轮廓不改变 objectId，同一物体支持多外轮廓与孔洞', () => {
    let project = seededProject();
    const imageId = 'img_seed';
    project = addObject(project, imageId, 'person');
    const objectId = project.images[0].draft!.objects[0].objectId;

    project = addContour(project, imageId, objectId, 'outer', rectPoints(10, 10, 40, 40));
    project = addContour(project, imageId, objectId, 'outer', rectPoints(60, 60, 20, 20));
    project = addContour(project, imageId, objectId, 'hole', rectPoints(15, 15, 10, 10));
    const firstContourId = project.images[0].draft!.objects[0].contours[0].contourId;

    project = setObjectCategory(project, imageId, objectId, 'vehicle');
    project = updateContourPoints(
      project,
      imageId,
      objectId,
      firstContourId,
      rectPoints(12, 12, 36, 36),
    );

    const object = project.images[0].draft!.objects[0];
    expect(object.objectId).toBe(objectId);
    expect(object.category).toBe('vehicle');
    expect(object.contours).toHaveLength(3);
    expect(object.contours.filter((c) => c.type === 'outer')).toHaveLength(2);
    expect(object.contours.filter((c) => c.type === 'hole')).toHaveLength(1);
  });

  it('提交后版本冻结，返工生成新版本且历史不变', () => {
    let project = seededProject();
    const imageId = 'img_seed';
    project = addObject(project, imageId, 'person');
    const objectId = project.images[0].draft!.objects[0].objectId;
    project = addContour(project, imageId, objectId, 'outer', rectPoints(10, 10, 30, 30));
    project = submitDraft(project, imageId);

    const v1 = project.images[0].versions[0];
    expect(Object.isFrozen(v1)).toBe(true);
    expect(Object.isFrozen(v1.objects)).toBe(true);
    expect(() => {
      (v1 as { objects: unknown[] }).objects = [];
    }).toThrow();

    project = ensureDraft(project, imageId);
    project = setObjectCategory(project, imageId, objectId, 'vehicle');
    project = submitDraft(project, imageId);
    expect(project.images[0].versions).toHaveLength(2);
    expect(project.images[0].versions[0].objects[0].category).toBe('person');
    expect(project.images[0].versions[1].objects[0].category).toBe('vehicle');
    expect(project.images[0].versions[1].objects[0].objectId).toBe(objectId);
    expect(project.images[0].versions[1].basedOnVersionId).toBe(v1.versionId);

    project = startReworkFromVersion(project, imageId, v1.versionId);
    expect(project.images[0].draft?.basedOnVersionId).toBe(v1.versionId);
    expect(project.images[0].draft?.objects[0].category).toBe('person');
  });
});

describe('导出再导入核对', () => {
  it('轮廓、孔洞、类别与版本原样恢复', async () => {
    let project = seededProject();
    const imageId = 'img_seed';
    project = addObject(project, imageId, 'person');
    const objectId = project.images[0].draft!.objects[0].objectId;
    project = addContour(project, imageId, objectId, 'outer', rectPoints(10, 10, 50, 50));
    project = addContour(project, imageId, objectId, 'hole', rectPoints(20, 20, 10, 10));
    project = submitDraft(project, imageId);
    const original = latestVersion(project.images[0])!;

    const bundle = parseBundleText(serializeBundle(exportProject(project))) as ExportBundleV1;
    const empty = createProject('target', [], '2026-02-01T00:00:00.000Z');
    const result = await importBundle(empty, bundle, {
      checksumOf: async () => 'fnv1a-seed',
    });

    expect(result.issues).toEqual([]);
    expect(result.imported).toBe(1);
    const restored = result.project.images[0];
    expect(restored.versions).toHaveLength(1);
    expect(restored.versions[0].versionId).toBe(original.versionId);
    expect(restored.versions[0].objects).toEqual(original.objects);
    expect(Object.isFrozen(restored.versions[0])).toBe(true);
  });

  it('缺图、轮廓交叉、损坏记录逐张定位，坏图不覆盖其他已提交结果', async () => {
    const good = {
      imageId: 'img_good',
      name: 'good.png',
      width: 200,
      height: 200,
      checksum: 'fnv1a-good',
      versionId: 'ver_good_1',
      versionNo: 1,
      basedOnVersionId: null,
      submittedAt: '2026-03-01T00:00:00.000Z',
      dataUrl: 'data:image/png;base64,Z29vZA==',
      objects: [
        {
          objectId: 'obj_good',
          category: 'person',
          contours: [
            { contourId: 'ctr_good_outer', type: 'outer', points: rectPoints(10, 10, 50, 50) },
            { contourId: 'ctr_good_hole', type: 'hole', points: rectPoints(20, 20, 10, 10) },
          ],
        },
      ],
    };
    const missingImage = {
      imageId: 'img_missing',
      name: 'missing.png',
      width: 200,
      height: 200,
      checksum: 'fnv1a-missing',
      versionId: 'ver_missing_1',
      versionNo: 1,
      basedOnVersionId: null,
      submittedAt: '2026-03-01T00:00:00.000Z',
      objects: [
        {
          objectId: 'obj_missing',
          category: 'person',
          contours: [
            { contourId: 'ctr_missing', type: 'outer', points: rectPoints(0, 0, 10, 10) },
          ],
        },
      ],
    };
    const crossing = {
      ...good,
      imageId: 'img_cross',
      name: 'cross.png',
      checksum: 'fnv1a-cross',
      dataUrl: 'data:image/png;base64,Y3Jvc3M=',
      versionId: 'ver_cross_1',
      objects: [
        {
          objectId: 'obj_cross',
          category: 'person',
          contours: [
            { contourId: 'ctr_a', type: 'outer', points: rectPoints(0, 10, 40, 20) },
            { contourId: 'ctr_b', type: 'outer', points: rectPoints(10, 0, 20, 40) },
          ],
        },
      ],
    };
    const corrupt = {
      imageId: 'img_corrupt',
      name: 'corrupt.png',
      width: 10,
      height: 10,
      checksum: 'fnv1a-corrupt',
      versionId: 'ver_corrupt_1',
      versionNo: 1,
      basedOnVersionId: null,
      submittedAt: '2026-03-01T00:00:00.000Z',
      objects: [{ objectId: 'obj_broken' }],
    };

    const bundle: ExportBundleV1 = {
      format: 'image-annotation-bundle',
      formatVersion: 1,
      exportedAt: '2026-03-02T00:00:00.000Z',
      projectId: 'prj_x',
      name: 'mix',
      categories: CATEGORIES,
      images: [good, missingImage, crossing, corrupt] as ExportBundleV1['images'],
    };

    const before = createProject('target', CATEGORIES, '2026-02-01T00:00:00.000Z');
    const first = await importBundle(before, bundle, {
      checksumOf: async () => 'fnv1a-good',
    });
    expect(first.imported).toBe(1);
    expect(first.issues.map((i) => i.code).sort()).toEqual([
      'CONTOURS_CROSS',
      'CORRUPT_RECORD',
      'MISSING_IMAGE',
    ]);
    expect(first.issues.map((i) => i.index)).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(first.project.images.map((r) => r.image.imageId)).toEqual(['img_good']);

    const second = await importBundle(first.project, bundle, {
      checksumOf: async () => 'fnv1a-good',
    });
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect(second.project.images[0].versions).toHaveLength(1);
  });
});
