import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from './store';
import { planMerge } from './core/merge';
import {
  addDraftObject,
  createContour,
  createHole,
  defaultCategories,
  submitDraft,
  updateDraftObject,
} from './core/versioning';
import type { AnnotationObject } from './types';

const cats = defaultCategories();

function fixture() {
  let img = useStore.getState().images[0];
  const r1 = addDraftObject(img, cats[0].id);
  img = updateDraftObject(r1.image, r1.objectId, (o) => {
    const c = createContour([
      { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 },
    ]);
    c.holes.push(createHole([
      { x: 30, y: 30 }, { x: 60, y: 30 }, { x: 60, y: 60 }, { x: 30, y: 60 },
    ]));
    o.contours.push(c);
  });
  const r2 = addDraftObject(img, cats[1].id);
  img = updateDraftObject(r2.image, r2.objectId, (o) => {
    o.contours.push(createContour([
      { x: 110, y: 110 }, { x: 190, y: 110 }, { x: 190, y: 190 }, { x: 110, y: 190 },
    ]));
  });
  img = submitDraft(img, 'base');
  const obj1 = r1.objectId;
  const obj2 = r2.objectId;
  useStore.setState({ images: [img] });

  const revise = (fromVersion: number, mutate: (objects: AnnotationObject[]) => void) => {
    const images = useStore.getState().images;
    const current = images[0];
    const base = current.versions.find((v) => v.version === fromVersion)!;
    const objects = structuredClone(base.objects);
    mutate(objects);
    const next = structuredClone(current);
    next.versions.push({
      version: next.versions.length + 1,
      status: 'submitted',
      objects,
      createdAt: 't',
      submittedAt: 't',
      basedOn: fromVersion,
    });
    useStore.setState({ images: images.map((im) => (im.id === current.id ? next : im)) });
  };

  const createdAt = 't';
  revise(1, (objs) => {
    objs.splice(0, objs.length,
      {
        id: 'split-left', categoryId: cats[0].id, createdAt, updatedAt: createdAt,
        contours: [createContour([{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 90 }, { x: 10, y: 90 }])],
      },
      {
        id: 'merged-2', categoryId: cats[1].id, createdAt, updatedAt: createdAt,
        contours: [createContour([
          { x: 50, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 100 }, { x: 190, y: 100 },
          { x: 190, y: 190 }, { x: 110, y: 190 }, { x: 110, y: 100 }, { x: 50, y: 100 },
        ])],
      },
    );
  });
  revise(1, (objs) => {
    objs.find((o) => o.id === obj1)!.categoryId = cats[2].id;
    void obj2;
  });
  return obj1;
}

describe('merge session store', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({ images: [], mergeSessions: [], selectedImageId: null, categories: defaultCategories() });
    useStore.getState().addImages([{ name: 'a.png', width: 200, height: 200, dataUrl: 'x' } as never]);
  });

  it('cascades undo only through truly dependent downstream relations and keeps other decisions', () => {
    fixture();
    const state = useStore.getState();
    const image = state.images[0];
    const session = state.startMerge(2, 3);
    const plan = planMerge(image, 2, 3);
    const split = plan.relations.find((r) => r.kind === 'split')!;
    const mergeRel = plan.relations.find((r) => r.kind === 'merge')!;
    expect(mergeRel.prerequisiteRelationIds).toContain(split.id);

    state.resolveRelation(split.id, 'confirmed');
    state.resolveRelation(mergeRel.id, 'confirmed');
    for (const c of plan.conflicts.filter((c) => !c.id.startsWith('conflict:relation:') && c.dependsOn)) {
      state.resolveConflict(c.id, 'adopt-b');
    }
    // 不相关的决定（伪造一条普通冲突决定）必须保留
    state.resolveConflict('category:UNRELATED', 'b');

    state.unresolveConflict('conflict:' + split.id);

    const after = useStore.getState().mergeSessions[0];
    expect(after.relations[split.id]).toBeUndefined();
    expect(after.relations[mergeRel.id]).toBeUndefined();
    for (const c of plan.conflicts.filter((c) => c.dependsOn)) {
      expect(after.resolutions[c.id]).toBeUndefined();
    }
    expect(after.resolutions['category:UNRELATED']).toBe('b');

    // 未完成不能提交；会话仍在（保存继续）
    expect(() => useStore.getState().completeMerge()).toThrow();
    expect(useStore.getState().mergeSessions).toHaveLength(1);
    // 原修订与冻结提交原样保留
    expect(useStore.getState().images[0].versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it('exit candidate keeps the session and decisions; cancel removes it', () => {
    fixture();
    const state = useStore.getState();
    state.startMerge(2, 3);
    expect(useStore.getState().mergeSessions).toHaveLength(1);
    // 退出候选只是 UI 行为；store 中会话保留以便再次进入
    const image = useStore.getState().images[0];
    const plan = planMerge(image, 2, 3);
    state.resolveRelation(plan.relations[0].id, 'confirmed');
    expect(useStore.getState().mergeSessions[0].relations[plan.relations[0].id]).toBe('confirmed');
    useStore.getState().cancelMerge();
    expect(useStore.getState().mergeSessions).toHaveLength(0);
  });
});
