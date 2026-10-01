import { useMemo, useState } from 'react';
import { GitMerge, Undo2, X } from 'lucide-react';
import { useStore } from '../store';
import { planMergeWithRelations } from '../core/merge';
import type { Category, ImageRecord, MergeConflict } from '../types';

function isPoints(v: unknown): v is { x: number; y: number }[] {
  return Array.isArray(v) && v.every((p) => p && typeof p === 'object' && 'x' in p);
}

function ValueView({ value, categories }: { value: unknown; categories: Category[] }) {
  if (value === '（已删除）') return <span className="val deleted">已删除</span>;
  if (typeof value === 'string') {
    const cat = categories.find((c) => c.id === value);
    return <span className="val">{cat ? cat.name : value}</span>;
  }
  if (isPoints(value)) {
    return (
      <span className="val" title={JSON.stringify(value)}>
        {value.length} 个顶点
      </span>
    );
  }
  if (value && typeof value === 'object') {
    const obj = value as { categoryId?: string; contours?: unknown[] };
    if (obj.categoryId) {
      const cat = categories.find((c) => c.id === obj.categoryId);
      return (
        <span className="val">
          类别 {cat?.name ?? obj.categoryId}，{obj.contours?.length ?? 0} 个轮廓
        </span>
      );
    }
    const contour = value as { points?: unknown[]; holes?: unknown[] };
    if (contour.points) {
      return (
        <span className="val">
          {contour.points.length} 个顶点，{contour.holes?.length ?? 0} 个孔洞
        </span>
      );
    }
  }
  return <span className="val">{String(value)}</span>;
}

function ConflictRow({
  conflict,
  choice,
  categories,
  onPick,
  onUndo,
}: {
  conflict: MergeConflict;
  choice: string | undefined;
  categories: Category[];
  onPick: (c: 'a' | 'b' | 'discard' | 'disputed') => void;
  onUndo: () => void;
}) {
  return (
    <li className={'conflict' + (choice ? ' resolved' : '')}>
      <p className="conflict-msg">{conflict.message}</p>
      <div className="conflict-values">
        <div className="val-col">
          <em>基线</em>
          <ValueView value={conflict.baseValue} categories={categories} />
        </div>
        <div className={'val-col' + (choice === 'a' ? ' picked' : '')}>
          <em>修订 A</em>
          <ValueView value={conflict.aValue} categories={categories} />
        </div>
        <div className={'val-col' + (choice === 'b' ? ' picked' : '')}>
          <em>修订 B</em>
          <ValueView value={conflict.bValue} categories={categories} />
        </div>
      </div>
      <div className="conflict-actions">
        <button className="primary" disabled={choice === 'a'} onClick={() => onPick('a')}>
          采用 A
        </button>
        <button className="primary" disabled={choice === 'b'} onClick={() => onPick('b')}>
          采用 B
        </button>
        <button disabled={choice === 'discard'} onClick={() => onPick('discard')}>舍弃双方修改</button>
        <button disabled={choice === 'disputed'} onClick={() => onPick('disputed')}>保留争议</button>
        {choice && (
          <button onClick={onUndo} title="撤回该项确认，不影响其他决定">
            <Undo2 size={13} /> 撤回
          </button>
        )}
      </div>
    </li>
  );
}

function RelationRow({
  conflict,
  choice,
  onPick,
  onUndo,
}: {
  conflict: MergeConflict;
  choice: string | undefined;
  onPick: (c: 'a' | 'b' | 'discard' | 'disputed') => void;
  onUndo: () => void;
}) {
  return (
    <li className={'conflict relation' + (choice ? ' resolved' : '')}>
      <p className="conflict-msg">{conflict.message}</p>
      <p className="muted">
        旧对象 {(conflict.sourceObjectIds ?? []).map((id) => id.slice(-6)).join('、')}；
        新对象 {(conflict.targetObjectIds ?? []).map((id) => id.slice(-6)).join('、')}。
        先确认关系后，类别、外轮廓和孔洞冲突会按对应部分展开。
      </p>
      <div className="conflict-actions">
        <button className="primary" disabled={choice === 'a'} onClick={() => onPick('a')}>采用 A 拆合</button>
        <button className="primary" disabled={choice === 'b'} onClick={() => onPick('b')}>采用 B 拆合</button>
        <button disabled={choice === 'discard'} onClick={() => onPick('discard')}>舍弃拆合</button>
        <button disabled={choice === 'disputed'} onClick={() => onPick('disputed')}>保留争议</button>
        {choice && <button onClick={onUndo}><Undo2 size={13} /> 撤回关系</button>}
      </div>
    </li>
  );
 }

