export type Point = { x: number; y: number };

export interface Contour {
  id: string;
  /** 外轮廓顶点，按顺时针/逆时针顺序均可，至少 3 个点 */
  points: Point[];
  /** 孔洞（内轮廓），每个孔洞至少 3 个点；孔洞必须位于所属外轮廓内部 */
  holes: ContourHole[];
  /** 区域血缘：该外轮廓来自哪个历史物体/轮廓 */
  origin?: RegionOrigin;
}

export interface ContourHole {
  id: string;
  points: Point[];
  /** 孔洞血缘；拆分/合并时孔洞仍然是孔洞，不会无声变成外轮廓 */
  origin?: RegionOrigin;
}

export interface RegionOrigin {
  version: number;
  objectId: string;
  contourId: string;
  holeId?: string;
}

export interface AnnotationObject {
  /** 物体身份标识，创建后永不改变；修改类别或轮廓不影响该 id */
  id: string;
  categoryId: string;
  contours: Contour[];
  createdAt: string;
  updatedAt: string;
  /** 该对象由哪些旧对象/区域而来；普通对象也保留自身来源 */
  origins?: RegionOrigin[];
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
  /** 合并来源：本次提交由 base 版本的两条修订（a、b）合并而来 */
  mergeOf?: MergeSources;
  /** 本次返工业已确认的拆分/合并拓扑关系 */
  objectTransforms?: ObjectTransform[];
  /** 合并裁决审计：每个最终区域的来源和人工选择 */
  mergeAudit?: MergeAudit;
  note?: string;
}

export interface MergeSources {
  base: number;
  a: number;
  b: number;
}

export type ObjectTransformKind = 'split' | 'merge';

/** 一次返工中的对象拓扑变更：一个拆多个，或多个合一个 */
export interface ObjectTransform {
  id: string;
  kind: ObjectTransformKind;
  sourceObjectIds: string[];
  targetObjectIds: string[];
  /** source -> target 的轮廓/孔洞级血缘，禁止只凭新对象 id 断开身份 */
  mappings: ObjectTransformMapping[];
  createdAt: string;
}

export interface ObjectTransformMapping {
  sourceObjectId: string;
  sourceContourId: string;
  targetObjectId: string;
  targetContourId: string;
  holes: Array<{ sourceHoleId: string; targetHoleId: string }>;
}

export type MergePartKind =
  | 'split-relation'
  | 'merge-relation'
  | 'object-existence'
  | 'category'
  | 'outline'
  | 'contour-existence'
  | 'hole'
  | 'hole-existence';

/** 一处需要用户裁决的冲突：同一物体同一部分被两条修订改成了不同结果 */
export interface MergeConflict {
  /** 稳定 id，用于记录用户选择 */
  id: string;
  objectId: string;
  part: MergePartKind;
  contourId?: string;
  holeId?: string;
  /** 必须先确认的拆合关系 id */
  relationId?: string;
  sourceObjectIds?: string[];
  targetObjectIds?: string[];
  /** 基线版本中的值（删除类冲突时可能为 undefined 表示不存在） */
  baseValue: unknown;
  aValue: unknown;
  bValue: unknown;
  message: string;
}

export type MergeResolution = 'a' | 'b' | 'discard' | 'disputed';

/** 合并会话：可中途保存，之后继续逐项确认 */
export interface MergeSession {
  id: string;
  imageId: string;
  baseVersion: number;
  aVersion: number;
  bVersion: number;
  /** conflictId -> 选择哪一条修订 */
  resolutions: Record<string, MergeResolution>;
  /** relationId -> 采用哪一边的拓扑；不存在表示继续保留争议 */
  relations: Record<string, 'a' | 'b' | 'discard' | 'disputed'>;
  createdAt: string;
  updatedAt: string;
}

export interface MergeAudit {
  sessionId: string;
  relationChoices: Array<{ id: string; choice: 'a' | 'b'; at: string }>;
  decisions: Array<{ conflictId: string; choice: Exclude<MergeResolution, 'disputed'>; at: string }>;
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
