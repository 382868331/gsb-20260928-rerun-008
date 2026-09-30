import type { Contour, Point } from './types';

export interface Box { minX: number; minY: number; maxX: number; maxY: number; }

export function boxOf(points: Point[]): Box | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function boxesOverlap(a: Box, b: Box): boolean {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
}

function cross2(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** 严格线段相交（不含共线重叠；共线重叠由专门检查覆盖） */
function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = cross2(p3, p4, p1);
  const d2 = cross2(p3, p4, p2);
  const d3 = cross2(p1, p2, p3);
  const d4 = cross2(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function pointOnSegment(p: Point, a: Point, b: Point): boolean {
  return cross2(a, b, p) === 0
    && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
    && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}

/** 共线且部分重叠的线段也算交叉 */
function collinearOverlap(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  if (cross2(p1, p2, p3) !== 0 || cross2(p1, p2, p4) !== 0) return false;
  const onA = pointOnSegment(p3, p1, p2) || pointOnSegment(p4, p1, p2);
  const onB = pointOnSegment(p1, p3, p4) || pointOnSegment(p2, p3, p4);
  return onA || onB;
}

function closedEdges(points: Point[]): Array<[Point, Point]> {
  const edges: Array<[Point, Point]> = [];
  for (let i = 0; i < points.length; i += 1) {
    edges.push([points[i], points[(i + 1) % points.length]]);
  }
  return edges;
}

/** 多边形自交（相邻边共享端点属正常，不算）；至少需要 4 个点才可能自交 */
export function isSelfIntersecting(points: Point[]): boolean {
  const box = boxOf(points);
  if (!box) return true;
  if (points.length < 4) return false;
  const edges = closedEdges(points);
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      // 相邻边（含首尾）共享端点，跳过
      const adjacent = j === i + 1 || (i === 0 && j === edges.length - 1);
      if (adjacent) continue;
      const [a, b] = edges[i];
      const [c, d] = edges[j];
      if (segmentsCross(a, b, c, d)) return true;
      if (collinearOverlap(a, b, c, d)) return true;
    }
  }
  return false;
}

/** 两条闭合多边形的边是否交叉 */
export function polygonsCross(a: Point[], b: Point[]): boolean {
  const ba = boxOf(a);
  const bb = boxOf(b);
  if (!ba || !bb || !boxesOverlap(ba, bb)) return false;
  const ea = closedEdges(a);
  const eb = closedEdges(b);
  for (const [p1, p2] of ea) {
    for (const [p3, p4] of eb) {
      if (segmentsCross(p1, p2, p3, p4)) return true;
      if (collinearOverlap(p1, p2, p3, p4)) return true;
    }
  }
  return false;
}

/** 射线法判断点是否在多边形内部；边上的点视为内部 */
export function pointInPolygon(p: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    if (pointOnSegment(p, pi, pj)) return true;
    const intersect = ((pi.y > p.y) !== (pj.y > p.y))
      && (p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x);
    if (intersect) inside = !inside;
  }
  return inside;
}

/** hole 的所有顶点是否都落在 outer 内 */
export function polygonContains(outer: Point[], hole: Point[]): boolean {
  return hole.every((p) => pointInPolygon(p, outer));
}

export function polygonPointsKey(points: Point[]): string {
  return points.map((p) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`).join('|');
}

/** 把轮廓转成 SVG 可用的 path d 字符串 */
export function contourToPath(contour: Contour): string {
  if (contour.points.length === 0) return '';
  return contour.points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ') + ' Z';
}
