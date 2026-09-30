import { useRef, useState } from 'react';
import { useStore } from '../store/store';
import { ImageSidebar } from './ImageSidebar';
import { AnnotationCanvas } from './AnnotationCanvas';
import { ObjectPanel } from './ObjectPanel';
import { VersionPanel } from './VersionPanel';
import { IssueList } from './IssueList';

export function App() {
  const project = useStore((state) => state.project);
  const selectedImageId = useStore((state) => state.selectedImageId);
  const selectedObjectId = useStore((state) => state.selectedObjectId);
  const exportBundleFile = useStore((state) => state.exportBundleFile);
  const importBundleFile = useStore((state) => state.importBundleFile);
  const addCategory = useStore((state) => state.addCategory);
  const [newCategory, setNewCategory] = useState('');
  const [drawType, setDrawType] = useState<'outer' | 'hole'>('outer');
  const bundleInputRef = useRef<HTMLInputElement>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);

  const record = project.images.find((item) => item.image.imageId === selectedImageId) ?? null;

  function downloadBundle(includeImages: boolean) {
    const json = exportBundleFile(includeImages);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${project.name}-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleBundleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBundleError(null);
    const result = await importBundleFile(file);
    if (!result.ok) setBundleError(result.error ?? '导入失败');
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1>图像标注生产平台</h1>
        <div className="project-meta">
          <span>{project.name}</span>
          <span>{project.images.length} 张图片</span>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={() => downloadBundle(true)}>导出（含图片）</button>
          <button type="button" onClick={() => downloadBundle(false)}>导出（仅标注）</button>
          <button type="button" onClick={() => bundleInputRef.current?.click()}>导入核对</button>
          <input ref={bundleInputRef} type="file" accept="application/json,.json" hidden onChange={handleBundleFile} />
        </div>
      </header>
      {bundleError && (
        <div className="banner banner-error" role="alert">
          导入文件无法解析：{bundleError}
        </div>
      )}
      <div className="workspace">
        <aside className="pane sidebar">
          <ImageSidebar />
        </aside>
        <main className="pane canvas-pane">
          <div className="canvas-toolbar">
            <label>绘制类型
              <select value={drawType} onChange={(event) => setDrawType(event.target.value as 'outer' | 'hole')}>
                <option value="outer">外轮廓</option>
                <option value="hole">孔洞</option>
              </select>
            </label>
            <span className="hint">单击加点，双击闭合；闭合后可拖动顶点调整轮廓（不改物体身份）</span>
          </div>
          {record ? (
            <AnnotationCanvas record={record} drawType={drawType} targetObjectId={selectedObjectId} />
          ) : (
            <div className="empty-state">导入图片后开始标注</div>
          )}
        </main>
        <aside className="pane inspector">
          <section className="inspector-section">
            <h2>类别</h2>
            <ul className="category-list">
              {project.categories.map((category) => <li key={category}>{category}</li>)}
            </ul>
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (newCategory.trim()) addCategory(newCategory.trim());
                setNewCategory('');
              }}
            >
              <input value={newCategory} onChange={(event) => setNewCategory(event.target.value)} placeholder="新类别名" />
              <button type="submit">添加</button>
            </form>
          </section>
          <ObjectPanel record={record} drawType={drawType} onDrawTypeChange={setDrawType} />
          <VersionPanel record={record} />
          <IssueList />
        </aside>
      </div>
    </div>
  );
}
