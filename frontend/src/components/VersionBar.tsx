import { useState } from 'react';
import { GitCommit, GitMerge, History, Ban, ShieldCheck } from 'lucide-react';
import { useStore } from '../store';
import { getDraft, getLatestSubmitted } from '../core/versioning';
import type { ImageRecord } from '../types';

export function VersionBar({ image }: { image: ImageRecord }) {
  const submit = useStore((s) => s.submit);
  const rework = useStore((s) => s.rework);
  const discard = useStore((s) => s.discard);
  const startMerge = useStore((s) => s.startMerge);
  const [note, setNote] = useState('');
  const [mergeLeft, setMergeLeft] = useState('');
  const [mergeRight, setMergeRight] = useState('');
  const [mergeError, setMergeError] = useState('');
  const draft = getDraft(image);
  const latest = getLatestSubmitted(image);
  const submitted = image.versions.filter((v) => v.status === 'submitted');
  const mergeable = submitted.filter((v) =>
    submitted.some((o) => o.version !== v.version && o.basedOn === v.basedOn && v.basedOn != null),
  );

  return (
    <div className="version-bar">
      <div className="versions">
        {image.versions.map((v) => (
          <span key={v.version} className={`v-chip ${v.status}`}>
            {v.status === 'submitted' ? <ShieldCheck size={13} /> : <History size={13} />}
            v{v.version}
            {v.status === 'submitted' ? ' 已冻结' : ' 草稿'}
            {v.basedOn != null && <em>（返工自 v{v.basedOn}）</em>}
            {v.mergeOf && <em>（合并 v{v.mergeOf[0]} + v{v.mergeOf[1]}）</em>}
          </span>
        ))}
      </div>
      {draft ? (
        <div className="version-actions">
          <input
            placeholder="提交说明（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            className="primary"
            onClick={() => {
              submit(note.trim() || undefined);
              setNote('');
            }}
          >
            <GitCommit size={15} /> 提交草稿（提交后版本固定）
          </button>
          <button onClick={() => confirm('丢弃当前草稿？已提交版本不受影响。') && discard()}>
            <Ban size={14} /> 丢弃草稿
          </button>
        </div>
      ) : (
        <div className="version-actions">
          <span className="muted">最新已提交：v{latest?.version ?? '无'}</span>
          <button className="primary" onClick={() => rework()} disabled={!latest}>
            <History size={15} /> 发起返工（另起新版本，保留物体 id）
          </button>
          {submitted.length > 1 && (
            <select
              value=""
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v) rework(undefined, v);
              }}
            >
              <option value="">从指定版本返工…</option>
              {submitted.map((v) => (
                <option key={v.version} value={v.version}>
                  返工自 v{v.version}
                </option>
              ))}
            </select>
          )}
          {mergeable.length >= 2 && !image.mergeSession && (
            <span className="merge-starter">
              <GitMerge size={14} />
              <select value={mergeLeft} onChange={(e) => setMergeLeft(e.target.value)}>
                <option value="">左侧修订</option>
                {submitted.map((v) => (
                  <option key={v.version} value={v.version}>v{v.version}</option>
                ))}
              </select>
              <select value={mergeRight} onChange={(e) => setMergeRight(e.target.value)}>
                <option value="">右侧修订</option>
                {submitted.map((v) => (
                  <option key={v.version} value={v.version}>v{v.version}</option>
                ))}
              </select>
              <button
                disabled={!mergeLeft || !mergeRight}
                onClick={() => {
                  try {
                    startMerge(Number(mergeLeft), Number(mergeRight));
                    setMergeError('');
                    setMergeLeft('');
                    setMergeRight('');
                  } catch (err) {
                    setMergeError((err as Error).message);
                  }
                }}
              >
                发起合并
              </button>
              {mergeError && <span className="error">{mergeError}</span>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
