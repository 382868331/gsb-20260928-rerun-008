import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  addCategory as addCategoryOp,
  addContour as addContourOp,
  addImage,
  addObject as addObjectOp,
  createProject,
  discardDraft as discardDraftOp,
  ensureDraft as ensureDraftOp,
  latestVersion,
  removeContour as removeContourOp,
  removeObject as removeObjectOp,
  setContourType as setContourTypeOp,
  setObjectCategory as setObjectCategoryOp,
  startReworkFromVersion,
  submitDraft as submitDraftOp,
  updateContourPoints as updateContourPointsOp,
} from '../core/project';
import { exportProject, importBundle, parseBundleText, serializeBundle, type BundleParseError } from '../core/exchange';
import { checksumOfDataUrl, newImageId } from '../core/ids';
import type {
  ContourType,
  ExportBundleV1,
  ImageAsset,
  ImportResult,
  Point,
  Project,
  ValidationIssue,
} from '../core/types';

const DEFAULT_CATEGORIES = ['person', 'vehicle', 'animal', 'obstacle'];

function loadImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = dataUrl;
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

export interface FileIssue {
  name: string;
  message: string;
}

interface StoreState {
  project: Project;
  selectedImageId: string | null;
  selectedObjectId: string | null;
  selectedContourId: string | null;
  importIssues: ValidationIssue[];
  fileIssues: FileIssue[];
  lastImport: { imported: number; skipped: number } | null;

  selectImage: (imageId: string | null) => void;
  selectObject: (objectId: string | null, contourId?: string | null) => void;
  addCategory: (category: string) => void;
  importImageFiles: (files: File[]) => Promise<void>;
  ensureDraft: () => void;
  addObject: (category?: string) => void;
  removeObject: (objectId: string) => void;
  changeObjectCategory: (objectId: string, category: string) => void;
  addContour: (objectId: string, type: ContourType, points: Point[]) => void;
  updateContourPoints: (objectId: string, contourId: string, points: Point[]) => void;
  changeContourType: (objectId: string, contourId: string, type: ContourType) => void;
  removeContour: (objectId: string, contourId: string) => void;
  submit: () => void;
  discardDraft: () => void;
  reworkFromVersion: (versionId: string) => void;
  exportBundleFile: (includeImages: boolean) => string;
  importBundleFile: (file: File) => Promise<{ ok: boolean; error?: string }>;
  applyBundle: (bundle: ExportBundleV1) => Promise<ImportResult>;
  clearImportIssues: () => void;
}

const initialProject = createProject('图像标注项目', DEFAULT_CATEGORIES);

