import { useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, ImageMeta, Point, Ring } from "./types";
import { centroid, pointInPolygon, pointInRing, ringToSvg } from "./geometry";
import { api } from "./api";

type Tool = "select" | "outer" | "hole" | "contour";

interface Props {
  image: ImageMeta;
  annotations: Annotation[];
  categories: string[];
  onChange(next: Annotation[]): void;
  selectedId: string | null;
  onSelect(id: string | null): void;
}

const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308", "#a855f7", "#ec4899", "#14b8a6"];

export function colorFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export default function Editor({ image, annotations, categories, onChange, selectedId, onSelect }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [draftRing, setDraftRing] = useState<Ring>([]);
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<Point | null>(null);

  const selected = useMemo(
    () => annotations.find((a) => a.object_id === selectedId) || null,
    [annotations, selectedId]
  );

  useEffect(() => {
    setDraftRing([]);
    setTool("select");
  }, [image.id]);

  // Screen point -> normalized image coordinates; zoom never changes stored truth.
  function toNormalized(e: React.MouseEvent): Point {
    const rect = svgRef.current!.getBoundingClientRect();
    const sx = ((e.clientX - rect.left) / rect.width) * image.width;
    const sy = ((e.clientY - rect.top) / rect.height) * image.height;
    return [Math.min(1, Math.max(0, sx / image.width)), Math.min(1, Math.max(0, sy / image.height))];
  }

  function handleClick(e: React.MouseEvent) {
    const p = toNormalized(e);
    if (tool === "select") {
      let hit: string | null = null;
      for (let i = annotations.length - 1; i >= 0; i--) {
        if (annotations[i].geometry.some((poly) => pointInPolygon(p[0], p[1], poly))) {
          hit = annotations[i].object_id;
          break;
        }
      }
      onSelect(hit);
      return;
    }
    setDraftRing((r) => [...r, p]);
  }

  function handleMove(e: React.MouseEvent) {
    if (tool !== "select" && draftRing.length) setHover(toNormalized(e));
  }

  function commitRing() {
    if (draftRing.length < 3) {
      setDraftRing([]);
      setHover(null);
      return;
    }
    const ring = draftRing.map(([x, y]) => [x, y] as Point);
    let next: Annotation[];

    if (tool === "outer") {
      const id = selectedId || "obj-" + Math.random().toString(36).slice(2, 10);
      const exists = annotations.find((a) => a.object_id === id);
      const base = exists ? exists.geometry : [];
      const ann: Annotation = exists
        ? { ...exists, geometry: [...base, [ring]] }
        : { object_id: id, category: categories[0], geometry: [[ring]] };
      next = exists ? annotations.map((a) => (a.object_id === id ? ann : a)) : [...annotations, ann];
      onSelect(id);
    } else if (tool === "contour") {
      if (!selected) {
        alert("请先在左侧选中一个已有物体，再为其追加轮廓");
        setDraftRing([]);
        return;
      }
      next = annotations.map((a) =>
        a.object_id === selected.object_id ? { ...a, geometry: [...a.geometry, [ring]] } : a
      );
    } else {
      if (!selected) {
        alert("请先选中要挖洞的物体");
        setDraftRing([]);
        return;
      }
      const idx = selected.geometry.findIndex((poly) => pointInRing(ring[0][0], ring[0][1], poly[0]));
      if (idx < 0) {
        alert("孔洞必须落在该物体某个外轮廓内部");
        setDraftRing([]);
        return;
      }
      const poly = selected.geometry[idx];
      const newPoly: typeof poly = [poly[0], ...poly.slice(1), ring];
      next = annotations.map((a) =>
        a.object_id === selected.object_id
          ? { ...a, geometry: selected.geometry.map((g, i) => (i === idx ? newPoly : g)) }
          : a
      );
    }
    onChange(next);
    setDraftRing([]);
    setHover(null);
  }

  function keyHandler(e: React.KeyboardEvent) {
    if ((e.key === "Enter" || e.key === "Escape") && draftRing.length) {
      if (e.key === "Enter") commitRing();
      else { setDraftRing([]); setHover(null); }
    }
    if (e.key === "Delete" && tool === "select" && selected) {
      onChange(annotations.filter((a) => a.object_id !== selected.object_id));
      onSelect(null);
    }
  }

  function updateCategory(category: string) {
    if (!selected) return;
    onChange(annotations.map((a) => (a.object_id === selected.object_id ? { ...a, category } : a)));
  }

  const livePoints = hover && draftRing.length ? [...draftRing, hover] : draftRing;

  return (
    <div className="editor" tabIndex={0} onKeyDown={keyHandler}>
      <div className="toolbar">
        <button className={tool === "select" ? "on" : ""} onClick={() => setTool("select")}>选择/命中</button>
        <button className={tool === "outer" ? "on" : ""} onClick={() => setTool("outer")}>
          {selected ? "给选中物加外环" : "新物体外轮廓"}
        </button>
        <button className={tool === "contour" ? "on" : ""} disabled={!selected} onClick={() => setTool("contour")}>+同一物体新轮廓</button>
        <button className={tool === "hole" ? "on" : ""} disabled={!selected} onClick={() => setTool("hole")}>+孔洞</button>
        <span className="spacer" />
        <button onClick={() => setZoom((z) => Math.max(0.2, z / 1.2))}>－</button>
        <span className="zoom">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(8, z * 1.2))}>＋</button>
        {draftRing.length > 0 && <button className="commit" onClick={commitRing}>闭合({draftRing.length}) ✓</button>}
      </div>
      <div className="canvas-scroll">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${image.width} ${image.height}`}
          width={image.width * zoom}
          height={image.height * zoom}
          onMouseDown={(e) => e.button === 0 && handleClick(e)}
          onMouseMove={handleMove}
          onDoubleClick={commitRing}
          className={tool === "select" ? "cur-select" : "cur-draw"}
        >
          <image href={api.imageUrl(image.id)} width={image.width} height={image.height} />
          {annotations.map((a) => {
            const color = colorFor(a.object_id);
            const isSel = a.object_id === selectedId;
            return (
              <g key={a.object_id}>
                {a.geometry.map((poly, pi) => (
                  <g key={pi}>
                    <path
                      d={ringToSvg(poly[0].map(([x, y]) => [x * image.width, y * image.height] as Point))}
                      fill={color} fillOpacity={isSel ? 0.28 : 0.12} stroke={color}
                      strokeWidth={isSel ? 3 : 1.5} vectorEffect="non-scaling-stroke"
                    />
                    {poly.slice(1).map((hole, hi) => (
                      <path key={hi}
                        d={ringToSvg(hole.map(([x, y]) => [x * image.width, y * image.height] as Point))}
                        fill="#0b0f17" fillOpacity={0.9} stroke={color}
                        strokeDasharray="6 4" vectorEffect="non-scaling-stroke"
                      />
                    ))}
                  </g>
                ))}
                {(() => {
                  const [cx, cy] = centroid(a.geometry[0][0]);
                  return (
                    <text key="label" x={cx * image.width} y={cy * image.height} fill={color} fontSize={18}>
                      {a.category}
                    </text>
                  );
                })()}
              </g>
            );
          })}
          {livePoints.length > 0 && (
            <path
              d={ringToSvg(livePoints.map(([x, y]) => [x * image.width, y * image.height] as Point))}
              fill="rgba(59,130,246,.15)" stroke="#3b82f6" strokeDasharray="4 3" vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>
      <div className="inspector">
        {selected ? (
          <>
            <div className="row">
              <span className="objid" title={selected.object_id}>{selected.object_id}</span>
              <button className="danger" onClick={() => { onChange(annotations.filter((a) => a.object_id !== selected.object_id)); onSelect(null); }}>删除物体</button>
            </div>
            <div className="row">
              <label>类别</label>
              <select value={selected.category} onChange={(e) => updateCategory(e.target.value)}>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="hint">
              外轮廓 {selected.geometry.length} 个，孔洞 {selected.geometry.reduce((n, p) => n + p.length - 1, 0)} 个；全部属于同一身份 {selected.object_id}
            </div>
          </>
        ) : (
          <div className="hint">点击“新物体外轮廓”开始：逐点单击，双击或 Enter 闭合，Esc 取消。坐标按图片像素归一化保存，缩放不改变真实坐标。</div>
        )}
      </div>
    </div>
  );
}
