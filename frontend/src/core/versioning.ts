import type {
  AnnotationObject,
  Category,
  Contour,
  ContourHole,
  ImageRecord,
  ImageVersion,
  ObjectTransform,
  ObjectTransformMapping,
  Point,
  RegionOrigin,
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

function stampContourOrigin(
  contour: Contour,
  sourceVersion: number,
  objectId: string,
): Contour {
  const origin: RegionOrigin = contour.origin ?? {
    version: sourceVersion,
    objectId,
    contourId: contour.id,
  };
  return {
    ...contour,
    origin,
    holes: contour.holes.map((hole) => ({
      ...hole,
      origin: hole.origin ?? { ...origin, holeId: hole.id },
    })),
  };
}

function stampObjectOrigins(obj: AnnotationObject, sourceVersion: number): AnnotationObject {
  return {
    ...obj,
    origins: obj.origins ?? obj.contours.map((c) => c.origin ?? {
      version: sourceVersion,
      objectId: obj.id,
      contourId: c.id,
    }),
    contours: obj.contours.map((c) => stampContourOrigin(c, sourceVersion, obj.id)),
  };
}

function getReworkDraft(image: ImageRecord): ImageVersion {
  const draft = getDraft(image);
  if (!draft) throw new Error(`图片 ${image.id} 没有可编辑的草稿，请先发起返工`);
  if (draft.basedOn == null) throw new Error('只能在基于已提交版本的返工中拆分或合并对象');
  return draft;
}

function mappingsForContour(
  sourceObjectId: string,
  targetObjectId: string,
  contour: Contour,
): ObjectTransformMapping {
  return {
    sourceObjectId,
    sourceContourId: contour.origin?.contourId ?? contour.id,
    targetObjectId,
    targetContourId: contour.id,
    holes: contour.holes.map((hole) => ({
      sourceHoleId: hole.origin?.holeId ?? hole.id,
      targetHoleId: hole.id,
    })),
  };
}

function assertUniqueMappings(transforms: ObjectTransform[]): void {
  const seen = new Set<string>();
  for (const transform of transforms) {
    for (const mapping of transform.mappings) {
      if (seen.has(mapping.sourceObjectId + ':' + mapping.sourceContourId)) {
        throw new Error('同一区域被重复拆合，不能重复导出重叠部分');
      }
      seen.add(mapping.sourceObjectId + ':' + mapping.sourceContourId);
      for (const h of mapping.holes) {
        const holeKey = mapping.sourceObjectId + ':' + mapping.sourceContourId + ':' + h.sourceHoleId;
        if (seen.has(holeKey)) throw new Error('同一孔洞被重复拆合，不能重复导出');
        seen.add(holeKey);
      }
    }
  }
}

/** 把一个对象的外轮廓分组拆开；第一组保留原对象，其余组生成新对象 */
export function splitDraftObjectContours(
  image: ImageRecord,
  objectId: string,
  contourGroups: string[][],
): ImageRecord {
  const next = clone(image);
  const draft = getReworkDraft(next);
  const source = draft.objects.find((o) => o.id === objectId);
  if (!source) throw new Error(`物体 ${objectId} 不存在，无法拆分`);
  if (contourGroups.length < 2) throw new Error('拆分至少需要两个轮廓分组');
  const groups = contourGroups.map((g) => [...new Set(g)]);
  const all = groups.flat();
  if (all.length !== new Set(all).size) throw new Error('拆分分组不能重复使用同一个轮廓');
  const available = new Set(source.contours.map((c) => c.id));
  if (!all.every((id) => available.has(id)) || all.length !== available.size) {
    throw new Error('拆分必须完整且不重叠地分配对象的所有外轮廓');
  }

  const baseVersion = draft.basedOn!;
  const mappings: ObjectTransformMapping[] = [];
  const targetIds: string[] = [];
  const oldContours = new Map(source.contours.map((c) => [c.id, c]));
  source.contours = groups[0].map((id) => stampContourOrigin(oldContours.get(id)!, baseVersion, objectId));
  source.origins = source.contours.map((c) => c.origin!);
  source.updatedAt = nowIso();
  targetIds.push(source.id);
  source.contours.forEach((c) => mappings.push(mappingsForContour(objectId, source.id, c)));

  groups.slice(1).forEach((group) => {
    const created = stampObjectOrigins(createObject(source.categoryId), baseVersion);
    created.contours = group.map((id) => stampContourOrigin(oldContours.get(id)!, baseVersion, objectId));
    created.origins = created.contours.map((c) => c.origin!);
    draft.objects.push(created);
    targetIds.push(created.id);
    created.contours.forEach((c) => mappings.push(mappingsForContour(objectId, created.id, c)));
  });

  draft.objectTransforms = [...(draft.objectTransforms ?? []), {
    id: uid('split'), kind: 'split', sourceObjectIds: [objectId], targetObjectIds: targetIds,
    mappings, createdAt: nowIso(),
  }];
  assertUniqueMappings(draft.objectTransforms);
  return next;
}

/** 多个对象合并为第一个对象；轮廓和孔洞整体迁移，孔洞仍挂在原外轮廓下 */
export function mergeDraftObjects(image: ImageRecord, objectIds: string[]): ImageRecord {
  const next = clone(image);
  const draft = getReworkDraft(next);
  const ids = [...new Set(objectIds)];
  if (ids.length < 2) throw new Error('合并至少需要两个对象');
  const sources = ids.map((id) => draft.objects.find((o) => o.id === id));
  if (sources.some((o) => !o)) throw new Error('参与合并的对象不存在');
  const [, ...rest] = sources;
  const existingTransform = (draft.objectTransforms ?? []).flatMap((t) => t.mappings).find((m) =>
    ids.includes(m.sourceObjectId) || ids.includes(m.targetObjectId));
  if (existingTransform) throw new Error('参与对象已经拆合过，不能重复导出同一区域');
  const targetObject = sources[0]!;
  const baseVersion = draft.basedOn!;
  const mappings: ObjectTransformMapping[] = [];
  for (const source of sources) {
    source!.contours = source!.contours.map((c) => stampContourOrigin(c, baseVersion, source!.id));
    source!.contours.forEach((c) => mappings.push(mappingsForContour(source!.id, targetObject.id, c)));
  }
  for (const source of rest) {
    targetObject.contours.push(...source!.contours);
    targetObject.origins?.push(...(source!.origins ?? source!.contours.map((c) => c.origin!)));
  }
  targetObject.origins = sources.flatMap((s) => s!.origins ?? s!.contours.map((c) => c.origin!));
  targetObject.updatedAt = nowIso();
  draft.objects = draft.objects.filter((o) => !ids.slice(1).includes(o.id));
  draft.objectTransforms = [...(draft.objectTransforms ?? []), {
    id: uid('merge'), kind: 'merge', sourceObjectIds: ids, targetObjectIds: [targetObject.id],
    mappings, createdAt: nowIso(),
  }];
  assertUniqueMappings(draft.objectTransforms);
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

// 对最近一次已提交版本发起返工：复制为新草稿，物体 id 全部保留，旧版本冻结
export function startRework(image: ImageRecord, note?: string): ImageRecord {
  if (getDraft(image)) throw new Error(`图片 ${image.id} 已存在草稿，请先提交或丢弃`);
  const latest = getLatestSubmitted(image);
  if (!latest) throw new Error(`图片 ${image.id} 还没有已提交版本，无法返工`);
  const next = clone(image);
  const draft: ImageVersion = {
    version: next.versions.length + 1,
    status: 'draft',
    objects: clone(latest.objects),
    createdAt: nowIso(),
    submittedAt: null,
    basedOn: latest.version,
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