function updateProject(project: Project): Partial<StoreState> {
  return { project };
}

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      project: initialProject,
      selectedImageId: null,
      selectedObjectId: null,
      selectedContourId: null,
      importIssues: [],
      fileIssues: [],
      lastImport: null,

      selectImage: (imageId) => set({
        selectedImageId: imageId,
        selectedObjectId: null,
        selectedContourId: null,
      }),

      selectObject: (objectId, contourId = null) => set({
        selectedObjectId: objectId,
        selectedContourId: contourId,
      }),

      addCategory: (category) => set((state) => updateProject(addCategoryOp(state.project, category))),

      importImageFiles: async (files) => {
        const fileIssues: FileIssue[] = [];
        let project = get().project;
        const knownChecksums = new Set(project.images.map((record) => record.image.checksum));
        for (const file of files) {
          try {
            const dataUrl = await readFileAsDataUrl(file);
            const { width, height } = await loadImageSize(dataUrl);
            const checksum = await checksumOfDataUrl(dataUrl);
            if (knownChecksums.has(checksum)) {
              fileIssues.push({ name: file.name, message: '图片已存在，已跳过' });
              continue;
            }
            knownChecksums.add(checksum);
            const asset: ImageAsset = {
              imageId: newImageId(),
              name: file.name,
              dataUrl,
              width,
              height,
              checksum,
              importedAt: new Date().toISOString(),
            };
            project = addImage(project, asset);
          } catch (error) {
            fileIssues.push({ name: file.name, message: (error as Error).message });
          }
        }
        set({
          project,
          fileIssues,
          selectedImageId: get().selectedImageId
            ?? (project.images[0]?.image.imageId ?? null),
        });
      },

      ensureDraft: () => {
        const { project, selectedImageId } = get();
        if (!selectedImageId) return;
        set(updateProject(ensureDraftOp(project, selectedImageId)));
      },

      addObject: (category) => {
        const { project, selectedImageId } = get();
        if (!selectedImageId) return;
        const cat = category ?? project.categories[0] ?? 'default';
        const next = addObjectOp(project, selectedImageId, cat);
        const record = next.images.find((r) => r.image.imageId === selectedImageId);
        const created = record?.draft?.objects[record.draft.objects.length - 1] ?? null;
        set({
          ...updateProject(next),
          selectedObjectId: created?.objectId ?? null,
          selectedContourId: null,
        });
      },

      removeObject: (objectId) => {
        const { project, selectedImageId, selectedObjectId } = get();
        if (!selectedImageId) return;
        set({
          ...updateProject(removeObjectOp(project, selectedImageId, objectId)),
          selectedObjectId: selectedObjectId === objectId ? null : selectedObjectId,
          selectedContourId: null,
        });
      },

      changeObjectCategory: (objectId, category) => {
        const { project, selectedImageId } = get();
        if (!selectedImageId) return;
        set(updateProject(setObjectCategoryOp(project, selectedImageId, objectId, category)));
      },

      addContour: (objectId, type, points) => {
        const { project, selectedImageId } = get();
        if (!selectedImageId || points.length < 3) return;
        const next = addContourOp(project, selectedImageId, objectId, type, points);
        const record = next.images.find((r) => r.image.imageId === selectedImageId);
        const object = record?.draft?.objects.find((o) => o.objectId === objectId);
        const contour = object?.contours[object.contours.length - 1];
        set({
          ...updateProject(next),
          selectedObjectId: objectId,
          selectedContourId: contour?.contourId ?? null,
        });
      },

      updateContourPoints: (objectId, contourId, points) => {
        const { project, selectedImageId } = get();
        if (!selectedImageId) return;
        set(updateProject(updateContourPointsOp(project, selectedImageId, objectId, contourId, points)));
      },

      changeContourType: (objectId, contourId, type) => {
        const { project, selectedImageId } = get();
        if (!selectedImageId) return;
        set(updateProject(setContourTypeOp(project, selectedImageId, objectId, contourId, type)));
      },

      removeContour: (objectId, contourId) => {
        const { project, selectedImageId, selectedContourId } = get();
        if (!selectedImageId) return;
        set({
          ...updateProject(removeContourOp(project, selectedImageId, objectId, contourId)),
          selectedContourId: selectedContourId === contourId ? null : selectedContourId,
        });
      },

      submit: () => {
        const { project, selectedImageId } = get();
        if (!selectedImageId) return;
        set({
          ...updateProject(submitDraftOp(project, selectedImageId)),
          selectedObjectId: null,
          selectedContourId: null,
        });
      },

      discardDraft: () => {
        const { project, selectedImageId } = get();
        if (!selectedImageId) return;
        set({
          ...updateProject(discardDraftOp(project, selectedImageId)),
          selectedObjectId: null,
          selectedContourId: null,
        });
      },

      reworkFromVersion: (versionId) => {
        const { project, selectedImageId } = get();
        if (!selectedImageId) return;
        set(updateProject(startReworkFromVersion(project, selectedImageId, versionId)));
      },

      exportBundleFile: (includeImages) => {
        const bundle = exportProject(get().project, { includeImages });
        return serializeBundle(bundle);
      },

      applyBundle: async (bundle) => {
        const result = await importBundle(get().project, bundle);
        set({
          project: result.project,
          importIssues: result.issues,
          lastImport: { imported: result.imported, skipped: result.skipped },
          selectedImageId: get().selectedImageId ?? result.project.images[0]?.image.imageId ?? null,
        });
        return result;
      },

      importBundleFile: async (file) => {
        try {
          const text = await file.text();
          const bundle = parseBundleText(text);
          await get().applyBundle(bundle);
          return { ok: true };
        } catch (error) {
          if ((error as BundleParseError).message) {
            return { ok: false, error: (error as Error).message };
          }
          return { ok: false, error: (error as Error).message };
        }
      },

      clearImportIssues: () => set({ importIssues: [], fileIssues: [], lastImport: null }),
    }),
    {
      name: 'image-annotation-platform-v1',
      partialize: (state) => ({ project: state.project }),
    },
  ),
);

export { latestVersion };
