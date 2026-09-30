import { useState } from 'react';
import { useStore } from '../store/store';
import type { ImageRecord } from '../core/types';

export function VersionPanel({ record }: { record: ImageRecord | null }) {
  const reworkFromVersion = useStore((state) => state.reworkFromVersion);
  const [busyVersionId, setBusyVersionId] = useState<string | null>(null);

  if (!record) return null;

  return (
    <section className="inspector-section">
      <h2>版本记录（{record.versions.length}）</h2>
      {record.versions.length === 0 && <p className="muted">尚未提交过版本。</p>}
      <ul className="version-list">
        {record.versions.map((version) => {
          const isLatest = version.versionNo === record.versions[record.versions.length - 1].versionNo;
          const isBase = record.draft?.basedOnVersionId === version.versionId;
          return (
            <li key={version.versionId} className={isBase ? 'version-item base' : 'version-item'}>
              <div className="version-head">
                <strong>v{version.versionNo}{isLatest ? '（最新）' : ''}</strong>
                <span className="muted">{version.submittedAt.slice(0, 19).replace('T', ' ')}</span>
              </div>
              <div className="muted">
                {version.objects.length} 个物体
                {version.basedOnVersionId ? ' · 返工版本' : ' · 首次提交'}
              </div>
              {isBase && <div className="muted">当前草稿基于此版本返工</div>}
              {!record.draft && (
                <button
                  type="button"
                  disabled={busyVersionId !== null}
                  onClick={() => {
                    setBusyVersionId(version.versionId);
                    reworkFromVersion(version.versionId);
                    setBusyVersionId(null);
                  }}
                >
                  {isLatest ? '基于此版本继续调整' : '返工此历史版本（另留新版本）'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
