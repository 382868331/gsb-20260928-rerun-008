import type {
  Category,
  ExportedImage,
  ImageRecord,
  ImageVersion,
  ImportIssue,
  ImportResult,
  MergeSession,
  ProjectData,
} from '../types';
import { validateVersion } from './validation';
import { createImage, nowIso } from './versioning';

/** 导出：仅包含已提交版本，草稿不导出；未完成的合并会话随版本一起导出 */
export function exportProject(
  images: ImageRecord[],
  categories: Category[],
  mergeSessions: MergeSession[] = [],
): ProjectData {
  const exportedImages = images
    .map((image) => ({
      id: image.id,
      name: image.name,
      width: image.width,
      height: image.height,
      dataUrl: image.dataUrl,
      submittedVersions: image.versions.filter((v) => v.status === 'submitted'),
    }))
    .filter((e) => e.submittedVersions.length > 0);
  const exportedById = new Map(exportedImages.map((e) => [e.id, e]));
  // 只导出能在文件中继续的会话：图片已导出且基线/两条修订版本都在
  const sessions = mergeSessions.filter((s) => {
    const entry = exportedById.get(s.imageId);
    if (!entry) return false;
    const has = (n: number) => entry.submittedVersions.some((v) => v.version === n);
    return has(s.baseVersion) && has(s.aVersion) && has(s.bVersion);
  });
  return {
    version: 1,
    exportedAt: nowIso(),
    categories: structuredClone(categories),
    images: exportedImages,
    ...(sessions.length > 0 ? { mergeSessions: structuredClone(sessions) } : {}),
  };
}

