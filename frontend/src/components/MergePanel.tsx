import { Component, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, GitMerge, Save, Undo2, X } from 'lucide-react';
import { useStore } from '../store';
import { planMerge, type MergePlan } from '../core/merge';
import type {
  Category,
  ImageRecord,
  MergeConflict,
  MergeRelation,
  MergeRelationDecision,
  MergeResolution,
} from '../types';

class PanelBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="merge-panel">
          <h3><GitMerge size={15} /> 合并面板出现渲染问题</h3>
          <p className="error">{this.state.error.message}</p>
          <p className="muted">
            已确认的决定与原修订都没有丢失：刷新页面或重新进入该图片即可继续。合并未完成前不会生成任何新提交。
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const FRAGMENT_PARTS = new Set(['category', 'outline', 'hole', 'hole-cross', 'duplicate-region', 'hole-existence']);

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
  relationChoice,
  fragmentLocked,
  chain,
  onPick,
  onRelation,
  onUndo,
}: {
  conflict: MergeConflict;
  choice: MergeResolution | MergeRelationDecision | undefined;
  categories: Category[];
  relationChoice?: MergeRelationDecision;
  fragmentLocked?: boolean;
  chain?: MergeRelation[];
  onPick: (c: MergeResolution) => void;
  onRelation: (c: MergeRelationDecision) => void;
  onUndo: () => void;
}) {
  const isRelation = !FRAGMENT_PARTS.has(conflict.part);
  const sourceIds = [...new Set((conflict.sources ?? []).map((s) => s.objectId))];
  return (
    <li className={'conflict' + (choice ? ' resolved' : '')}>
      <p className="conflict-msg">{conflict.message}</p>
      {chain && chain.length > 0 && (
        <p className="conflict-chain" title="沿多次拆合追溯到的基线来源">
          {chain.map((rel, i) => (
            <span key={rel.id} className="chain-step">
              {i > 0 && <ChevronRight size={11} />}
              {rel.kind === 'split' ? '拆分' : rel.kind === 'merge' ? '合并' : '孔洞提升'}
              ：{rel.sourceObjectIds.join('、')} → {rel.targetObjectIds.join('、')}
            </span>
          ))}
        </p>
      )}
      {sourceIds.length > 0 && (
        <p className="conflict-sources muted">最终区域来源（基线物体）：{sourceIds.join('、')}</p>
      )}
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
        {isRelation ? (
          <>
            <button className="primary" disabled={relationChoice === 'confirmed'} onClick={() => onRelation('confirmed')}>
              确认关系
            </button>
            <button disabled={relationChoice === 'rejected'} onClick={() => onRelation('rejected')}>
              舍弃关系
            </button>
            <button disabled={relationChoice === 'disputed'} onClick={() => onRelation('disputed')}>
              保留争议
            </button>
          </>
        ) : (
          <>
            <button className="primary" disabled={!!choice || fragmentLocked} onClick={() => onPick('adopt-a')}>
              采用 A
            </button>
            <button className="primary" disabled={!!choice || fragmentLocked} onClick={() => onPick('adopt-b')}>
              采用 B
            </button>
            <button disabled={!!choice || fragmentLocked} onClick={() => onPick('discard')}>
              舍弃
            </button>
            <button disabled={!!choice || fragmentLocked} onClick={() => onPick('disputed')}>
              保留争议
            </button>
          </>
        )}
        {choice && (
          <button onClick={onUndo} title="撤回该项确认，不影响其他决定">
            <Undo2 size={13} /> 撤回
          </button>
        )}
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
  const cancelMerge = useStore((s) => s.cancelMerge);
  const completeMerge = useStore((s) => s.completeMerge);
  const submitted = image.versions.filter((v) => v.status === 'submitted');
  const [aVer, setAVer] = useState<number | ''>('');
  const [bVer, setBVer] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);
  // 退出候选：只影响界面展示，决定仍保留在会话中，随时可再次进入
  const [exited, setExited] = useState(false);

  const plan: MergePlan | null = useMemo(() => {
    if (!session) return null;
    return planMerge(image, session.aVersion, session.bVersion);
  }, [image, session]);
  const conflicts = plan?.conflicts ?? [];
  const relations = plan?.relations ?? [];
  const relationById = useMemo(() => new Map(relations.map((rel) => [rel.id, rel])), [relations]);

  const isRelationConflict = (c: MergeConflict) => c.id.startsWith('conflict:relation:');
  const relationIdOf = (c: MergeConflict) => c.id.slice('conflict:'.length);
  const statusOf = (c: MergeConflict) =>
    isRelationConflict(c)
      ? session?.relations?.[relationIdOf(c)]
      : session?.resolutions[c.id];
  const done = session ? conflicts.filter((c) => statusOf(c)).length : 0;
  const allDone = conflicts.length > 0 && conflicts.length === done;
  // 沿 prerequisiteRelationIds 拼出多次拆合的来源链
  const chainOf = (c: MergeConflict): MergeRelation[] => {
    if (!c.dependsOn) return [];
    const chain: MergeRelation[] = [];
    let current = relationById.get(c.dependsOn);
    const guard = new Set<string>();
    while (current && !guard.has(current.id)) {
      guard.add(current.id);
      chain.unshift(current);
      const prereqId = current.prerequisiteRelationIds?.[0];
      current = prereqId ? relationById.get(prereqId) : undefined;
    }
    return chain;
  };

  const handleComplete = () => {
    try {
      completeMerge();
      setExited(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const setupView = (
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

  if (!session || exited) {
    return (
      <PanelBoundary>
        {session && (
          <div className="merge-panel merge-resume">
            <h3><GitMerge size={15} /> 合并进行中</h3>
            <p className="muted">
              v{session.aVersion} 与 v{session.bVersion}（基线 v{session.baseVersion}）：已确认 {done}/{conflicts.length} 处。
              原修订与已作决定均保留，合并未完成前不会生成新提交。
            </p>
            <div className="merge-actions">
              <button className="primary" onClick={() => { setExited(false); setError(null); }}>
                <GitMerge size={14} /> 再次进入合并
              </button>
              <button
                onClick={() => confirm('放弃本次合并？已做的确认将丢失，原修订与冻结提交不受影响。') && cancelMerge()}
              >
                <X size={14} /> 放弃合并
              </button>
            </div>
          </div>
        )}
        {!session && setupView}
      </PanelBoundary>
    );
  }

  return (
    <PanelBoundary>
    <div className="merge-panel">
      <h3>
        <GitMerge size={15} /> 合并 v{session.aVersion} 与 v{session.bVersion}（基线 v
        {session.baseVersion}）
      </h3>
      <p className="muted">
        互不冲突的修改已自动保留；{conflicts.length} 处待处理，已决定 {done}/{conflicts.length}。
        可只确认来源链的一部分后保存退出，之后再次进入继续；合并完成前不会产生新提交，原修订始终可追溯。
      </p>
      {conflicts.length > 0 && (
        <ul className="conflict-list">
          {conflicts.map((c) => (
            <ConflictRow
              key={c.id}
              conflict={c}
              choice={statusOf(c)}
              relationChoice={session.relations?.[relationIdOf(c)] as MergeRelationDecision | undefined}
              fragmentLocked={!!c.dependsOn && session.relations?.[c.dependsOn] !== 'confirmed'}
              chain={chainOf(c)}
              categories={categories}
              onPick={(choice) => { resolveConflict(c.id, choice); setError(null); }}
              onRelation={(decision) => { resolveRelation(relationIdOf(c), decision); setError(null); }}
              onUndo={() => unresolveConflict(c.id)}
            />
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
      <div className="merge-actions">
        <button
          className="primary"
          disabled={!allDone}
          title={allDone ? '生成新的合并提交' : '还有冲突未确认，可先保存退出稍后继续'}
          onClick={handleComplete}
        >
          <GitMerge size={14} /> 完成合并（生成新提交，历史版本不变）
        </button>
        <button onClick={() => setExited(true)} title="保存已作决定并退出候选，随时可再次进入">
          <Save size={14} /> 保存并退出候选
        </button>
        <button onClick={() => confirm('放弃本次合并？已做的确认将丢失，原修订与冻结提交不受影响。') && cancelMerge()}>
          <X size={14} /> 放弃合并
        </button>
      </div>
    </div>
    </PanelBoundary>
  );
}
