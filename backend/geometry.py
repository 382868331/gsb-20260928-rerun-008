"""Validate normalized polygon annotation geometry.

An annotation is a GeoJSON-like MultiPolygon:
  [ polygon, ... ] where polygon = [ ring, ... ] and ring = [[x,y], ...]
Coordinates are normalized to [0,1]. The first ring of each polygon is the
outer boundary; subsequent rings are holes. Multiple polygons under one
annotation represent multiple disconnected contours of the SAME object
(same identity).
"""

from __future__ import annotations

from typing import Any


class GeometryError(ValueError):
    pass


def _ring_points(ring: Any) -> list[tuple[float, float]]:
    if not isinstance(ring, list) or len(ring) < 3:
        raise GeometryError("a ring must contain at least 3 points")
    pts: list[tuple[float, float]] = []
    for p in ring:
        if (not isinstance(p, (list, tuple)) or len(p) != 2
                or not all(isinstance(v, (int, float)) for v in p)):
            raise GeometryError("each point must be [x, y] numbers")
        x, y = float(p[0]), float(p[1])
        if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
            raise GeometryError("normalized coordinates must be within [0,1]")
        pts.append((x, y))
    if pts[0] == pts[-1]:
        pts.pop()
        if len(pts) < 3:
            raise GeometryError("a ring must contain at least 3 unique points")
    return pts


def validate_multipolygon(geom: Any) -> list[list[list[list[float]]]]:
    """Return a normalized (closed rings removed) copy or raise GeometryError."""
    if not isinstance(geom, list) or not geom:
        raise GeometryError("geometry must be a non-empty list of polygons")
    clean: list[list[list[list[float]]]] = []
    for poly in geom:
        if not isinstance(poly, list) or not poly:
            raise GeometryError("each polygon needs at least an outer ring")
        clean_poly = []
        for i, ring in enumerate(poly):
            pts = _ring_points(ring)
            if len(set(pts)) < 3:
                raise GeometryError("a ring needs at least 3 distinct points")
            clean_poly.append([[x, y] for x, y in pts])
        clean.append(clean_poly)
    return clean


def point_in_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if ((yi > y) != (yj > y)) and +                (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-15) + xi):
            inside = not inside
        j = i
    return inside


def area(ring: list[list[float]]) -> float:
    s = 0.0
    j = len(ring) - 1
    for i in range(len(ring)):
        s += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
        j = i
    return abs(s) / 2.0
