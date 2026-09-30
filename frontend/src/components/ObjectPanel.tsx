import { useState } from 'react';
import { Plus, Trash2, CircleDot, Grid3x3 } from 'lucide-react';
import { useStore } from '../store';
import { getDraft } from '../core/versioning';
import type { ImageRecord } from '../types';

export function ObjectPanel({ image }: { image: ImageRecord }) {
  const categories = useStore((s) => s.categories);
  const addCategory = useStore((s) => s.addCategory);
  const addObject = useStore((s) => s.addObject);
  const removeObject = useStore((s) => s.removeObject);
  const setObjectCategory = useStore((s) => s.setObjectCategory);
  const removeContour = useStore((s) => s.removeContour);
  const removeHole = useStore((s) => s.removeHole);
  const [newCat, setNewCat] = useState('');

  const draft = getDraft(image);
  const colorOf = (id: string) => categories.find((c) => c.id === id)?.color ?? '#999';

  return (
    <div className="object-panel">
      <h3>物体（同一身份可含多个轮廓/孔洞）</h3>
      {!draft && <p className="muted">当前图片没有可编辑草稿（已全部提交）。发起返工后可继续调整。</p>}
      {draft && draft.objects.length === 0 && draft.status === 'draft' && (
        <p className="muted">在画布上点击“新增物体”后，沿物体边缘点击绘制，双击闭合。</p>
      )}
      {draft?.objects.map((obj) => (
        <div key={obj.id} className="object-card">
          <header>
            <span className="dot" style={{ background: colorOf(obj.categoryId) }} />
            <select
              value={obj.categoryId}
              onChange={(e) => setObjectCategory(obj.id, e.target.value)}
              title="修改类别不会改变物体 id"
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className="icon-btn danger" title="删除物体" onClick={() => removeObject(obj.id)}>
              <Trash2 size={14} />
            </button>
          </header>
          <div className="id-line" title="物体身份标识，跨版本保持不变">id: {obj.id}</div>
          {obj.contours.map((c) => (
            <div key={c.id} className="contour-row">
              <CircleDot size={13} />
              <span>外轮廓（{c.points.length} 点）</span>
              <button className="icon-btn danger" onClick={() => removeContour(obj.id, c.id)}>
                <Trash2 size={12} />
              </button>
              {c.holes.map((h) => (
                <div key={h.id} className="hole-row">
                  <Grid3x3 size={12} />
                  <span>孔洞（{h.points.length} 点）</span>
                  <button className="icon-btn danger" onClick={() => removeHole(obj.id, c.id, h.id)}>
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
      {draft && (
        <button className="block-btn" onClick={() => addObject(categories[0]?.id ?? '')} disabled={!categories.length}>
          <Plus size={15} /> 新增物体
        </button>
      )}

      <h4>类别管理</h4>
      <div className="cat-row">
        {categories.map((c) => (
          <span key={c.id} className="tag" style={{ borderColor: c.color }}>
            <i style={{ background: c.color }} /> {c.name}
          </span>
        ))}
      </div>
      <div className="cat-add">
        <input value={newCat} placeholder="新类别名称" onChange={(e) => setNewCat(e.target.value)} />
        <button
          onClick={() => {
            if (newCat.trim()) {
              addCategory(newCat.trim(), `hsl(${Math.floor(Math.random() * 360)},70%,55%)`);
              setNewCat('');
            }
          }}
        >
          添加
        </button>
      </div>
    </div>
  );
}
