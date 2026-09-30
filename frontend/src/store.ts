import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Category, ImageRecord, ImportResult, Point } from './types';
import {
  addDraftObject,
  createContour,
  createHole,
  defaultCategories,
  discardDraft,
  removeDraftObject,
  startRework,
  submitDraft,
  updateDraftObject,
} from './core/versioning';
import { createImage } from './core/versioning';
import type { LoadedImage } from './core/images';
import { exportProject, importProject } from './core/exchange';
import { uid } from './core/geometry';

interface AppState {
  images: ImageRecord[];
  categories: Category[];
  selectedImageId: string | null;
  lastImport: ImportResult | null;
  addImages: (loaded: LoadedImage[]) => string[];
  selectImage: (id: string | null) => void;
  addObject: (categoryId: string) => string | null;
  removeObject: (objectId: string) => void;
  setObjectCategory: (objectId: string, categoryId: string) => void;
  addContourToObject: (objectId: string, points?: Point[]) => string | null;
  addHoleToContour: (objectId: string, contourId: string, points?: Point[]) => void;
  updateContourPoints: (objectId: string, contourId: string, points: Point[]) => void;
  updateHolePoints: (objectId: string, contourId: string, holeId: string, points: Point[]) => void;
  removeContour: (objectId: string, contourId: string) => void;
  removeHole: (objectId: string, contourId: string, holeId: string) => void;
  submit: (note?: string) => void;
  rework: (note?: string) => void;
  discard: () => void;
  addCategory: (name: string, color: string) => void;
  exportJson: () => string;
  importJson: (raw: string) => ImportResult;
  resetAll: () => void;
}

function mutateImage(images: ImageRecord[], id: string | null, fn: (img: ImageRecord) => ImageRecord): ImageRecord[] {
  if (!id) return images;
  return images.map((img) => (img.id === id ? fn(img) : img));
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      images: [],
      categories: defaultCategories(),
      selectedImageId: null,
      lastImport: null,

      addImages: (loaded) => {
        const ids: string[] = [];
        const records = loaded.map((li) => {
          const rec = createImage({ ...li, id: uid('img') });
          ids.push(rec.id);
          return rec;
        });
        set((s) => ({
          images: [...s.images, ...records],
          selectedImageId: s.selectedImageId ?? ids[0] ?? null,
        }));
        return ids;
      },

      selectImage: (id) => set({ selectedImageId: id }),

      addObject: (categoryId) => {
        const { images, selectedImageId } = get();
        const image = images.find((i) => i.id === selectedImageId);
        if (!image) return null;
        const { image: next, objectId } = addDraftObject(image, categoryId);
        set({ images: mutateImage(images, selectedImageId, () => next) });
        return objectId;
      },

      removeObject: (objectId) =>
        set((s) => ({
          images: mutateImage(s.images, s.selectedImageId, (img) => removeDraftObject(img, objectId)),
        })),

      setObjectCategory: (objectId, categoryId) =>
        set((s) => ({
          images: mutateImage(s.images, s.selectedImageId, (img) =>
            updateDraftObject(img, objectId, (o) => {
              o.categoryId = categoryId;
            }),
          ),
        })),

      addContourToObject: (objectId, points = []) => {
        const { images, selectedImageId } = get();
        let contourId: string | null = null;
        set({
          images: mutateImage(images, selectedImageId, (img) =>
            updateDraftObject(img, objectId, (o) => {
              const contour = createContour(points);
              contourId = contour.id;
              o.contours.push(contour);
            }),
          ),
        });
        return contourId;
      },

      addHoleToContour: (objectId, contourId, points = []) =>
        set((s) => ({
          images: mutateImage(s.images, s.selectedImageId, (img) =>
            updateDraftObject(img, objectId, (o) => {
              const contour = o.contours.find((c) => c.id === contourId);
              if (contour) contour.holes.push(createHole(points));
            }),
          ),
        })),

      updateContourPoints: (objectId, contourId, points) =>
        set((s) => ({
          images: mutateImage(s.images, s.selectedImageId, (img) =>
            updateDraftObject(img, objectId, (o) => {
              const c = o.contours.find((x) => x.id === contourId);
              if (c) c.points = points;
            }),
          ),
        })),

      updateHolePoints: (objectId, contourId, holeId, points) =>
        set((s) => ({
          images: mutateImage(s.images, s.selectedImageId, (img) =>
            updateDraftObject(img, objectId, (o) => {
              const c = o.contours.find((x) => x.id === contourId);
              const h = c?.holes.find((x) => x.id === holeId);
              if (h) h.points = points;
            }),
          ),
        })),

      removeContour: (objectId, contourId) =>
        set((s) => ({
          images: mutateImage(s.images, s.selectedImageId, (img) =>
            updateDraftObject(img, objectId, (o) => {
              o.contours = o.contours.filter((c) => c.id !== contourId);
            }),
          ),
        })),

      removeHole: (objectId, contourId, holeId) =>
        set((s) => ({
          images: mutateImage(s.images, s.selectedImageId, (img) =>
            updateDraftObject(img, objectId, (o) => {
              const c = o.contours.find((x) => x.id === contourId);
              if (c) c.holes = c.holes.filter((h) => h.id !== holeId);
            }),
          ),
        })),

      submit: (note) =>
        set((s) => ({
          images: mutateImage(s.images, s.selectedImageId, (img) => submitDraft(img, note)),
        })),

      rework: (note) =>
        set((s) => ({
          images: mutateImage(s.images, s.selectedImageId, (img) => startRework(img, note)),
        })),

      discard: () =>
        set((s) => ({
          images: mutateImage(s.images, s.selectedImageId, (img) => discardDraft(img)),
        })),

      addCategory: (name, color) =>
        set((s) => ({ categories: [...s.categories, { id: uid('cat'), name, color }] })),

      exportJson: () => {
        const { images, categories } = get();
        return JSON.stringify(exportProject(images, categories));
      },

      importJson: (raw) => {
        const { images, categories } = get();
        const out = importProject(raw, { existingImages: images, existingCategories: categories });
        set({ images: out.images, categories: out.categories, lastImport: out.result });
        return out.result;
      },

      resetAll: () =>
        set({ images: [], categories: defaultCategories(), selectedImageId: null, lastImport: null }),
    }),
    { name: 'annotation-platform-v1' },
  ),
);
