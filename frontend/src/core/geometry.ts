import type { Contour, Point } from '../types';

export function uid(prefix = 'id'): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

/** 多边形有向面积（Shoelace） */
export function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** 射线法判断点是否在多边形内（边界视为内部） */
export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const straddles = (yi > p.y) !== (yj > p.y);
    const intersect =
      straddles && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside || pointOnPolygonBoundary(p, poly);
}

function orientation(a: Point, b: Point, c: Point): number {
  const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(v) < 1e-9) return 0;
  return v > 0 ? 1 : 2;
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    Math.min(a.x, b.x) - 1e-9 <= p.x &&
    p.x <= Math.max(a.x, b.x) + 1e-9 &&
    Math.min(a.y, b.y) - 1e-9 <= p.y &&
    p.y <= Math.max(a.y, b.y) + 1e-9
  );
}

/** 两条线段是否相交（含端点相接与重叠） */
export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const o1 = orientation(p1, p2, p3);
  const o2 = orientation(p1, p2, p4);
  const o3 = orientation(p3, p4, p1);
  const o4 = orientation(p3, p4, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, p3)) return true;
  if (o2 === 0 && onSegment(p1, p2, p4)) return true;
  if (o3 === 0 && onSegment(p3, p4, p1)) return true;
  if (o4 === 0 && onSegment(p3, p4, p2)) return true;
  return false;
}

/** 多边形自身的非相邻边是否相交 */
export function polygonSelfIntersects(points: Point[]): boolean {
  const n = points.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      const adjacent = i === 0 && j === n - 1;
      if (j === i + 1 || adjacent) continue;
      if (segmentsIntersect(a1, a2, points[j], points[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** 两个多边形是否存在边交叉（端点相接也算） */
export function polygonsIntersect(a: Point[], b: Point[]): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (
        segmentsIntersect(
          a[i], a[(i + 1) % a.length],
          b[j], b[(j + 1) % b.length],
        )
      ) return true;
    }
  }
  return false;
}

/** 多边形 a 是否有任意部分落在多边形 b 内部（顶点在内或边交叉） */
export function polygonOverlaps(a: Point[], b: Point[]): boolean {
  if (polygonsIntersect(a, b)) return true;
  return a.some((p) => pointInPolygon(p, b)) || b.some((p) => pointInPolygon(p, a));
}

export function pointOnPolygonBoundary(p: Point, poly: Point[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (orientation(a, b, p) === 0 && onSegment(a, b, p)) return true;
  }
  return false;
}

/** 收集一个版本中所有外轮廓，附带归属信息 */
export function listOuterContours(objects: { id: string; contours: Contour[] }[]) {
  const out: { objectId: string; contour: Contour }[] = [];
  for (const obj of objects) {
    for (const contour of obj.contours) out.push({ objectId: obj.id, contour });
  }
  return out;
}
