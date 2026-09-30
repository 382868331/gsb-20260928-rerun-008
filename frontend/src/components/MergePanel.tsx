import { useState } from 'react';
import { GitMerge, Undo2, Check } from 'lucide-react';
import { useStore } from '../store';
import type { AnnotationObject, ImageRecord, MergeConflict, Point } from '../types';

interface Shape {
  points: Point[];
  holes: Point[][];
}

function toShapes(value: unknown): Shape[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return [{ points: value as Point[], holes: [] }];
  const obj = value as AnnotationObject;
  return obj.contours.map((c) => ({ points: c.points, holes: c.holes.map((h) => h.points) }));
}

function pathOf(points: Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z';
}

function ShapeThumb({ value, color, bbox }: { value: unknown; color: string; bbox: [number, number, number, number] }) {
  const shapes = toShapes(value);
  if (!shapes) return <div className="shape-thumb deleted">已删除</div>;
  const [minX, minY, w, h] = bbox;
  return (
    <svg className="shape-thumb" viewBox={`${minX} ${minY} ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
      {shapes.map((s, i) => (
        <path
          key={i}
          d={pathOf(s.points) + ' ' + s.holes.map(pathOf).join(' ')}
          fill={color}
          fillOpacity={0.25}
          fillRule="evenodd"
          stroke={color}
          strokeWidth={Math.max(w, h) / 60}
        />
      ))}
    </svg>
  );
}

function bboxOf(values: unknown[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of values) {
    for (const s of toShapes(v) ?? []) {
      for (const p of [...s.points, ...s.holes.flat()]) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
    }
  }
  if (!Number.isFinite(minX)) return [0, 0, 1, 1];
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
  const pad = Math.max(w, h) * 0.08;
  return [minX - pad, minY - pad, w + pad * 2, h + pad * 2];
}

function ConflictCard({ conflict }: { conflict: MergeConflict }) {
  const categories = useStore((s) => s.categories);
  const resolveMerge = useStore((s) => s.resolveMerge);
  const unresolveMerge = useStore((s) => s.unresolveMerge);
  const image = useStore((s) => s.images.find((i) => i.id === s.selectedImageId));
  const choice = image?.mergeSession?.resolutions[conflict.id];
  const catName = (id: unknown) => categories.find((c) => c.id === id)?.name ?? String(id);
  const isCategory = conflict.kind === 'category';
  const bbox = bboxOf([conflict.base, conflict.left, conflict.right]);

  return (
    <div className={`conflict-card ${choice ? 'resolved' : ''}`}>
      <div className="conflict-head">
        <strong>{conflict.message}</strong>
        {choice && (
          <span className="resolved-tag">
            <Check size={13} /> 已采用{choice === 'left' ? '左侧' : '右侧'}修订
            <button className="link" onClick={() => unresolveMerge(conflict.id)}>
              <Undo2 size={13} /> 撤回
            </button>
          </span>
        )}
      </div>
      <div className="conflict-diff">
        <div className="diff-col">
          <span className="diff-label">基准（修改前）</span>
          {isCategory ? <span className="diff-cat">{catName(conflict.base)}</span> : <ShapeThumb value={conflict.base} color="#6b7280" bbox={bbox} />}
        </div>
        <div className={`diff-col ${choice === 'left' ? 'chosen' : ''}`}>
          <span className="diff-label">左侧修订</span>
          {isCategory ? <span className="diff-cat">{catName(conflict.left)}</span> : <ShapeThumb value={conflict.left} color="#3b82f6" bbox={bbox} />}
          <button disabled={choice === 'left'} onClick={() => resolveMerge(conflict.id, 'left')}>采用左侧</button>
        </div>
        <div className={`diff-col ${choice === 'right' ? 'chosen' : ''}`}>
          <span className="diff-label">右侧修订</span>
          {isCategory ? <span className="diff-cat">{catName(conflict.right)}</span> : <ShapeThumb value={conflict.right} color="#f59e0b" bbox={bbox} />}
          <button disabled={choice === 'right'} onClick={() => resolveMerge(conflict.id, 'right')}>采用右侧</button>
        </div>
      </div>
    </div>
  );
}

export function MergePanel({ image }: { image: ImageRecord }) {
  const cancelMergeSession = useStore((s) => s.cancelMergeSession);
  const finalizeMergeSession = useStore((s) => s.finalizeMergeSession);
  const [note, setNote] = useState('');
  const session = image.mergeSession;
  if (!session) return null;
  const total = session.conflicts.length;
  const done = session.conflicts.filter((c) => c.id in session.resolutions).length;

  return (
    <div className="merge-panel">
      <header className="merge-head">
        <GitMerge size={16} />
        <strong>
          合并 v{session.leftVersion} + v{session.rightVersion}（共同基准 v{session.baseVersion}）
        </strong>
        <span className="muted">
          {total === 0 ? '没有冲突，互不冲突的修改已自动合并' : `争议 ${done}/${total} 已确认`}
        </span>
      </header>
      {session.conflicts.map((c) => (
        <ConflictCard key={c.id} conflict={c} />
      ))}
      <footer className="merge-actions">
        <input
          placeholder="合并提交说明（可选）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          className="primary"
          disabled={done < total}
          title={done < total ? `还有 ${total - done} 项争议未确认` : undefined}
          onClick={() => {
            finalizeMergeSession(note.trim() || undefined);
            setNote('');
          }}
        >
          <GitMerge size={15} /> 完成合并（生成新提交，历史版本不变）
        </button>
        <button onClick={() => confirm('取消合并？已做的确认将丢弃，两条修订版本不受影响。') && cancelMergeSession()}>
          取消合并
        </button>
      </footer>
    </div>
  );
}