export function MergePanel({ image }: { image: ImageRecord }) {
  const categories = useStore((s) => s.categories);
  const session = useStore((s) => s.mergeSessions.find((m) => m.imageId === image.id));
  const startMerge = useStore((s) => s.startMerge);
  const resolveConflict = useStore((s) => s.resolveConflict);
  const resolveRelation = useStore((s) => s.resolveRelation);
  const unresolveConflict = useStore((s) => s.unresolveConflict);
  const unresolveRelation = useStore((s) => s.unresolveRelation);
  const cancelMerge = useStore((s) => s.cancelMerge);
  const completeMerge = useStore((s) => s.completeMerge);
  const submitted = image.versions.filter((v) => v.status === 'submitted');
  const [aVer, setAVer] = useState<number | ''>('');
  const [bVer, setBVer] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);

  const conflicts = useMemo(() => {
    if (!session) return [];
    try {
      return planMergeWithRelations(image, session.aVersion, session.bVersion, session.relations).conflicts;
    } catch {
      return [];
    }
  }, [image, session]);

  if (!session) {
    return (
      <div className="merge-panel">
        <h3>
          <GitMerge size={15} /> 合并两条修订
        </h3>
        {submitted.length < 2 ? (
          <p className="muted">至少需要两个已提交版本才能合并。</p>
        ) : (
          <div className="merge-setup">
            <label>
              修订 A
              <select value={aVer} onChange={(e) => setAVer(Number(e.target.value) || '')}>
                <option value="">选择版本</option>
                {submitted.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                    {v.basedOn != null ? '（基于 v' + v.basedOn + '）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              修订 B
              <select value={bVer} onChange={(e) => setBVer(Number(e.target.value) || '')}>
                <option value="">选择版本</option>
                {submitted.map((v) => (
                  <option key={v.version} value={v.version}>
                    v{v.version}
                    {v.basedOn != null ? '（基于 v' + v.basedOn + '）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primary"
              disabled={aVer === '' || bVer === ''}
              onClick={() => {
                try {
                  startMerge(Number(aVer), Number(bVer));
                  setError(null);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <GitMerge size={14} /> 开始合并
            </button>
            {error && <p className="error">{error}</p>}
          </div>
        )}
      </div>
    );
  }

  const isRelation = (c: MergeConflict) => c.part === 'split-relation' || c.part === 'merge-relation';
  const relationDone = conflicts.filter(isRelation).every((c) => session.relations[c.id] && session.relations[c.id] !== 'disputed');
  const decisionDone = conflicts.filter((c) => !isRelation(c)).every((c) => session.resolutions[c.id] && session.resolutions[c.id] !== 'disputed');
  const allDone = conflicts.length > 0 && relationDone && decisionDone;
  const done = conflicts.filter((c) => isRelation(c)
    ? session.relations[c.id] && session.relations[c.id] !== 'disputed'
    : session.resolutions[c.id] && session.resolutions[c.id] !== 'disputed').length;
  return (
    <div className="merge-panel">
      <h3>
        <GitMerge size={15} /> 合并 v{session.aVersion} 与 v{session.bVersion}（基线 v
        {session.baseVersion}）
      </h3>
      <p className="muted">
        互不冲突的修改已自动保留；{conflicts.length} 处冲突待确认，已确认 {done}/
        {conflicts.length}。进度已自动保存，可随时离开后继续。
      </p>
      {conflicts.length > 0 && (
        <ul className="conflict-list">
          {conflicts.map((c) => isRelation(c) ? (
            <RelationRow
              key={c.id}
              conflict={c}
              choice={session.relations[c.id]}
              onPick={(choice) => resolveRelation(c.id, choice)}
              onUndo={() => unresolveRelation(c.id)}
            />
          ) : (
            <ConflictRow
              key={c.id}
              conflict={c}
              choice={session.resolutions[c.id]}
              categories={categories}
              onPick={(choice) => resolveConflict(c.id, choice)}
              onUndo={() => unresolveConflict(c.id)}
            />
          ))}
        </ul>
      )}
      <div className="merge-actions">
        <button
          className="primary"
          disabled={!allDone}
          title={allDone ? '生成新的合并提交' : '还有冲突未确认'}
          onClick={() => completeMerge()}
        >
          <GitMerge size={14} /> 完成合并（生成新提交，历史版本不变）
        </button>
        <button onClick={() => confirm('放弃本次合并？已做的确认将丢失。') && cancelMerge()}>
          <X size={14} /> 放弃合并
        </button>
      </div>
    </div>
  );
}
