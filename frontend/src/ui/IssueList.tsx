import { useStore } from '../store/store';

const CODE_LABEL: Record<string, string> = {
  MISSING_IMAGE: '缺少图片',
  CHECKSUM_MISMATCH: '图片指纹不符',
  CORRUPT_RECORD: '记录损坏',
  CONTOUR_TOO_FEW_POINTS: '轮廓点数不足',
  SELF_INTERSECTING: '轮廓自交',
  CONTOURS_CROSS: '轮廓交叉',
  HOLE_OUTSIDE_OUTER: '孔洞越界',
  MULTIPLE_OUTERS: '缺少外轮廓',
};

export function IssueList() {
  const issues = useStore((state) => state.importIssues);
  const lastImport = useStore((state) => state.lastImport);
  const clearImportIssues = useStore((state) => state.clearImportIssues);

  if (!lastImport && issues.length === 0) return null;

  return (
    <section className="inspector-section issues">
      <div className="section-head">
        <h2>导入核对结果</h2>
        <button type="button" onClick={clearImportIssues}>清除</button>
      </div>
      {lastImport && (
        <p className="muted">成功 {lastImport.imported} 张，跳过重复 {lastImport.skipped} 张，问题 {issues.length} 条。</p>
      )}
      {issues.length > 0 && (
        <ul className="issue-list">
          {issues.map((item, index) => (
            <li key={`${item.code}-${item.imageId ?? ''}-${index}`}>
              <span className="issue-code">#{item.index + 1} {CODE_LABEL[item.code] ?? item.code}</span>
              <span className="issue-message">{item.message}</span>
              {(item.objectId || item.contourId) && (
                <span className="muted">object={item.objectId ?? '-'} contour={item.contourId ?? '-'}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
