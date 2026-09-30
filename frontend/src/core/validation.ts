import {
  boxOf,
  isSelfIntersecting,
  pointInPolygon,
  polygonsCross,
} from './geometry';
import type {
  AnnotationObject,
  Contour,
  ImportedImagePayload,
  IssueCode,
  Point,
  ValidationIssue,
} from './types';

function isPoint(v: unknown): v is Point {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.x === 'number' && typeof p.y === 'number'
    && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function isContour(v: unknown): v is Contour {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return typeof c.contourId === 'string' && c.contourId.length > 0
    && (c.type === 'outer' || c.type === 'hole')
    && Array.isArray(c.points) && c.points.every(isPoint);
}

function isAnnotationObject(v: unknown): v is AnnotationObject {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.objectId === 'string' && o.objectId.length > 0
    && typeof o.category === 'string' && o.category.length > 0
    && Array.isArray(o.contours) && o.contours.every(isContour);
}

/** 不依赖类别表的结构校验，返回 null 表示记录无法解析 */
export function parseObjects(raw: unknown): AnnotationObject[] | null {
  if (!Array.isArray(raw)) return null;
  if (!raw.every(isAnnotationObject)) return null;
  return raw as AnnotationObject[];
}

function issue(
  code: IssueCode,
  message: string,
  index: number,
  ctx: { imageId?: string; name?: string; objectId?: string; contourId?: string } = {},
): ValidationIssue {
  return { code, message, index, ...ctx };
}

/**
 * 校验单张图片的标注内容。
 * - 轮廓至少 3 个点且不得自交；
 * - 同一物体内任意轮廓之间的边不得交叉；
 * - 必须有外轮廓，孔洞必须落在某个外轮廓内部；
 * - 物体/轮廓 ID 不得重复；类别必须在类别表内。
 */
export function validateObjects(
  objects: AnnotationObject[],
  categories: readonly string[],
  index: number,
  ctx: { imageId?: string; name?: string } = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const categorySet = new Set(categories);
  const objectIds = new Set<string>();
  const contourIds = new Set<string>();

  for (const obj of objects) {
    if (objectIds.has(obj.objectId)) {
      issues.push(issue('CORRUPT_RECORD', `物体 ID 重复：${obj.objectId}`, index,
        { ...ctx, objectId: obj.objectId }));
    }
    objectIds.add(obj.objectId);

    if (!categorySet.has(obj.category)) {
      issues.push(issue('CORRUPT_RECORD', `未知类别“${obj.category}”`, index,
        { ...ctx, objectId: obj.objectId }));
    }

    if (obj.contours.length === 0) {
      issues.push(issue('CORRUPT_RECORD', '物体至少需要一个轮廓', index,
        { ...ctx, objectId: obj.objectId }));
      continue;
    }

    const outers: Contour[] = [];
    const holes: Contour[] = [];
    for (const contour of obj.contours) {
      if (contourIds.has(contour.contourId)) {
        issues.push(issue('CORRUPT_RECORD', `轮廓 ID 重复：${contour.contourId}`, index,
          { ...ctx, objectId: obj.objectId, contourId: contour.contourId }));
      }
      contourIds.add(contour.contourId);

      if (contour.points.length < 3 || !boxOf(contour.points)) {
        issues.push(issue('CONTOUR_TOO_FEW_POINTS', '轮廓至少需要 3 个有效点', index,
          { ...ctx, objectId: obj.objectId, contourId: contour.contourId }));
        continue;
      }
      if (isSelfIntersecting(contour.points)) {
        issues.push(issue('SELF_INTERSECTING', '轮廓存在自交', index,
          { ...ctx, objectId: obj.objectId, contourId: contour.contourId }));
      }
      if (contour.type === 'outer') outers.push(contour);
      else holes.push(contour);
    }

    if (outers.length === 0) {
      issues.push(issue('MULTIPLE_OUTERS', '物体缺少外轮廓', index,
        { ...ctx, objectId: obj.objectId }));
    }

    const all = [...outers, ...holes];
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        if (all[i].points.length < 3 || all[j].points.length < 3) continue;
        if (polygonsCross(all[i].points, all[j].points)) {
          issues.push(issue('CONTOURS_CROSS',
            `轮廓交叉：${all[i].contourId} 与 ${all[j].contourId}`, index,
            { ...ctx, objectId: obj.objectId, contourId: all[j].contourId }));
        }
      }
    }

    for (const hole of holes) {
      if (hole.points.length < 3 || outers.length === 0) continue;
      const contained = outers.some((outer) =>
        outer.points.length >= 3
        && hole.points.every((p) => pointInPolygon(p, outer.points)));
      if (!contained) {
        issues.push(issue('HOLE_OUTSIDE_OUTER', '孔洞位于所有外轮廓之外', index,
          { ...ctx, objectId: obj.objectId, contourId: hole.contourId }));
      }
    }
  }
  return issues;
}

/** 校验导入记录头部字段（不含轮廓几何），坏记录整张图片作废 */
export function validatePayloadShape(payload: ImportedImagePayload, index: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const p = payload as unknown as Record<string, unknown>;
  const stringFields = ['imageId', 'name', 'checksum', 'versionId', 'submittedAt'] as const;
  for (const field of stringFields) {
    if (typeof p[field] !== 'string' || (p[field] as string).length === 0) {
      issues.push(issue('CORRUPT_RECORD', `字段 ${field} 缺失或损坏`, index,
        { imageId: typeof p.imageId === 'string' ? p.imageId : undefined }));
    }
  }
  if (typeof p.width !== 'number' || typeof p.height !== 'number'
    || p.width <= 0 || p.height <= 0) {
    issues.push(issue('CORRUPT_RECORD', '图片尺寸缺失或损坏', index,
      { imageId: typeof p.imageId === 'string' ? p.imageId : undefined }));
  }
  if (typeof p.versionNo !== 'number' || p.versionNo < 1) {
    issues.push(issue('CORRUPT_RECORD', '版本号缺失或损坏', index,
      { imageId: typeof p.imageId === 'string' ? p.imageId : undefined }));
  }
  if (p.basedOnVersionId !== null && typeof p.basedOnVersionId !== 'string') {
    issues.push(issue('CORRUPT_RECORD', 'basedOnVersionId 字段损坏', index,
      { imageId: typeof p.imageId === 'string' ? p.imageId : undefined }));
  }
  return issues;
}
