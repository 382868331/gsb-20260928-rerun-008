import { describe, it, expect } from "vitest";
import { pointInRing, pointInPolygon, pointInMultiPolygon } from "./geometry";

const outer = [[0, 0], [1, 0], [1, 1], [0, 1]] as any;
const hole = [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]] as any;

describe("normalized geometry", () => {
  it("detects point in ring", () => {
    expect(pointInRing(0.3, 0.3, outer)).toBe(true);
    expect(pointInRing(2, 2, outer)).toBe(false);
  });

  it("excludes points inside a hole", () => {
    expect(pointInPolygon(0.51, 0.51, [outer, hole])).toBe(false);
    expect(pointInPolygon(0.2, 0.2, [outer, hole])).toBe(true);
  });

  it("treats separate contours of one object as one multipolygon", () => {
    const blob2 = [[0.8, 0.8], [0.9, 0.8], [0.9, 0.9], [0.8, 0.9]] as any;
    const geom = [[outer], [blob2]] as any;
    expect(pointInMultiPolygon(0.85, 0.85, geom)).toBe(true);
    expect(pointInMultiPolygon(1.5, 1.5, geom)).toBe(false);
  });

  it("overlapping objects are independently hit-testable", () => {
    const a = [[[[0.1, 0.1], [0.6, 0.1], [0.6, 0.6], [0.1, 0.6]]]] as any;
    const b = [[[[0.4, 0.4], [0.9, 0.4], [0.9, 0.9], [0.4, 0.9]]]] as any;
    expect(pointInMultiPolygon(0.5, 0.5, a)).toBe(true);
    expect(pointInMultiPolygon(0.5, 0.5, b)).toBe(true);
  });
});
