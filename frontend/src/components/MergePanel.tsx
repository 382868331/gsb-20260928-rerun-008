import { useMemo, useState } from 'react';
import { GitMerge, ListChecks, ShieldCheck, Undo2, X } from 'lucide-react';
import { useStore } from '../store';
import { planMerge } from '../core/merge';
import { buildMergePlanning } from '../core/planning';
import type { Category, ImageRecord, MergeConflict, MergeRelationDecision, MergeResolution } from '../types';

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
  onPick,
  onRelation,
  onUndo,
}: {
  conflict: MergeConflict;
  choice: MergeResolution | MergeRelationDecision | undefined;
  categories: Category[];
  relationChoice?: MergeRelationDecision;
  fragmentLocked?: boolean;
  onPick: (c: MergeResolution) => void;
  onRelation: (c: MergeRelationDecision) => void;
  onUndo: () => void;
}) {
  const isRelation = conflict.part === 'split-relation' || conflict.part === 'merge-relation' || conflict.part === 'hole-promotion';
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
  const addMergeConstraint = useStore((s) => s.addMergeConstraint);
  const removeMergeConstraint = useStore((s) => s.removeMergeConstraint);
  const approveMergePlan = useStore((s) => s.approveMergePlan);
  const submitted = image.versions.filter((v) => v.status === 'submitted');
  const [aVer, setAVer] = useState<number | ''>('');
  const [bVer, setBVer] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [groupTargets, setGroupTargets] = useState<string[]>([]);

  const conflicts = useMemo(() => {
    if (!session) return [];
    try {
      return planMerge(image, session.aVersion, session.bVersion).conflicts;
    } catch {
      return [];
    }
  }, [image, session]);

  const relationById = useMemo(() => {
    if (!session) return new Map<string, MergeRelationDecision>();
    try {
      return new Map(planMerge(image, session.aVersion, session.bVersion).relations.map((r) => [r.id, session.relations?.[r.id]]).filter((x): x is [string, MergeRelationDecision] => !!x[1]));
    } catch {
      return new Map();
    }
  }, [image, session]);

  const planning = useMemo(() => {
    if (!session) return null;
    try {
      return buildMergePlanning(image, session.aVersion, session.bVersion, session.constraints ?? [], session);
    } catch {
      return null;
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

  const isRelationConflict = (c: MergeConflict) => c.id.startsWith('conflict:relation:');
  const statusOf = (c: MergeConflict) =>
    isRelationConflict(c)
      ? session.relations?.[c.id.slice('conflict:'.length)]
      : session.resolutions[c.id];
  const done = conflicts.filter((c) => statusOf(c)).length;
  const allDone = conflicts.length === done;
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
      {planning && (
        <PlanningSection
          planning={planning}
          categories={categories}
          constraints={session.constraints ?? []}
          baseSourceIds={planning.baseSourceIds}
          groupTargets={groupTargets}
          setGroupTargets={setGroupTargets}
          onAddCategory={(sourceObjectIds, categoryId) => addMergeConstraint({ kind: 'category', sourceObjectIds, categoryId })}
          onAddGroup={(sourceObjectIds) =>
            addMergeConstraint({ kind: 'group', sourceObjectIds, groupId: 'grp-' + Date.now() })
          }
          onRemoveConstraint={removeMergeConstraint}
          onApprove={(candidateIds) => {
            try {
              approveMergePlan(candidateIds);
              setError(null);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
      )}
      {conflicts.length > 0 && (
        <ul className="conflict-list">
          {conflicts.map((c) => (
            <ConflictRow
              key={c.id}
              conflict={c}
              choice={statusOf(c)}
              relationChoice={relationById.get(c.id.slice('conflict:'.length))}
              fragmentLocked={!!c.dependsOn && session.relations?.[c.dependsOn] !== 'confirmed'}
              categories={categories}
              onPick={(choice) => resolveConflict(c.id, choice)}
              onRelation={(decision) => resolveRelation(c.id.slice('conflict:'.length), decision)}
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
          onClick={() => {
            try {
              completeMerge();
              setError(null);
            } catch (err) {
              // 合并失败时保留会话与已确认的决定，界面不崩溃
              setError((err as Error).message);
            }
          }}
        >
          <GitMerge size={14} /> 完成合并（生成新提交，历史版本不变）
        </button>
        <button onClick={() => confirm('放弃本次合并？已做的确认将丢失。') && cancelMerge()}>
          <X size={14} /> 放弃合并
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function PlanningSection({
  planning,
  categories,
  constraints,
  baseSourceIds,
  groupTargets,
  setGroupTargets,
  onAddCategory,
  onAddGroup,
  onRemoveConstraint,
  onApprove,
}: {
  planning: ReturnType<typeof buildMergePlanning>;
  categories: Category[];
  constraints: NonNullable<ReturnType<typeof useStore.getState>['mergeSessions'][number]['constraints']>;
  baseSourceIds: string[];
  groupTargets: string[];
  setGroupTargets: (ids: string[]) => void;
  onAddCategory: (sourceObjectIds: string[], categoryId: string) => void;
  onAddGroup: (sourceObjectIds: string[]) => void;
  onRemoveConstraint: (id: string) => void;
  onApprove: (candidateIds: string[]) => void;
}) {
  const topOptions = planning.options.slice(0, 3);
  const [categorySource, setCategorySource] = useState(baseSourceIds[0] ?? '');
  const [categoryPick, setCategoryPick] = useState(categories[0]?.id ?? '');
  const toggleGroup = (id: string) =>
    setGroupTargets(groupTargets.includes(id) ? groupTargets.filter((x) => x !== id) : [...groupTargets, id]);
  return (
    <div className="planning-section">
      <h4>
        <ShieldCheck size={14} /> 来源保留约束
      </h4>
      {constraints.length > 0 && (
        <ul className="constraint-list">
          {constraints.map((c) => (
            <li key={c.id}>
              {c.kind === 'category'
                ? '类别约束：' + c.sourceObjectIds.join(', ') + ' → ' + (categories.find((x) => x.id === c.categoryId)?.name ?? c.categoryId)
                : '分组约束：' + c.sourceObjectIds.join('、') + ' 必须共同保留'}
              <button title="删除该约束" onClick={() => onRemoveConstraint(c.id)}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="constraint-editor">
        <select value={categorySource} onChange={(e) => setCategorySource(e.target.value)}>
          {baseSourceIds.map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>
        <select value={categoryPick} onChange={(e) => setCategoryPick(e.target.value)}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <button disabled={!categorySource || !categoryPick} onClick={() => onAddCategory([categorySource], categoryPick)}>
          要求保留类别
        </button>
      </div>
      <div className="constraint-editor">
        <div className="group-pick">
          {baseSourceIds.map((id) => (
            <label key={id}>
              <input type="checkbox" checked={groupTargets.includes(id)} onChange={() => toggleGroup(id)} /> {id}
            </label>
          ))}
        </div>
        <button disabled={groupTargets.length < 2} onClick={() => { onAddGroup(groupTargets); setGroupTargets([]); }}>
          要求同组保留
        </button>
      </div>

      <h4>
        <ListChecks size={14} /> 可比较的合并方案（按剩余冲突最少排序）
      </h4>
      <ul className="plan-option-list">
        {topOptions.map((option, index) => (
          <li key={option.id} className={option.complete ? 'complete' : 'incomplete'}>
            <p className="plan-summary">
              方案 {index + 1}：{option.summary}
              {!option.complete && <em className="warn">（未覆盖全部来源）</em>}
              {option.violatedConstraintIds.length > 0 && (
                <em className="warn">（违反 {option.violatedConstraintIds.length} 条约束）</em>
              )}
              {option.conflictingDecisionIds.length > 0 && (
                <em className="warn">（需撤回 {option.conflictingDecisionIds.length} 项旧决定）</em>
              )}
            </p>
            <p className="plan-candidates muted">
              {option.candidateIds
                .map((id) => planning.candidates.find((c) => c.id === id)?.label ?? id)
                .join('；') || '（不采用任何关系，仅保留独立来源）'}
            </p>
            <button className="primary" disabled={!option.complete} onClick={() => onApprove(option.candidateIds)}>
              批准整份（写入依赖闭合）
            </button>
          </li>
        ))}
      </ul>
      {planning.unsatisfiableSets.length > 0 && (
        <div className="unsat-sets">
          <h4>无法同时满足的决定集合</h4>
          <ul>
            {planning.unsatisfiableSets.slice(0, 5).map((set, i) => (
              <li key={i} className="warn">{set.message}</li>
            ))}
          </ul>
        </div>
      )}
      {planning.pending.length > 0 && (
        <p className="muted">当前未决范围：{planning.pending.length} 项（关系与已确认关系上的片段决定）。</p>
      )}
    </div>
  );
}
