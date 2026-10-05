export type Point = { x: number; y: number };

export interface Contour {
  id: string;
  points: Point[];
  holes: ContourHole[];
  /** 来源外轮廓 id；由孔洞经人工确认转为外轮廓时同时记录 sourceHoleId */
  sourceContourId?: string;
  sourceHoleId?: string;
}

export interface ContourHole {
  id: string;
  points: Point[];
  /** 来源孔洞 id，用于拆分/合并后继续追溯 */
  sourceHoleId?: string;
}

export interface RegionSource {
  objectId: string;
  contourId?: string;
  holeId?: string;
}

export interface ObjectProvenance {
  sources: RegionSource[];
  transformation: 'identity' | 'split' | 'merge' | 'new';
}

export interface AnnotationObject {
  /** 物体身份标识，创建后永不改变；修改类别或轮廓不影响该 id */
  id: string;
  categoryId: string;
  contours: Contour[];
  createdAt: string;
  updatedAt: string;
  /** 合并后对象来自哪些旧对象/区域；原始修订中的对象通常不带该字段 */
  provenance?: ObjectProvenance;
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
  /** 合并过程中每项关系与片段修改的人工选择 */
  mergeAudit?: MergeAudit;
  note?: string;
}

export interface MergeSources {
  base: number;
  a: number;
  b: number;
}

export type MergeRelationKind = 'split' | 'merge' | 'hole-to-outline' | 'overlap';

export interface MergeRelation {
  id: string;
  kind: MergeRelationKind;
  side: 'a' | 'b';
  targetObjectIds: string[];
  sourceObjectIds: string[];
  sourceContourIds?: string[];
  sourceHoleIds?: string[];
  message: string;
}

export type MergeRelationDecision = 'confirmed' | 'rejected' | 'disputed';

export type MergeConstraintKind = 'keep-category' | 'keep-group';

export interface MergeConstraint {
  id: string;
  kind: MergeConstraintKind;
  /** 涉及的物体 id（基线或任一修订中的物体） */
  objectIds: string[];
  /** keep-category 时必须保留的类别 */
  categoryId?: string;
  note?: string;
}

/** 一份可比较的合并方案：一组完整的拆合关系决定及其后果预览 */
export interface MergePlanOption {
  id: string;
  label: string;
  /** relationId 到 confirmed/rejected，方案对每条拆合关系都给出决定 */
  relationDecisions: Record<string, MergeRelationDecision>;
  /** 方案落地后仍需逐项裁决的冲突（关系决定本身不含在内） */
  pendingConflicts: MergeConflict[];
  /** 最终物体预览：id、类别与来源 */
  finalObjects: { id: string; categoryId: string; sources: RegionSource[] }[];
  /** 违反的用户约束（可读描述） */
  violations: string[];
  /** 同一来源被矛盾分配（共享祖先被重复算成两个物体）的说明 */
  duplicateSources: string[];
  /** 为消除冲突而被删除、但仍有独立来源的物体 */
  droppedIndependent: string[];
  /** 满足全部约束且来源无矛盾 */
  feasible: boolean;
}

/** 一组无法同时满足的决定 */
export interface IncompatibleDecisionSet {
  /** 形如 relationId=confirmed 的决定 */
  decisions: string[];
  reason: string;
}

export interface MergePlanComparison {
  baseVersion: number;
  options: MergePlanOption[];
  incompatibilities: IncompatibleDecisionSet[];
}

/** 用户为部分物体指定的必须保留约束：类别或分组 */

export type MergePartKind =
  | 'object-existence'
  | 'category'
  | 'outline'
  | 'contour-existence'
  | 'hole'
  | 'hole-existence'
  | 'split-relation'
  | 'merge-relation'
  | 'hole-promotion'
  | 'duplicate-region';

/** 一处需要用户裁决的冲突：同一物体同一部分被两条修订改成了不同结果 */
export interface MergeConflict {
  /** 稳定 id，用于记录用户选择 */
  id: string;
  objectId: string;
  part: MergePartKind;
  contourId?: string;
  holeId?: string;
  /** 片段级修改依赖的拆合关系 */
  dependsOn?: string;
  /** 该冲突涉及的来源区域 */
  sources?: RegionSource[];
  /** 基线版本中的值（删除类冲突时可能为 undefined 表示不存在） */
  baseValue: unknown;
  aValue: unknown;
  bValue: unknown;
  message: string;
}

export type MergeResolution =
  | 'a' | 'b'
  | 'adopt-a' | 'adopt-b'
  | 'confirmed' | 'rejected'
  | 'discard' | 'disputed';

export interface MergeDecisionRecord {
  conflictId: string;
  choice: MergeResolution;
  decidedAt: string;
}

export interface MergeRelationRecord {
  relationId: string;
  decision: MergeRelationDecision;
  decidedAt: string;
}

export interface MergeAudit {
  relations: MergeRelationRecord[];
  decisions: MergeDecisionRecord[];
}

/** 合并会话：可中途保存，之后继续逐项确认 */
export interface MergeSession {
  id: string;
  imageId: string;
  baseVersion: number;
  aVersion: number;
  bVersion: number;
  /** conflictId -> 采用、舍弃或保留争议 */
  resolutions: Record<string, MergeResolution>;
  /** relationId -> 已确认/舍弃/争议的拆合关系 */
  relations: Record<string, MergeRelationDecision>;
  /** 用户为本次合并指定的必须保留约束 */
  constraints?: MergeConstraint[];
  createdAt: string;
  updatedAt: string;
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
  /** 未完成的合并会话（含已保存的部分决定），导出后重新导入可继续比较 */
  mergeSessions?: MergeSession[];
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
