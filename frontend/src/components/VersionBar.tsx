import { useState } from 'react';
import { GitCommit, History, Ban, ShieldCheck } from 'lucide-react';
import { useStore } from '../store';
import { getDraft, getLatestSubmitted } from '../core/versioning';
import type { ImageRecord } from '../types';

export function VersionBar({ image }: { image: ImageRecord }) {
  const submit = useStore((s) => s.submit);
  const rework = useStore((s) => s.rework);
  const discard = useStore((s) => s.discard);
  const [note, setNote] = useState('');
  const draft = getDraft(image);
  const latest = getLatestSubmitted(image);

  return (
    <div className="version-bar">
      <div className="versions">
        {image.versions.map((v) => (
          <span key={v.version} className={`v-chip ${v.status}`}>
            {v.status === 'submitted' ? <ShieldCheck size={13} /> : <History size={13} />}
            v{v.version}
            {v.status === 'submitted' ? ' 已冻结' : ' 草稿'}
            {v.basedOn != null && <em>（返工自 v{v.basedOn}）</em>}
            {v.mergeOf && (
              <em>
                （合并 v{v.mergeOf.a} + v{v.mergeOf.b}，基线 v{v.mergeOf.base}）
              </em>
            )}
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
        </div>
      )}
    </div>
  );
}