export function serializeProject(data: ProjectData): string {
  return JSON.stringify(data, null, 2);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function isValidVersion(v: unknown): v is ImageVersion {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  return (
    Number.isInteger(rec.version) &&
    (rec.status === 'submitted' || rec.status === undefined) &&
    Array.isArray(rec.objects)
  );
}

export interface ImportOptions {
  /** 与导入文件 id 匹配的现有图片，可用于补回缺失的图片数据 */
  existingImages: ImageRecord[];
  existingCategories: Category[];
  /** 本地未完成的合并会话；文件中的会话不会覆盖它们 */
  existingMergeSessions?: MergeSession[];
}

function isValidSessionShape(v: unknown): v is MergeSession {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<MergeSession>;
  return (
    typeof s.id === 'string' &&
    typeof s.imageId === 'string' &&
    Number.isInteger(s.baseVersion) &&
    Number.isInteger(s.aVersion) &&
    Number.isInteger(s.bVersion) &&
    (s.resolutions === undefined || (typeof s.resolutions === 'object' && s.resolutions !== null)) &&
    (s.relations === undefined || (typeof s.relations === 'object' && s.relations !== null))
  );
}

/**
 * 导入导出文件：
 * - 每张图片独立处理（逐图事务），单张失败不会覆盖/影响其他图片的已提交结果
 * - 缺少图片数据、记录损坏、轮廓交叉等问题全部定位到具体图片/物体/轮廓/版本
 * - 校验通过的版本按版本号合入：本地已有的同版本号不被覆盖，仅追加缺失版本
 */
export function importProject(
  raw: string, 
  options: ImportOptions,
): { result: ImportResult; images: ImageRecord[]; categories: Category[]; mergeSessions: MergeSession[] } {
  const issues: ImportIssue[] = [];
  const accepted: string[] = [];
  const rejected: string[] = [];
  const imagesById = new Map(options.existingImages.map((i) => [i.id, structuredClone(i)]));

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return {
      result: {
        accepted: [],
        rejected: [],
        issues: [
          {
            code: 'CORRUPT_RECORD',
            message: `导出文件整体损坏，无法解析：${(err as Error).message}`,
          },
        ],
      },
      images: options.existingImages,
      categories: options.existingCategories,
      mergeSessions: options.existingMergeSessions ?? [],
    };
  }

  const root = data as Partial<ProjectData>;
  if (!root || typeof root !== 'object' || !Array.isArray(root.images)) {
    return {
      result: {
        accepted: [],
        rejected: [],
        issues: [{ code: 'CORRUPT_RECORD', message: '导出文件结构损坏：缺少 images 数组' }],
      },
      images: options.existingImages,
      categories: options.existingCategories,
      mergeSessions: options.existingMergeSessions ?? [],
    };
  }

  // 合并类别表：文件内声明的类别也纳入校验范围
  const categoryMap = new Map(options.existingCategories.map((c) => [c.id, c]));
  for (const c of Array.isArray(root.categories) ? root.categories : []) {
    if (c && typeof c.id === 'string' && typeof c.name === 'string' && !categoryMap.has(c.id)) {
      categoryMap.set(c.id, { id: c.id, name: c.name, color: c.color || '#888888' });
    }
  }
  const categories = [...categoryMap.values()];

  root.images.forEach((entry, index) => processOneImage(entry, index));

  function processOneImage(entry: unknown, index: number): void {
    const loc = (over: ImportIssue): ImportIssue => ({
      imageId: (entry as ExportedImage)?.id,
      imageName: (entry as ExportedImage)?.name,
      ...over,
    });

    if (!entry || typeof entry !== 'object') {
      issues.push(loc({ code: 'CORRUPT_RECORD', message: `第 ${index + 1} 条图片记录损坏（不是对象）` }));
      rejected.push(`#${index + 1}`);
      return;
    }
    const rec = entry as ExportedImage;
    const id = typeof rec.id === 'string' ? rec.id : `#${index + 1}`;
    const local = imagesById.get(rec.id);
    const recordIssues: ImportIssue[] = [];

    if (typeof rec.id !== 'string' || !rec.id) {
      recordIssues.push(loc({ code: 'CORRUPT_RECORD', message: `第 ${index + 1} 条记录缺少图片 id` }));
    }
    if (typeof rec.name !== 'string' || !rec.name) {
      recordIssues.push(loc({ code: 'CORRUPT_RECORD', message: '图片记录缺少文件名' }));
    }
    if (!isFiniteNumber(rec.width) || !isFiniteNumber(rec.height)) {
      recordIssues.push(loc({ code: 'CORRUPT_RECORD', message: '图片尺寸字段损坏' }));
    }
    if (!rec.dataUrl && !local?.dataUrl) {
      recordIssues.push(
        loc({
          code: 'MISSING_IMAGE',
          message: `缺少图片数据：库中也找不到 id 为 ${rec.id} 的原图`,
        }),
      );
    }
    if (!Array.isArray(rec.submittedVersions) || rec.submittedVersions.length === 0) {
      recordIssues.push(
        loc({ code: 'CORRUPT_RECORD', message: '图片记录中没有任何已提交版本' }),
      );
    }

    const versions: ImageVersion[] = [];
    const seenVersions = new Set<number>();
    for (const v of rec.submittedVersions ?? []) {
      if (!isValidVersion(v)) {
        recordIssues.push(
          loc({ code: 'CORRUPT_RECORD', message: `版本 ${(v as ImageVersion)?.version ?? '?'} 记录损坏` }),
        );
        continue;
      }
      if (seenVersions.has(v.version)) {
        recordIssues.push(
          loc({ code: 'CORRUPT_RECORD', version: v.version, message: '版本号重复' }),
        );
        continue;
      }
      seenVersions.add(v.version);
      const normalized: ImageVersion = {
        ...v,
        status: 'submitted',
        submittedAt: v.submittedAt ?? null,
        basedOn: v.basedOn ?? null,
      };
      versions.push(normalized);
      recordIssues.push(
        ...validateVersion(normalized, categories, { imageId: rec.id, imageName: rec.name }),
      );
    }

    // 逐图事务：该图任何问题都整图拒绝，绝不部分写入
    if (recordIssues.length > 0) {
      issues.push(...recordIssues);
      rejected.push(id);
      return;
    }

    if (local) {
      const existingNumbers = new Set(local.versions.map((v) => v.version));
      for (const v of versions) {
        if (!existingNumbers.has(v.version)) {
          // 保持版本号顺序；新追加的版本直接进入已冻结的历史中
          local.versions.push(structuredClone(v));
        }
      }
      local.versions.sort((a, b) => a.version - b.version);
      if (rec.dataUrl && !local.dataUrl) local.dataUrl = rec.dataUrl;
      imagesById.set(local.id, local);
    } else {
      const created = createImage({
        id: rec.id,
        name: rec.name,
        width: rec.width,
        height: rec.height,
        dataUrl: rec.dataUrl,
      });
      created.createdAt = nowIso();
      // 导入记录没有“进行中草稿”，只有冻结的已提交版本
      created.versions = versions.map((v) => structuredClone(v)).sort((a, b) => a.version - b.version);
      imagesById.set(created.id, created);
    }
    accepted.push(id);
  }

  // 恢复文件中未完成的合并会话：版本号随图片一起导入，会话可直接继续比较。
  // 本地同图已有会话时保留本地进度，不被文件覆盖。
  const sessionByImage = new Map<string, MergeSession>(
    (options.existingMergeSessions ?? []).map((s) => [s.imageId, s]),
  );
  for (const raw of Array.isArray(root.mergeSessions) ? root.mergeSessions : []) {
    if (!isValidSessionShape(raw)) continue;
    if (sessionByImage.has(raw.imageId)) continue;
    const image = imagesById.get(raw.imageId);
    if (!image) continue;
    const hasSubmitted = (n: number) =>
      image.versions.some((v) => v.version === n && v.status === 'submitted');
    if (!hasSubmitted(raw.baseVersion) || !hasSubmitted(raw.aVersion) || !hasSubmitted(raw.bVersion)) {
      continue;
    }
    sessionByImage.set(raw.imageId, {
      id: raw.id,
      imageId: raw.imageId,
      baseVersion: raw.baseVersion,
      aVersion: raw.aVersion,
      bVersion: raw.bVersion,
      resolutions: { ...(raw.resolutions ?? {}) },
      relations: { ...(raw.relations ?? {}) },
      constraints: Array.isArray(raw.constraints)
        ? raw.constraints
            .map((c) => ({
              id: String(c.id ?? ''),
              kind: c.kind === 'group' ? ('group' as const) : ('category' as const),
              sourceObjectIds: Array.isArray(c.sourceObjectIds) ? c.sourceObjectIds.map(String) : [],
              categoryId: c.categoryId == null ? undefined : String(c.categoryId),
              groupId: c.groupId == null ? undefined : String(c.groupId),
            }))
            .filter((c) => c.id && c.sourceObjectIds.length > 0)
        : undefined,
      createdAt: raw.createdAt ?? nowIso(),
      updatedAt: raw.updatedAt ?? nowIso(),
    });
  }

  // 防御：若本地某张图只有草稿且被导入数据关联，保持草稿不动
  return {
    result: { accepted, rejected, issues },
    images: [...imagesById.values()].filter((img) =>
      options.existingImages.some((e) => e.id === img.id) || accepted.includes(img.id),
    ),
    categories,
    mergeSessions: [...sessionByImage.values()],
  };
}

export function downloadJson(data: ProjectData, filename = 'annotations-export.json'): void {
  const blob = new Blob([serializeProject(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
