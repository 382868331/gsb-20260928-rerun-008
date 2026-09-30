import { checksumOfDataUrl } from './ids';
import { deepFreeze } from './project';
import { parseObjects, validateObjects, validatePayloadShape } from './validation';
import type {
  AnnotationVersion,
  ExportBundleV1,
  ExportedImage,
  ImageAsset,
  ImageRecord,
  ImportedImagePayload,
  ImportResult,
  Project,
  ValidationIssue,
} from './types';

export class BundleParseError extends Error {}

export interface ExportOptions {
  /** 是否内联图片内容；关掉后再导入需项目内已有同 checksum 的图片 */
  includeImages?: boolean;
}

/**
 * 导出交付包：每张图片只导出“最新已提交版本”，草稿一律不导出。
 * 未提交任何版本的图片跳过。
 */
export function exportProject(project: Project, options: ExportOptions = {}): ExportBundleV1 {
  const includeImages = options.includeImages ?? true;
  const images: ExportedImage[] = [];
  for (const record of project.images) {
    const version = record.versions.length > 0
      ? record.versions[record.versions.length - 1]
      : null;
    if (!version) continue;
    images.push({
      imageId: record.image.imageId,
      name: record.image.name,
      width: record.image.width,
      height: record.image.height,
      checksum: record.image.checksum,
      ...(includeImages && record.image.dataUrl ? { dataUrl: record.image.dataUrl } : {}),
      versionId: version.versionId,
      versionNo: version.versionNo,
      basedOnVersionId: version.basedOnVersionId,
      submittedAt: version.submittedAt,
      objects: structuredClone(version.objects),
    });
  }
  return deepFreeze({
    format: 'image-annotation-bundle',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    projectId: project.projectId,
    name: project.name,
    categories: [...project.categories],
    images,
  });
}

export function serializeBundle(bundle: ExportBundleV1): string {
  return JSON.stringify(bundle, null, 2);
}

export function parseBundleText(text: string): ExportBundleV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new BundleParseError(`导出文件不是合法 JSON：${(error as Error).message}`);
  }
  const bundle = raw as Partial<ExportBundleV1>;
  if (!bundle || typeof bundle !== 'object'
    || bundle.format !== 'image-annotation-bundle'
    || bundle.formatVersion !== 1
    || !Array.isArray(bundle.images)) {
    throw new BundleParseError('导出文件头损坏：缺少 format/formatVersion/images');
  }
  if (typeof bundle.projectId !== 'string' || !Array.isArray(bundle.categories)) {
    throw new BundleParseError('导出文件头损坏：缺少 projectId/categories');
  }
  return raw as ExportBundleV1;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeFrozenVersion(payload: ImportedImagePayload, objects: ExportedImage['objects']): AnnotationVersion {
  return deepFreeze({
    versionId: payload.versionId,
    basedOnVersionId: payload.basedOnVersionId,
    versionNo: payload.versionNo,
    objects: deepFreeze(structuredClone(objects)),
    submittedAt: payload.submittedAt,
  });
}

/**
 * 逐张导入并核对：
 * - 记录损坏 / 缺少图片 / checksum 不符 / 轮廓交叉、自交、孔洞越界等，
 *   整张图片跳过并记录可定位的 issue；
 * - 已存在同 versionId 时跳过（重复导入幂等）；
 * - 新版本追加到该图的版本列表，绝不删除或覆盖任何已提交结果；
 * - 单张图片失败不影响其余图片。
 */
export async function importBundle(
  project: Project,
  bundle: ExportBundleV1,
  deps: { checksumOf?: (dataUrl: string) => Promise<string> } = {},
): Promise<ImportResult> {
  const checksumOf = deps.checksumOf ?? checksumOfDataUrl;
  const issues: ValidationIssue[] = [];
  let imported = 0;
  let skipped = 0;
  let current = project;
  const categories = [...new Set([...project.categories, ...bundle.categories])];

  for (let index = 0; index < bundle.images.length; index += 1) {
    const payload = bundle.images[index] as unknown as ImportedImagePayload;
    const ctx = {
      imageId: typeof payload?.imageId === 'string' ? payload.imageId : undefined,
      name: typeof payload?.name === 'string' ? payload.name : undefined,
    };

    const shapeIssues = validatePayloadShape(payload, index);
    if (shapeIssues.length > 0) {
      issues.push(...shapeIssues);
      continue;
    }

    const objects = parseObjects(payload.objects);
    if (!objects) {
      issues.push({ code: 'CORRUPT_RECORD', message: '标注记录结构损坏，无法解析', index, ...ctx });
      continue;
    }

    const geometryIssues = validateObjects(objects, categories, index, ctx);
    if (geometryIssues.length > 0) {
      issues.push(...geometryIssues);
      continue;
    }

    const existingIndex = current.images.findIndex((record) =>
      record.image.imageId === payload.imageId
      || record.image.checksum === payload.checksum);

    let record: ImageRecord;
    if (existingIndex >= 0) {
      record = current.images[existingIndex];
      if (record.image.checksum !== payload.checksum) {
        issues.push({ code: 'CHECKSUM_MISMATCH',
          message: `图片内容指纹不一致：${payload.name}`, index, ...ctx });
        continue;
      }
      if (record.versions.some((v) => v.versionId === payload.versionId)) {
        skipped += 1;
        continue;
      }
    } else if (payload.dataUrl) {
      const actualChecksum = await checksumOf(payload.dataUrl);
      if (actualChecksum !== payload.checksum) {
        issues.push({ code: 'CHECKSUM_MISMATCH',
          message: `图片内容指纹校验失败：${payload.name}`, index, ...ctx });
        continue;
      }
      const asset: ImageAsset = {
        imageId: payload.imageId,
        name: payload.name,
        width: payload.width,
        height: payload.height,
        checksum: payload.checksum,
        dataUrl: payload.dataUrl,
        importedAt: nowIso(),
      };
      record = { image: asset, draft: null, versions: [] };
    } else {
      issues.push({ code: 'MISSING_IMAGE',
        message: `缺少图片文件：${payload.name}（checksum=${payload.checksum}）`, index, ...ctx });
      continue;
    }

    const version = makeFrozenVersion(payload, objects);
    const versions = [...record.versions, version].sort((a, b) => a.versionNo - b.versionNo);
    const nextRecord: ImageRecord = { ...record, versions };
    const images = current.images.slice();
    if (existingIndex >= 0) images[existingIndex] = nextRecord;
    else images.push(nextRecord);
    current = {
      ...current,
      categories,
      images,
      updatedAt: nowIso(),
    };
    imported += 1;
  }

  return { imported, skipped, issues, project: current };
}
