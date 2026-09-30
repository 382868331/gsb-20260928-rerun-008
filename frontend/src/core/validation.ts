import type {
  AnnotationObject,
  Category,
  ImageVersion,
  ImportIssue,
  Point,
} from '../types';
import {
  listOuterContours,
  pointInPolygon,
  polygonOverlaps,
  polygonSelfIntersects,
} from './geometry';

function isPoint(v: unknown): v is Point {
  return (
    typeof v === 'object' &&
    v !== null &&
    Number.isFinite((v as Point).x) &&
    Number.isFinite((v as Point).y)
  );
}

/** 校验单个版本的标注内容，返回全部可定位问题 */
export function validateVersion(
  version: ImageVersion,
  categories: Category[],
  ctx: { imageId?: string; imageName?: string } = {},
): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const categoryIds = new Set(categories.map((c) => c.id));
  const seenObjectIds = new Set<string>();
  const objects: AnnotationObject[] = Array.isArray(version.objects) ? version.objects : [];

  for (const obj of objects) {
    const base = { ...ctx, objectId: obj?.id, version: version.version };
    if (!obj || typeof obj.id !== 'string' || !Array.isArray(obj.contours)) {
      issues.push({ ...base, code: 'CORRUPT_RECORD', message: '物体记录结构损坏' });
      continue;
    }
    if (seenObjectIds.has(obj.id)) {
      issues.push({ ...base, code: 'DUPLICATE_OBJECT_ID', message: `物体 id 重复：${obj.id}` });
    }
    seenObjectIds.add(obj.id);
    if (!categoryIds.has(obj.categoryId)) {
      issues.push({
        ...base,
        code: 'UNKNOWN_CATEGORY',
        message: `物体 ${obj.id} 引用了未知类别 ${obj.categoryId}`,
      });
    }
    for (const contour of obj.contours) {
      const cbase = { ...base, contourId: contour?.id };
      if (!contour || typeof contour.id !== 'string' || !Array.isArray(contour.points)) {
        issues.push({ ...cbase, code: 'CORRUPT_RECORD', message: '轮廓记录结构损坏' });
        continue;
      }
      if (contour.points.length < 3 || !contour.points.every(isPoint)) {
        issues.push({
          ...cbase,
          code: 'INVALID_GEOMETRY',
          message: `轮廓 ${contour.id} 顶点不足 3 个或坐标非法`,
        });
        continue;
      }
      if (polygonSelfIntersects(contour.points)) {
        issues.push({
          ...cbase,
          code: 'INVALID_GEOMETRY',
          message: `轮廓 ${contour.id} 存在自交`,
        });
      }
      for (const hole of contour.holes ?? []) {
        const hbase = { ...cbase, contourId: `${contour.id}/${hole?.id ?? '?'}` };
        if (!hole || typeof hole.id !== 'string' || !Array.isArray(hole.points) || hole.points.length < 3 || !hole.points.every(isPoint)) {
          issues.push({ ...hbase, code: 'CORRUPT_RECORD', message: '孔洞记录结构损坏或顶点不足' });
          continue;
        }
        if (polygonSelfIntersects(hole.points)) {
          issues.push({ ...hbase, code: 'INVALID_GEOMETRY', message: `孔洞 ${hole.id} 存在自交` });
        }
        const inside = hole.points.every((p) => pointInPolygon(p, contour.points));
        if (!inside) {
          issues.push({
            ...hbase,
            code: 'HOLE_OUTSIDE',
            message: `孔洞 ${hole.id} 超出其所属外轮廓 ${contour.id}`,
          });
        }
      }
    }
  }

  const outers = listOuterContours(objects);
  for (let i = 0; i < outers.length; i++) {
    for (let j = i + 1; j < outers.length; j++) {
      const a = outers[i];
      const b = outers[j];
      if (a.contour.points.length < 3 || b.contour.points.length < 3) continue;
      if (polygonOverlaps(a.contour.points, b.contour.points)) {
        issues.push({
          ...ctx,
          version: version.version,
          code: 'CONTOUR_CROSSING',
          message: `轮廓交叉：物体 ${a.objectId} 的 ${a.contour.id} 与物体 ${b.objectId} 的 ${b.contour.id} 重叠`,
        });
      }
    }
  }
  return issues;
}
