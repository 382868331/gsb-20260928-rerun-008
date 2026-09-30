import { useStore } from '../store/store';
import type { ImageRecord } from '../core/types';

interface Props {
  record: ImageRecord | null;
  drawType: 'outer' | 'hole';
  onDrawTypeChange: (type: 'outer' | 'hole') => void;
}

export function ObjectPanel({ record, drawType, onDrawTypeChange }: Props) {
  const project = useStore((state) => state.project);
  const selectedObjectId = useStore((state) => state.selectedObjectId);
  const selectedContourId = useStore((state) => state.selectedContourId);
  const selectObject = useStore((state) => state.selectObject);
  const addObject = useStore((state) => state.addObject);
  const removeObject = useStore((state) => state.removeObject);
  const changeObjectCategory = useStore((state) => state.changeObjectCategory);
  const changeContourType = useStore((state) => state.changeContourType);
  const removeContour = useStore((state) => state.removeContour);
  const submit = useStore((state) => state.submit);
  const discardDraft = useStore((state) => state.discardDraft);
  const ensureDraft = useStore((state) => state.ensureDraft);

  if (!record) return null;

  const objects = record.draft?.objects ?? record.versions[record.versions.length - 1]?.objects ?? [];
  const readOnly = !record.draft;

  return (
    <section className="inspector-section">
      <div className="section-head">
        <h2>物体 {readOnly ? '（已提交，只读）' : '（草稿可编辑）'}</h2>
        {!readOnly && <button type="button" onClick={() => addObject()}>新物体</button>}
      </div>
      {objects.length === 0 && <p className="muted">尚无物体，先新建物体再绘制轮廓。</p>}
      <ul className="object-list">
        {objects.map((object) => (
          <li key={object.objectId} className={object.objectId === selectedObjectId ? 'object-item selected' : 'object-item'}>
            <div className="object-head">
              <button type="button" className="object-select" onClick={() => selectObject(object.objectId)}>
                <span className="object-id" title={object.objectId}>
                  物体 {object.objectId.slice(-6)}
                </span>
              </button>
              {readOnly ? (
                <span className="category-badge">{object.category}</span>
              ) : (
                <select
                  value={object.category}
                  onChange={(event) => changeObjectCategory(object.objectId, event.target.value)}
                >
                  {project.categories.map((category) => <option key={category} value={category}>{category}</option>)}
                </select>
              )}
              {!readOnly && (
                <button
                  type="button"
                  className="danger"
                  title="删除物体"
                  onClick={() => removeObject(object.objectId)}
                >
                  删
                </button>
              )}
            </div>
            {object.objectId === selectedObjectId && (
              <ul className="contour-list">
                {object.contours.map((contour) => (
                  <li key={contour.contourId} className={contour.contourId === selectedContourId ? 'selected' : ''}>
                    <button type="button" onClick={() => selectObject(object.objectId, contour.contourId)}>
                      {contour.type === 'outer' ? '外轮廓' : '孔洞'} · {contour.points.length} 点
                    </button>
                    {!readOnly && (
                      <span className="contour-actions">
                        <select
                          value={contour.type}
                          onChange={(event) => changeContourType(object.objectId, contour.contourId,
                            event.target.value as 'outer' | 'hole')}
                        >
                          <option value="outer">外轮廓</option>
                          <option value="hole">孔洞</option>
                        </select>
                        <button type="button" className="danger" onClick={() => removeContour(object.objectId, contour.contourId)}>删</button>
                      </span>
                    )}
                  </li>
                ))}
                {!readOnly && (
                  <li className="draw-hint">
                    <label>
                      画布中绘制：
                      <select value={drawType} onChange={(event) => onDrawTypeChange(event.target.value as 'outer' | 'hole')}>
                        <option value="outer">外轮廓</option>
                        <option value="hole">孔洞</option>
                      </select>
                    </label>
                  </li>
                )}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <div className="draft-actions">
        {readOnly ? (
          <button type="button" className="primary" onClick={() => ensureDraft()}>
            {record.versions.length > 0 ? '基于最新版本继续调整' : '开始标注'}
          </button>
        ) : (
          <>
            <button type="button" className="primary" onClick={submit}>提交版本（固定）</button>
            <button type="button" onClick={discardDraft}>放弃草稿</button>
          </>
        )}
      </div>
    </section>
  );
}
