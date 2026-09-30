import { useRef } from 'react';
import { Download, Upload, ImagePlus, RotateCcw } from 'lucide-react';
import { useStore } from '../store';
import { loadImageFiles } from '../core/images';
import { downloadJson, exportProject } from '../core/exchange';

export function Toolbar() {
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const addImages = useStore((s) => s.addImages);
  const importJson = useStore((s) => s.importJson);
  const images = useStore((s) => s.images);
  const categories = useStore((s) => s.categories);

  async function onPickImages(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    const { loaded, errors } = await loadImageFiles(files);
    if (loaded.length) addImages(loaded);
    if (errors.length) alert('部分图片导入失败：\n' + errors.join('\n'));
  }

  function onExport() {
    const data = exportProject(images, categories);
    if (data.images.length === 0) {
      alert('还没有任何已提交结果可导出。请先标注并提交。');
      return;
    }
    downloadJson(data);
  }

  function onPickImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const result = importJson(String(reader.result));
        const lines = [
          `导入完成：接受 ${result.accepted.length} 张，拒绝 ${result.rejected.length} 张。`,
          ...result.issues.map((i) => `[${i.code}] ${i.imageName ?? i.imageId ?? ''} ${i.message}`),
        ];
        alert(lines.join('\n'));
      } catch (err) {
        alert('导入失败：' + (err as Error).message);
      }
    };
    reader.readAsText(file);
  }

  return (
    <div className="toolbar">
      <strong className="brand">图像标注生产平台</strong>
      <button onClick={() => fileRef.current?.click()}>
        <ImagePlus size={16} /> 批量导入图片
      </button>
      <button onClick={onExport}>
        <Download size={16} /> 导出已提交结果
      </button>
      <button onClick={() => importRef.current?.click()}>
        <Upload size={16} /> 导入并核对
      </button>
      <button
        onClick={() => {
          if (confirm('确定清空全部图片与标注？')) useStore.getState().resetAll();
        }}
        title="清空工作区"
      >
        <RotateCcw size={16} />
      </button>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onPickImages} />
      <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={onPickImport} />
      <span className="spacer" />
      <span className="muted">{images.length} 张图片</span>
    </div>
  );
}
