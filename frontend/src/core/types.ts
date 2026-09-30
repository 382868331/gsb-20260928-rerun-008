/**
 * 领域模型：
 * - Point/Contour 为纯几何数据
 * - AnnotationObject 是“同一物体”的身份载体，objectId 在草稿编辑、
 *   类别修改、提交、返工中保持不变
 * - 每张图片拥有若干不可变的已提交版本（AnnotationVersion）
 *   以及至多一个可继续调整的草稿（Draft）
 */

export interface Point {
  x: number;
  y: number;
}

/** contourType: outer 物体外轮廓；hole 孔洞 */
export type ContourType = 'outer' | 'hole';

export interface Contour {
  contourId: string;
  type: ContourType;
  points: Point[];
}

export interface AnnotationObject {
  objectId: string;
  category: string;
  contours: Contour[];
}

export interface Draft {
  /** 草稿基于哪个已提交版本返工；首次标注为 null */
  basedOnVersionId: string | null;
  objects: AnnotationObject[];
  updatedAt: string;
}

export interface AnnotationVersion {
  versionId: string;
  /** 该版本由哪个版本返工而来；首次提交为 null */
  basedOnVersionId: string | null;
  /** 版本序号，从 1 开始，只增不减 */
  versionNo: number;
  objects: AnnotationObject[];
  submittedAt: string;
}

export interface ImageAsset {
  imageId: string;
  name: string;
  /** 原图内容（dataURL），导出时可选择内联或省略 */
  dataUrl?: string;
  width: number;
  height: number;
  /** sha256 hex（无 dataUrl 时可为空），用于导入时按内容核对图片 */
  checksum: string;
  importedAt: string;
}

export interface ImageRecord {
  image: ImageAsset;
  draft: Draft | null;
  versions: AnnotationVersion[];
}

export interface Project {
  projectId: string;
  name: string;
  categories: string[];
  images: ImageRecord[];
  createdAt: string;
  updatedAt: string;
}

/** 导出文件结构（v1） */
export interface ExportBundleV1 {
  format: 'image-annotation-bundle';
  formatVersion: 1;
  exportedAt: string;
  projectId: string;
  name: string;
  categories: string[];
  images: ExportedImage[];
}

/** 导出时仅导出最新已提交版本；草稿不参与交付 */
export interface ExportedImage {
  imageId: string;
  name: string;
  width: number;
  height: number;
  checksum: string;
  dataUrl?: string;
  versionId: string;
  versionNo: number;
  basedOnVersionId: string | null;
  submittedAt: string;
  objects: AnnotationObject[];
}

export type IssueCode =
  | 'MISSING_IMAGE'
  | 'CHECKSUM_MISMATCH'
  | 'CORRUPT_RECORD'
  | 'CONTOUR_TOO_FEW_POINTS'
  | 'SELF_INTERSECTING'
  | 'CONTOURS_CROSS'
  | 'HOLE_OUTSIDE_OUTER'
  | 'MULTIPLE_OUTERS';

export interface ValidationIssue {
  code: IssueCode;
  message: string;
  /** 出错图片在导入数组中的下标，便于定位 */
  index: number;
  imageId?: string;
  name?: string;
  objectId?: string;
  contourId?: string;
}

export interface ImportedImagePayload {
  imageId: string;
  name: string;
  width: number;
  height: number;
  checksum: string;
  dataUrl?: string;
  versionId: string;
  versionNo: number;
  basedOnVersionId: string | null;
  submittedAt: string;
  objects: unknown;
}

export interface ImportResult {
  /** 成功导入并合并的图片数量 */
  imported: number;
  /** 因目标项目已存在相同版本而跳过的数量 */
  skipped: number;
  /** 按图片逐条记录的问题；有问题的图片整张跳过，不影响其他图片 */
  issues: ValidationIssue[];
  project: Project;
}
