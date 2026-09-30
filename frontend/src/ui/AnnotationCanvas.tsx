import { useCallback, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/store';
import { contourToPath } from '../core/geometry';
import type { ImageRecord, Point } from '../core/types';

interface Props {
  record: ImageRecord;
  drawType: 'outer' | 'hole';
  targetObjectId: string | null;
}

interface DragState {
  objectId: string;
  contourId: string;
  pointIndex: number;
}

const MIN_POINTS_TO_CLOSE = 3;

export function AnnotationCanvas({ record, drawType, targetObjectId }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [workPoints, setWorkPoints] = useState<Point[]>([]);
  const [drag, setDrag] = useState<DragState | null>(null);
  const addContour = useStore((state) => state.addContour);
  const updateContourPoints = useStore((state) => state.updateContourPoints);
  const selectObject = useStore((state) => state.selectObject);
  const selectedContourId = useStore((state) => state.selectedContourId);

  const readOnly = !record.draft;
  const { image } = record;
  const objects = record.draft?.objects ?? record.versions[record.versions.length - 1]?.objects ?? [];

  const toImagePoint = useCallback((clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const scaleX = image.width / rect.width;
    const scaleY = image.height / rect.height;
    return {
      x: Math.max(0, Math.min(image.width, (clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.min(image.height, (clientY - rect.top) * scaleY)),
    };
  }, [image.width, image.height]);

  const handleClick = (event: React.MouseEvent<SVGSVGElement>) => {
    if (readOnly || !targetObjectId || drag) return;
    if ((event.target as Element).closest('[data-vertex]')) return;
    const point = toImagePoint(event.clientX, event.clientY);
    setWorkPoints((points) => [...points, point]);
  };

  const handleDoubleClick = () => {
    if (readOnly || !targetObjectId || workPoints.length < MIN_POINTS_TO_CLOSE) return;
    addContour(targetObjectId, drawType, workPoints);
    setWorkPoints([]);
  };

  const startDrag = (event: React.PointerEvent<SVGCircleElement>, state: DragState) => {
    if (readOnly) return;
    event.stopPropagation();
    (event.target as Element).setPointerCapture(event.pointerId);
    setDrag(state);
  };

  const handlePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!drag || !targetObjectId) return;
    const point = toImagePoint(event.clientX, event.clientY);
    const object = objects.find((item) => item.objectId === drag.objectId);
    const contour = object?.contours.find((item) => item.contourId === drag.contourId);
    if (!contour) return;
    const points = contour.points.map((item, index) => (index === drag.pointIndex ? point : item));
    updateContourPoints(drag.objectId, drag.contourId, points);
  };

  const endDrag = () => setDrag(null);

  const workPath = useMemo(() => {
    if (workPoints.length === 0) return '';
    const line = workPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    return workPoints.length >= MIN_POINTS_TO_CLOSE ? `${line} Z` : line;
  }, [workPoints]);

  return (
    <div className="canvas-wrap">
      <svg
        ref={svgRef}
        className="annotation-svg"
        viewBox={`0 0 ${image.width} ${image.height}`}
        preserveAspectRatio="xMidYMid meet"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        {image.dataUrl ? <image href={image.dataUrl} width={image.width} height={image.height} /> : (
          <rect x={0} y={0} width={image.width} height={image.height} fill="#2a2f3a" />
        )}
        {objects.map((object) =>
          object.contours.map((contour) => {
            const selected = contour.contourId === selectedContourId;
            const fill = contour.type === 'hole'
              ? 'rgba(255, 170, 0, 0.10)'
              : object.objectId === targetObjectId ? 'rgba(70, 160, 255, 0.16)' : 'rgba(120, 200, 120, 0.10)';
            const stroke = contour.type === 'hole' ? '#ffaa00' : selected ? '#3a9dff' : '#7fd08a';
            return (
              <g key={contour.contourId}>
                <path
                  d={contourToPath(contour)}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={selected ? 3 : 2}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectObject(object.objectId, contour.contourId);
                  }}
                />
                {selected && !readOnly && contour.points.map((point, index) => (
                  <circle
                    key={index}
                    data-vertex="true"
                    cx={point.x}
                    cy={point.y}
                    r={6}
                    fill="#ffffff"
                    stroke="#3a9dff"
                    strokeWidth={2}
                    style={{ cursor: 'grab' }}
                    onPointerDown={(event) => startDrag(event, {
                      objectId: object.objectId,
                      contourId: contour.contourId,
                      pointIndex: index,
                    })}
                  />
                ))}
              </g>
            );
          }),
        )}
        {!readOnly && targetObjectId && workPoints.length > 0 && (
          <g>
            <path d={workPath} fill="rgba(58, 157, 255, 0.12)" stroke="#3a9dff" strokeWidth={2} strokeDasharray="8 5" />
            {workPoints.map((point, index) => (
              <circle key={index} cx={point.x} cy={point.y} r={5} fill="#3a9dff" />
            ))}
          </g>
        )}
      </svg>
      <div className="canvas-footer">
        {readOnly
          ? '当前为已提交版本，内容固定；在右侧选择“继续调整”或对历史版本发起重工'
          : targetObjectId
            ? `正在为物体绘制${drawType === 'hole' ? '孔洞' : '外轮廓'}，已添加 ${workPoints.length} 个点（双击闭合，至少 3 点）`
            : '请先在右侧选择或新建一个物体，再在画布上绘制'}
        {!readOnly && workPoints.length > 0 && (
          <button type="button" onClick={() => setWorkPoints([])}>撤销未闭合点</button>
        )}
      </div>
    </div>
  );
}
