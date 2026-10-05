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
  createdAt: string;
  updatedAt: string;
  /** 用户对基线物体指定的保留类别/分组约束，规划时据此筛选候选 */
  constraints?: MergeConstraint[];
}

/**
 * 来源保留约束：
 * - category：要求来源物体最终落在某个类别的候选中；
 * - group：同一组的来源必须共同落入同一个候选，不能被拆到不同物体。
 */
export interface MergeConstraint {
  id: string;
  kind: 'category' | 'group';
  /** 该约束保护的基线物体 id */
  sourceObjectIds: string[];
  /** kind=category 时要求的类别 */
  categoryId?: string;
  /** kind=group 时的分组标识，同组来源必须共同采用 */
  groupId?: string;
}

/** 合并规划中的一个可采用候选：一组最终物体及其覆盖的基线来源 */
export interface MergeCandidate {
  id: string;
  /** 候选包含的最终物体 id（结构候选为关系目标，保留候选为来源自身） */
  objectIds: string[];
  /** 实际覆盖到的基线物体（几何共享区域 + provenance 推导） */
  coveredSourceIds: string[];
  /** 采用该候选必须一并确认的拆合关系；保留候选对应拒绝 */
  relationId: string;
  relationDecision: MergeRelationDecision;
  side: 'a' | 'b' | 'base';
  categoryId: string;
  /** 是否为不允许删除的独立来源保留候选（来源未被任何关系触及） */
  independent: boolean;
  label: string;
}

/** 两个候选不能共同采用的原因 */
export interface MergeIncompatibility {
  candidateAId: string;
  candidateBId: string;
  reason: 'shared-source' | 'relation-conflict' | 'same-object';
  message: string;
}

/** 一份可比较的最小冲突合并方案 */
export interface MergePlanOption {
  id: string;
  candidateIds: string[];
  /** 覆盖全部基线来源（按区域计），无重复归属 */
  complete: boolean;
  uncoveredSourceIds: string[];
  /** 满足/违反的用户约束 id */
  satisfiedConstraintIds: string[];
  violatedConstraintIds: string[];
  /** 采用后仍需逐项裁决的冲突数（越少越优先） */
  remainingConflictCount: number;
  /** 相对当前已裁决内容还需新增的决定数 */
  additionalDecisionCount: number;
  /** 需要撤回的现有决定 id */
  conflictingDecisionIds: string[];
  summary: string;
}

/** 无法同时满足的最小决定/约束集合 */
export interface MergeDecisionSet {
  /** 互斥的候选 id 或约束 id */
  memberIds: string[];
  kind: 'candidate-conflict' | 'constraint-unsatisfiable' | 'decision-conflict';
  message: string;
}

/** 撤回一项决定后的影响范围 */
export interface MergeWithdrawalImpact {
  withdrawnId: string;
  /** 必须一并重开的依赖闭合决定 */
  reopenedDecisionIds: string[];
  /** 受影响后退回未决的最终物体 id */
  affectedObjectIds: string[];
  /** 受影响的候选/方案 id */
  affectedCandidateIds: string[];
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
