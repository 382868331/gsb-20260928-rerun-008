import type { MultiPolygon, Point, Ring } from "./types";

export function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x: number, y: number, poly: Ring[]): boolean {
  if (!poly.length) return false;
  if (!pointInRing(x, y, poly[0])) return false;
  for (let i = 1; i < poly.length; i++) {
    if (pointInRing(x, y, poly[i])) return false;
  }
  return true;
}

export function pointInMultiPolygon(x: number, y: number, geom: MultiPolygon): boolean {
  return geom.some((poly) => pointInPolygon(x, y, poly));
}

export function ringToSvg(ring: Ring): string {
  return ring.map(([x, y], i) => (i ? "L" : "M") + x + "," + y).join(" ") + " Z";
}

export function centroid(ring: Ring): Point {
  let cx = 0;
  let cy = 0;
  ring.forEach(([x, y]) => {
    cx += x;
    cy += y;
  });
  return [cx / ring.length, cy / ring.length];
}

export function newObjectId(): string {
  return "obj-" + Math.random().toString(36).slice(2, 10);
}
