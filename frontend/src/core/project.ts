import { newContourId, newObjectId, newProjectId } from './ids';
import type {
  AnnotationObject,
  AnnotationVersion,
  Contour,
  ContourType,
  Draft,
  ImageAsset,
  ImageRecord,
  Point,
  Project,
} from './types';

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/** 已提交版本冻结，任何尝试修改都会在开发期立即暴露 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object') deepFreeze(child);
    }
  }
  return value;
}

export function createProject(name: string, categories: string[], now: string = new Date().toISOString()): Project {
  return {
    projectId: newProjectId(),
    name: name || '未命名标注项目',
    categories: [...new Set(categories)],
    images: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function addImage(project: Project, asset: ImageAsset, now: string = new Date().toISOString()): Project {
  const record: ImageRecord = { image: asset, draft: null, versions: [] };
  return { ...project, images: [...project.images, record], updatedAt: now };
}

export function addCategory(project: Project, category: string, now: string = new Date().toISOString()): Project {
  const trimmed = category.trim();
  if (!trimmed || project.categories.includes(trimmed)) return project;
  return { ...project, categories: [...project.categories, trimmed], updatedAt: now };
}

function indexOfImage(project: Project, imageId: string): number {
  const index = project.images.findIndex((record) => record.image.imageId === imageId);
  if (index < 0) throw new Error(`图片不存在：${imageId}`);
  return index;
}

/** 没有草稿时基于空对象集创建草稿；已有草稿则原样返回（用于继续调整） */
export function ensureDraft(project: Project, imageId: string, now: string = new Date().toISOString()): Project {
  const index = indexOfImage(project, imageId);
  const record = project.images[index];
  if (record.draft) return project;
  const draft: Draft = {
    basedOnVersionId: record.versions.length > 0
      ? record.versions[record.versions.length - 1].versionId
      : null,
    objects: record.versions.length > 0
      ? deepClone(record.versions[record.versions.length - 1].objects)
      : [],
    updatedAt: now,
  };
  return replaceRecord(project, index, { ...record, draft });
}

/**
 * 从指定的已提交版本发起返工：复制其内容到新草稿，objectId 保持不变。
 * 已提交版本本身不可变。
 */
export function startReworkFromVersion(project: Project, imageId: string, versionId: string,
  now: string = new Date().toISOString()): Project {
  const index = indexOfImage(project, imageId);
  const record = project.images[index];
  const base = record.versions.find((v) => v.versionId === versionId);
  if (!base) throw new Error(`版本不存在：${versionId}`);
  const draft: Draft = {
    basedOnVersionId: base.versionId,
    objects: deepClone(base.objects),
    updatedAt: now,
  };
  return replaceRecord(project, index, { ...record, draft });
}

export function discardDraft(project: Project, imageId: string): Project {
  const index = indexOfImage(project, imageId);
  const record = project.images[index];
  if (!record.draft) return project;
  return replaceRecord(project, index, { ...record, draft: null });
}

function replaceRecord(project: Project, index: number, record: ImageRecord, now: string = new Date().toISOString()): Project {
  const images = project.images.slice();
  images[index] = record;
  return { ...project, images, updatedAt: now };
}

function withDraft(
  project: Project,
  imageId: string,
  mutate: (objects: AnnotationObject[]) => AnnotationObject[],
  now: string = new Date().toISOString(),
): Project {
  const next = ensureDraft(project, imageId, now);
  const index = indexOfImage(next, imageId);
  const record = next.images[index];
  if (!record.draft) throw new Error('草稿创建失败');
  const objects = mutate(deepClone(record.draft.objects));
  const draft: Draft = { ...record.draft, objects, updatedAt: now };
  return replaceRecord(next, index, { ...record, draft }, now);
}

/** 新增物体：生成新 objectId；修改类别/轮廓不会改变 objectId */
export function addObject(project: Project, imageId: string, category: string,
  now: string = new Date().toISOString()): Project {
  return withDraft(project, imageId, (objects) => {
    const object: AnnotationObject = {
      objectId: newObjectId(),
      category,
      contours: [],
    };
    return [...objects, object];
  }, now);
}

export function removeObject(project: Project, imageId: string, objectId: string,
  now: string = new Date().toISOString()): Project {
  return withDraft(project, imageId, (objects) =>
    objects.filter((object) => object.objectId !== objectId), now);
}

/** 修改类别：objectId 与轮廓均保持不变 */
export function setObjectCategory(project: Project, imageId: string, objectId: string, category: string,
  now: string = new Date().toISOString()): Project {
  return withDraft(project, imageId, (objects) => objects.map((object) =>
    object.objectId === objectId ? { ...object, category } : object), now);
}

export function addContour(project: Project, imageId: string, objectId: string, type: ContourType,
  points: Point[], now: string = new Date().toISOString()): Project {
  const contour: Contour = { contourId: newContourId(), type, points: points.map((p) => ({ ...p })) };
  return withDraft(project, imageId, (objects) => objects.map((object) =>
    object.objectId === objectId
      ? { ...object, contours: [...object.contours, contour] }
      : object), now);
}

export function updateContourPoints(project: Project, imageId: string, objectId: string, contourId: string,
  points: Point[], now: string = new Date().toISOString()): Project {
  return withDraft(project, imageId, (objects) => objects.map((object) =>
    object.objectId !== objectId ? object : {
      ...object,
      contours: object.contours.map((contour) =>
        contour.contourId === contourId
          ? { ...contour, points: points.map((p) => ({ ...p })) }
          : contour),
    }), now);
}

export function setContourType(project: Project, imageId: string, objectId: string, contourId: string,
  type: ContourType, now: string = new Date().toISOString()): Project {
  return withDraft(project, imageId, (objects) => objects.map((object) =>
    object.objectId !== objectId ? object : {
      ...object,
      contours: object.contours.map((contour) =>
        contour.contourId === contourId ? { ...contour, type } : contour),
    }), now);
}

export function removeContour(project: Project, imageId: string, objectId: string, contourId: string,
  now: string = new Date().toISOString()): Project {
  return withDraft(project, imageId, (objects) => objects.map((object) =>
    object.objectId !== objectId ? object : {
      ...object,
      contours: object.contours.filter((contour) => contour.contourId !== contourId),
    }), now);
}

/**
 * 提交草稿：当前草稿快照成为一个不可变的新版本，历史版本全部保留。
 * objectId 原样延续，因此“改类别/轮廓不改变物体身份”。
 */
export function submitDraft(project: Project, imageId: string,
  now: string = new Date().toISOString()): Project {
  const index = indexOfImage(project, imageId);
  const record = project.images[index];
  if (!record.draft) throw new Error('没有可提交的草稿');
  const versionNo = record.versions.length === 0
    ? 1
    : record.versions[record.versions.length - 1].versionNo + 1;
  const version: AnnotationVersion = deepFreeze({
    versionId: `ver_${imageId}_${versionNo}_${Date.now().toString(36)}`,
    basedOnVersionId: record.draft.basedOnVersionId,
    versionNo,
    objects: deepFreeze(deepClone(record.draft.objects)),
    submittedAt: now,
  });
  const next: ImageRecord = {
    ...record,
    versions: [...record.versions, version],
    draft: null,
  };
  return replaceRecord(project, index, next, now);
}

/** 图片最新已提交版本；没有则 null */
export function latestVersion(record: ImageRecord): AnnotationVersion | null {
  return record.versions.length === 0 ? null : record.versions[record.versions.length - 1];
}
