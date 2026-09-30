import { CheckCircle2, Circle, FileWarning } from 'lucide-react';
import { useStore } from '../store';
import { getDraft, getLatestSubmitted } from '../core/versioning';

export function ImageList() {
  const images = useStore((s) => s.images);
  const selectedId = useStore((s) => s.selectedImageId);
  const select = useStore((s) => s.selectImage);

  return (
    <aside className="image-list">
      <h3>图片列表</h3>
      {images.length === 0 && <p className="muted">点击顶部“批量导入图片”开始。</p>}
      {images.map((img) => {
        const draft = getDraft(img);
        const submitted = getLatestSubmitted(img);
        return (
          <button
            key={img.id}
            className={`image-item ${img.id === selectedId ? 'active' : ''}`}
            onClick={() => select(img.id)}
          >
            <img src={img.dataUrl} alt={img.name} />
            <span className="meta">
              <span className="name" title={img.name}>{img.name}</span>
              <span className="status">
                {submitted ? <CheckCircle2 size={13} /> : <Circle size={13} />}
                v{submitted?.version ?? '-'}
                {draft && (
                  <span className="draft-icon" title="存在草稿">
                    <FileWarning size={13} />
                  </span>
                )}
                {draft && <em>草稿 v{draft.version}</em>}
              </span>
            </span>
          </button>
        );
      })}
    </aside>
  );
}
