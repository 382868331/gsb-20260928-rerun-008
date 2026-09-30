import { useRef } from 'react';
import { useStore } from '../store/store';
import { latestVersion } from '../core/project';

export function ImageSidebar() {
  const project = useStore((state) => state.project);
  const selectedImageId = useStore((state) => state.selectedImageId);
  const selectImage = useStore((state) => state.selectImage);
  const importImageFiles = useStore((state) => state.importImageFiles);
  const fileIssues = useStore((state) => state.fileIssues);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <section className="sidebar-section">
      <div className="sidebar-head">
        <h2>图片（{project.images.length}）</h2>
        <button type="button" onClick={() => inputRef.current?.click()}>批量导入</button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length > 0) void importImageFiles(files);
          }}
        />
      </div>
      {fileIssues.length > 0 && (
        <ul className="issue-mini">
          {fileIssues.map((item, index) => (
            <li key={`${item.name}-${index}`} title={item.message}>
              {item.name}：{item.message}
            </li>
          ))}
        </ul>
      )}
      <ul className="image-list">
        {project.images.map((record) => {
          const version = latestVersion(record);
          const status = record.draft
            ? `草稿 · v${(version?.versionNo ?? 0) + 1}`
            : version
              ? `已提交 v${version.versionNo}`
              : '未标注';
          return (
            <li key={record.image.imageId}>
              <button
                type="button"
                className={record.image.imageId === selectedImageId ? 'image-item active' : 'image-item'}
                onClick={() => selectImage(record.image.imageId)}
              >
                {record.image.dataUrl
                  ? <img src={record.image.dataUrl} alt={record.image.name} />
                  : <span className="thumb-missing">缺图</span>}
                <span className="image-info">
                  <span className="image-name">{record.image.name}</span>
                  <span className={`image-status status-${record.draft ? 'draft' : version ? 'done' : 'none'}`}>{status}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
