export type Point = { x: number; y: number };

export interface Contour {
  id: string;
  /** 外轮廓顶点，按顺时针/逆时针顺序均可，至少 3 个点 */
  points: Point[];
  /** 孔洞（内轮廓），每个孔洞至少 3 个点；孔洞必须位于所属外轮廓内部 */
  holes: ContourHole[];
}

export interface ContourHole {
  id: string;
  points: Point[];
}

export interface AnnotationObject {
  /** 物体身份标识，创建后永不改变；修改类别或轮廓不影响该 id */
  id: string;
  categoryId: string;
  contours: Contour[];
  createdAt: string;
  updatedAt: string;
}

export type VersionStatus = 'draft' | 'submitted';

export interface ImageVersion {
  version: number;
  status: VersionStatus;
  objects: AnnotationObject[];
  createdAt: string;
  submittedAt: string | null;
  /** 返工来源版本号；为 null 表示首次提交 */
  basedOn: number | null;
  note?: string;
}

export interface ImageRecord {
  id: string;
  name: string;
  width: number;
  height: number;
  /** 图片内容（dataURL）。导出文件中以 imageRef 引用 */
  dataUrl?: string;
  versions: ImageVersion[];
  createdAt: string;
}

export interface Category {
  id: string;
  name: string;
  color: string;
}

export interface ProjectData {
  version: 1;
  exportedAt: string;
  images: ExportedImage[];
  categories: Category[];
}

export interface ExportedImage {
  id: string;
  name: string;
  width: number;
  height: number;
  dataUrl?: string;
  /** 仅导出已提交版本；草稿不导出 */
  submittedVersions: ImageVersion[];
}

export type IssueCode =
  | 'MISSING_IMAGE'
  | 'CORRUPT_RECORD'
  | 'CONTOUR_CROSSING'
  | 'HOLE_OUTSIDE'
  | 'INVALID_GEOMETRY'
  | 'UNKNOWN_CATEGORY'
  | 'DUPLICATE_OBJECT_ID' ;

export interface ImportIssue {
  imageId?: string;
  imageName?: string;
  objectId?: string;
  contourId?: string;
  version?: number;
  code: IssueCode;
  message: string;
}

export interface ImportResult {
  accepted: string[];
  rejected: string[];
  issues: ImportIssue[];
}
