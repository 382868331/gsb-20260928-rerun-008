import { Toolbar } from './components/Toolbar';
import { ImageList } from './components/ImageList';
import { Canvas } from './components/Canvas';
import { ObjectPanel } from './components/ObjectPanel';
import { VersionBar } from './components/VersionBar';
import { useStore } from './store';

export default function App() {
  const image = useStore((s) => s.images.find((i) => i.id === s.selectedImageId));
  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <ImageList />
        {image ? (
          <section className="workspace">
            <header className="workspace-head">
              <h2 title={image.name}>{image.name}</h2>
              <span className="muted">{image.width}×{image.height}</span>
            </header>
            <Canvas image={image} />
            <VersionBar image={image} />
          </section>
        ) : (
          <section className="empty">
            <h2>没有选中图片</h2>
            <p className="muted">批量导入图片后即可开始标注：绘制外轮廓与孔洞、修改类别、提交冻结版本、返工另起版本、导出/导入逐图核对。</p>
          </section>
        )}
        {image && <ObjectPanel image={image} />}
      </div>
    </div>
  );
}
