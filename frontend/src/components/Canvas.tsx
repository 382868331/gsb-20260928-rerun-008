import { useEffect, useMemo, useRef, useState } from 'react';
import { MousePointer2, Pentagon, Grid3x3, Check, Undo2 } from 'lucide-react';
import { useStore } from '../store';
import { getDraft } from '../core/versioning';
import type { ImageRecord, Point } from '../types';

type Tool = 'select' | 'outer' | 'hole';

export function Canvas({ image }: { image: ImageRecord }) {
  const categories = useStore((s) => s.categories);
  const addContourToObject = useStore((s) => s.addContourToObject);
  const addHoleToContour = useStore((s) => s.addHoleToContour);
  const updateContourPoints = useStore((s) => s.updateContourPoints);
  const updateHolePoints = useStore((s) => s.updateHolePoints);

  const draft = getDraft(image);
  const objects = draft?.objects ?? [];
  const [tool, setTool] = useState<Tool>('select');
  const [activeObjectId, setActiveObjectId] = useState<string | null>(null);
  const [activeContourId, setActiveContourId] = useState<string | null>(null);
  const [working, setWorking] = useState<Point[]>([]);
  const [cursor, setCursor] = useState<Point | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{
    objectId: string;
    contourId: string;
    holeId?: string;
    index: number;
  } | null>(null);

  useEffect(() => {
    setActiveObjectId(null);
    setActiveContourId(null);
    setWorking([]);
    setTool('select');
  }, [image.id, draft?.version]);

  const colorOf = (catId: string) => categories.find((c) => c.id === catId)?.color ?? '#f59e0b';
  const editable = Boolean(draft);

  function toSvgPoint(e: React.MouseEvent): Point {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * image.width,
      y: ((e.clientY - rect.top) / rect.height) * image.height,
    };
  }

  function onClickSvg(e: React.MouseEvent) {
    if (!editable || tool === 'select' || !activeObjectId) return;
    if ((e.target as Element).tagName === 'circle') return;
    const p = toSvgPoint(e);
    setWorking((w) => {
      const last = w[w.length - 1];
      // 双击闭合时第二次 click 与上一点几乎重合，忽略以免产生零长边
      if (last && Math.hypot(last.x - p.x, last.y - p.y) < image.width / 500) return w;
      return [...w, p];
    });
  }

  function onMoveSvg(e: React.MouseEvent) {
    const p = toSvgPoint(e);
    if (tool !== 'select') setCursor(p);
    const drag = dragRef.current;
    if (!drag || !draft) return;
    const obj = draft.objects.find((o) => o.id === drag.objectId);
    const contour = obj?.contours.find((c) => c.id === drag.contourId);
    if (!contour) return;
    if (drag.holeId) {
      const hole = contour.holes.find((h) => h.id === drag.holeId);
      if (!hole) return;
      const points = hole.points.map((pt, i) => (i === drag.index ? p : pt));
      updateHolePoints(drag.objectId, drag.contourId, drag.holeId, points);
    } else {
      const points = contour.points.map((pt, i) => (i === drag.index ? p : pt));
      updateContourPoints(drag.objectId, drag.contourId, points);
    }
  }

  function finishDrawing() {
    if (!activeObjectId || working.length < 3) {
      alert('至少需要 3 个顶点才能闭合轮廓');
      return;
    }
    if (tool === 'outer') {
      addContourToObject(activeObjectId, working);
    } else if (tool === 'hole' && activeContourId) {
      addHoleToContour(activeObjectId, activeContourId, working);
    }
    setWorking([]);
    setTool('select');
  }

  const workingPath = useMemo(() => pointsToPath(working, cursor), [working, cursor]);

  return (
    <div className="canvas-wrap">
      <div className="canvas-tools">
        <select
          value={activeObjectId ?? ''}
          onChange={(e) => {
            setActiveObjectId(e.target.value || null);
            setActiveContourId(null);
            setWorking([]);
          }}
          disabled={!editable}
        >
          <option value="">选择要绘制的物体…</option>
          {objects.map((o) => (
            <option key={o.id} value={o.id}>
              {categories.find((c) => c.id === o.categoryId)?.name ?? '?'}
              {' · '}
              {o.id.slice(-6)}
            </option>
          ))}
        </select>
        <select
          value={activeContourId ?? ''}
          onChange={(e) => setActiveContourId(e.target.value || null)}
          disabled={!editable || tool !== 'hole'}
          title="绘制孔洞时选择所属外轮廓"
        >
          <option value="">选择所属外轮廓…</option>
          {objects
            .find((o) => o.id === activeObjectId)
            ?.contours.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id.slice(-6)}（{c.points.length} 点）
              </option>
            ))}
        </select>
        <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')} title="选择/拖拽顶点">
          <MousePointer2 size={15} />
        </button>
        <button
          className={tool === 'outer' ? 'on' : ''}
          disabled={!editable || !activeObjectId}
          onClick={() => { setTool('outer'); setWorking([]); }}
          title="绘制外轮廓"
        >
          <Pentagon size={15} />
        </button>
        <button
          className={tool === 'hole' ? 'on' : ''}
          disabled={!editable || !activeObjectId || !activeContourId}
          onClick={() => { setTool('hole'); setWorking([]); }}
          title="在选定外轮廓内绘制孔洞"
        >
          <Grid3x3 size={15} />
        </button>
        {tool !== 'select' && (
          <>
            <button onClick={finishDrawing} disabled={working.length < 3}>
              <Check size={15} /> 闭合（{working.length}）
            </button>
            <button onClick={() => setWorking((w) => w.slice(0, -1))} disabled={!working.length}>
              <Undo2 size={14} />
            </button>
            <button onClick={() => { setWorking([]); setTool('select'); }}>取消</button>
          </>
        )}
      </div>

      <div className="svg-stage">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${image.width} ${image.height}`}
          className={tool !== 'select' ? 'drawing' : ''}
          onClick={onClickSvg}
          onMouseMove={onMoveSvg}
          onDoubleClick={() => tool !== 'select' && finishDrawing()}
        >
          <image href={image.dataUrl} width={image.width} height={image.height} />
          {objects.map((obj) => {
            const color = colorOf(obj.categoryId);
            return obj.contours.map((c) => (
              <g key={c.id}>
                <polygon
                  points={toPointsAttr(c.points)}
                  fill={color}
                  fillOpacity={0.18}
                  stroke={color}
                  strokeWidth={Math.max(1.5, image.width / 400)}
                  onClick={() => { setActiveObjectId(obj.id); setActiveContourId(c.id); }}
                />
                {c.holes.map((h) => (
                  <polygon
                    key={h.id}
                    points={toPointsAttr(h.points)}
                    fill="black"
                    fillOpacity={0.55}
                    stroke="#fff"
                    strokeDasharray="6 4"
                    strokeWidth={Math.max(1, image.width / 600)}
                  />
                ))}
                {editable && tool === 'select' &&
                  c.points.map((p, i) => (
                    <circle
                      key={`${c.id}-p-${i}`}
                      cx={p.x} cy={p.y} r={Math.max(3, image.width / 250)}
                      fill="#fff" stroke={color} strokeWidth={2}
                      className="vertex"
                      onMouseDown={() => {
                        dragRef.current = { objectId: obj.id, contourId: c.id, index: i };
                      }}
                      onMouseUp={() => { dragRef.current = null; }}
                    />
                  ))}
                {editable && tool === 'select' &&
                  c.holes.flatMap((h) =>
                    h.points.map((p, i) => (
                      <circle
                        key={`${h.id}-hp-${i}`}
                        cx={p.x} cy={p.y} r={Math.max(2.5, image.width / 300)}
                        fill="#111" stroke="#fff" strokeWidth={1.5}
                        className="vertex"
                        onMouseDown={() => {
                          dragRef.current = { objectId: obj.id, contourId: c.id, holeId: h.id, index: i };
                        }}
                        onMouseUp={() => { dragRef.current = null; }}
                      />
                    )),
                  )}
              </g>
            ));
          })}
          {working.length > 0 && (
            <path d={workingPath} fill="rgba(245,158,11,0.15)" stroke="#f59e0b" strokeWidth={2} />
          )}
        </svg>
      </div>
    </div>
  );
}

function toPointsAttr(points: Point[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

function pointsToPath(points: Point[], cursor: Point | null): string {
  if (points.length === 0) return '';
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i].x} ${points[i].y}`;
  if (cursor) d += ` L ${cursor.x} ${cursor.y}`;
  return d;
}
