import type {
  AnnotationObject,
  Category,
  Contour,
  ContourHole,
  ImageRecord,
  ImageVersion,
  Point,
} from '../types';
import { uid } from './geometry';

export function nowIso(): string {
  return new Date().toISOString();
}

export function createImage(input: {
  id?: string;
  name: string;
  width: number;
  height: number;
  dataUrl?: string;
}): ImageRecord {
  const ts = nowIso();
  return {
    id: input.id ?? uid('img'),
    name: input.name,
    width: input.width,
    height: input.height,
    dataUrl: input.dataUrl,
    createdAt: ts,
    versions: [
      {
        version: 1,
        status: 'draft',
        objects: [],
        createdAt: ts,
        submittedAt: null,
        basedOn: null,
      },
    ],
  };
}

export function getDraft(image: ImageRecord): ImageVersion | undefined {
  return image.versions.find((v) => v.status === 'draft');
}

export function getLatestSubmitted(image: ImageRecord): ImageVersion | undefined {
  return [...image.versions].reverse().find((v) => v.status === 'submitted');
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

export function createObject(categoryId: string): AnnotationObject {
  const ts = nowIso();
  return {
    id: uid('obj'),
    categoryId,
    contours: [],
    createdAt: ts,
    updatedAt: ts,
  };
}

export function createContour(points: Point[] = []): Contour {
  return { id: uid('ctr'), points, holes: [] };
}

export function createHole(points: Point[] = []): ContourHole {
  return { id: uid('hole'), points };
}

// 在草稿上更新物体；物体 id 保持不变
export function updateDraftObject(
  image: ImageRecord,
  objectId: string,
  updater: (obj: AnnotationObject) => void,
): ImageRecord {
  const next = clone(image);
  const draft = getDraft(next);
  if (!draft) throw new Error(`图片 ${image.id} 没有可编辑的草稿，请先发起返工`);
  const obj = draft.objects.find((o) => o.id === objectId);
  if (!obj) throw new Error(`物体 ${objectId} 不存在于当前草稿`);
  updater(obj);
  obj.updatedAt = nowIso();
  return next;
}

export function addDraftObject(image: ImageRecord, categoryId: string): { image: ImageRecord; objectId: string } {
  const obj = createObject(categoryId);
  const next = clone(image);
  const draft = getDraft(next);
  if (!draft) throw new Error(`图片 ${image.id} 没有可编辑的草稿，请先发起返工`);
  draft.objects.push(obj);
  return { image: next, objectId: obj.id };
}

export function removeDraftObject(image: ImageRecord, objectId: string): ImageRecord {
  const next = clone(image);
  const draft = getDraft(next);
  if (!draft) throw new Error('当前没有可编辑的草稿');
  draft.objects = draft.objects.filter((o) => o.id !== objectId);
  return next;
}

// 提交草稿：草稿冻结为 submitted，历史提交版本保持原样
export function submitDraft(image: ImageRecord, note?: string): ImageRecord {
  const next = clone(image);
  const draftIndex = next.versions.findIndex((v) => v.status === 'draft');
  if (draftIndex < 0) throw new Error(`图片 ${image.id} 没有可提交的草稿`);
  const draft = next.versions[draftIndex];
  draft.status = 'submitted';
  draft.submittedAt = nowIso();
  if (note !== undefined) draft.note = note;
  return next;
}

// 对指定（默认最近一次）已提交版本发起返工：复制为新草稿，物体 id 全部保留，旧版本冻结
export function startRework(image: ImageRecord, note?: string, fromVersion?: number): ImageRecord {
  if (getDraft(image)) throw new Error(`图片 ${image.id} 已存在草稿，请先提交或丢弃`);
  const base =
    fromVersion === undefined
      ? getLatestSubmitted(image)
      : image.versions.find((v) => v.version === fromVersion && v.status === 'submitted');
  if (!base) throw new Error(`图片 ${image.id} 没有可返工的已提交版本`);
  const next = clone(image);
  const draft: ImageVersion = {
    version: next.versions.length + 1,
    status: 'draft',
    objects: clone(base.objects),
    createdAt: nowIso(),
    submittedAt: null,
    basedOn: base.version,
    note,
  };
  next.versions.push(draft);
  return next;
}

// 丢弃尚未提交的草稿（不影响已冻结版本）
export function discardDraft(image: ImageRecord): ImageRecord {
  const next = clone(image);
  next.versions = next.versions.filter((v) => v.status !== 'draft');
  return next;
}

export function defaultCategories(): Category[] {
  return [
    { id: 'cat_person', name: '人', color: '#ef4444' },
    { id: 'cat_vehicle', name: '车辆', color: '#3b82f6' },
    { id: 'cat_animal', name: '动物', color: '#22c55e' },
  ];
}
