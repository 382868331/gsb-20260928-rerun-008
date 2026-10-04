import { describe, expect, it } from 'vitest';
import {
  applyMergeSession,
  createMergeSession,
  planMerge,
} from './merge';
import {
  addDraftObject,
  createContour,
  createHole,
  createImage,
  defaultCategories,
  submitDraft,
  updateDraftObject,
} from './versioning';
import { exportProject, importProject } from './exchange';
import type { ImageRecord, MergeSession } from '../types';

const cats = defaultCategories();

/** 构建 v1=root；v2=root 拆成 left/right；v3=right 与 neighbor 合并为 joined；v4=另一分支改 root 类别 */
function buildChainImage(): { img: ImageRecord; rootId: string; neighborId: string } {
  let img = createImage({ name: 'chain.png', width: 200, height: 200, dataUrl: 'data:image/png;base64,STUB' });
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
  const rootId = r1.objectId;
  const neighborId = r2.objectId;
  img = submitDraft(img, 'root with neighbor');

  const ts = () => new Date().toISOString();
  // v2：root 拆成 left、right
  { const v2 = structuredClone(img);
    v2.versions.push({
      version: 2, status: 'submitted',
      createdAt: ts(), submittedAt: ts(), basedOn: 1,
      objects: [
        {
          id: 'left', categoryId: cats[0].id, createdAt: ts(), updatedAt: ts(),
          contours: [createContour([{ x: 10, y: 10 }, { x: 40, y: 10 }, { x: 40, y: 90 }, { x: 10, y: 90 }])],
          provenance: { sources: [{ objectId: rootId }], transformation: 'split' },
        },
        {
          id: 'right', categoryId: cats[0].id, createdAt: ts(), updatedAt: ts(),
          contours: [createContour([{ x: 50, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 50, y: 90 }])],
          provenance: { sources: [{ objectId: rootId }], transformation: 'split' },
        },
        ...img.versions[0].objects.filter((o) => o.id === neighborId),
      ],
    });
    img = v2;
  }

  // v3：right 与 neighbor 合并成 joined（多代来源：root + neighbor）
  {
    const v3 = structuredClone(img);
    v3.versions.push({
      version: 3, status: 'submitted',
      createdAt: ts(), submittedAt: ts(), basedOn: 2,
      objects: [
        ...img.versions[1].objects.filter((o) => o.id === 'left'),
        {
          id: 'joined', categoryId: cats[1].id, createdAt: ts(), updatedAt: ts(),
          contours: [createContour([{ x: 50, y: 10 }, { x: 190, y: 10 }, { x: 190, y: 190 }, { x: 50, y: 190 }])],
          provenance: { sources: [{ objectId: rootId }, { objectId: neighborId }], transformation: 'merge' },
        },
      ],
    });
    img = v3;
  }

  // v4：另一分支（仍基于 v1）修改 root 的类别
  {
    const v4 = structuredClone(img);
    const objects = structuredClone(img.versions[0].objects);
    objects.find((o) => o.id === rootId)!.categoryId = cats[2].id;
    v4.versions.push({
      version: 4, status: 'submitted',
      createdAt: ts(), submittedAt: ts(), basedOn: 1,
      objects,
    });
    img = v4;
  }

  return { img, rootId, neighborId };
}

/** 模拟全新浏览器上下文：只带导出文件导入，库中没有任何本地数据 */
function reopenFresh(raw: string, categories = cats) {
  const out = importProject(raw, {
    existingImages: [],
    existingCategories: categories,
    existingMergeSessions: [],
  });
  expect(out.result.rejected).toEqual([]);
  expect(out.result.issues).toEqual([]);
  const image = out.images[0];
  const session = out.mergeSessions.find((m) => m.imageId === image.id)!;
  return { out, image, session };
}

function progressOf(image: ImageRecord, session: MergeSession) {
  const plan = planMerge(image, session.aVersion, session.bVersion);
  const statusOf = (conflictId: string) =>
    conflictId.startsWith('conflict:relation:')
      ? session.relations[conflictId.slice('conflict:'.length)]
      : session.resolutions[conflictId];
  const total = plan.conflicts.length;
  const done = plan.conflicts.filter((c) => statusOf(c.id)).length;
  return { plan, total, done };
}

describe('merge session export/import across adjudication stages', () => {
  it('reopens an unstarted merge: nothing is auto-accepted after import', () => {
    const { img } = buildChainImage();
    const session = createMergeSession(img, 3, 4);
    expect(session.resolutions).toEqual({});
    expect(session.relations).toEqual({});

    const raw = JSON.stringify(exportProject([img], cats, [session]));
    const { image, session: restored } = reopenFresh(raw);

    // 参与比较的全部修订（含中间提交）都在，且历史原样不动
    expect(image.versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
    expect(image.versions.every((v) => v.status === 'submitted')).toBe(true);
    expect(restored.baseVersion).toBe(1);
    expect(restored.aVersion).toBe(3);
    expect(restored.bVersion).toBe(4);

    const { total, done } = progressOf(image, restored);
    expect(total).toBeGreaterThan(0);
    expect(done).toBe(0);
    // 未裁决时不能落地合并
    expect(() => applyMergeSession(image, restored)).toThrow(/未确认/);
  });

  it('reopens a partially adjudicated merge and later produces the merge commit', () => {
    const { img, rootId, neighborId } = buildChainImage();
    const session = createMergeSession(img, 3, 4);
    const plan = planMerge(img, 3, 4);
    const splitRel = plan.relations.find((r) => r.kind === 'split')!;
    const mergeRel = plan.relations.find((r) => r.kind === 'merge')!;

    // 部分裁决：确认拆分关系，合并关系及其余逐项决定都还没做
    session.relations[splitRel.id] = 'confirmed';
    const beforeRaw = JSON.stringify(exportProject([img], cats, [session]));
    const first = reopenFresh(beforeRaw);
    const p1 = progressOf(first.image, first.session);
    expect(p1.done).toBeGreaterThan(0);
    expect(p1.done).toBeLessThan(p1.total);
    // 多代来源关系随原物体一起回来
    const joined = first.image.versions.find((v) => v.version === 3)!
      .objects.find((o) => o.id === 'joined')!;
    expect(joined.provenance?.sources.map((s) => s.objectId).sort()).toEqual([rootId, neighborId].sort());
    expect(() => applyMergeSession(first.image, first.session)).toThrow(/未确认/);

    // 在重开的会话上继续裁决：确认合并关系，逐项冲突全部采用修订 B（v4 的类别改动）
    // 继续裁决：确认全部剩余拆合关系（合并 + 孔洞晋升），逐项片段冲突全部采用 B
    for (const rel of progressOf(first.image, first.session).plan.relations) {
      if (first.session.relations[rel.id] === undefined) {
        first.session.relations[rel.id] = 'confirmed';
      }
    }
    for (const conflict of progressOf(first.image, first.session).plan.conflicts) {
      if (conflict.id.startsWith('conflict:relation:')) continue;
      first.session.resolutions[conflict.id] = 'adopt-b';
    }
    const partialRaw = JSON.stringify(exportProject([first.image], cats, [first.session]));
    const second = reopenFresh(partialRaw);
    const p2 = progressOf(second.image, second.session);
    expect(p2.done).toBe(p2.total);

    const merged = applyMergeSession(second.image, second.session, 'resumed merge');
    const historical = merged.versions.filter((v) => v.version <= 4);
    expect(historical.map((v) => v.version)).toEqual([1, 2, 3, 4]);
    const commit = merged.versions.at(-1)!;
    expect(commit.version).toBe(5);
    expect(commit.mergeOf).toEqual({ base: 1, a: 3, b: 4 });
    // v4 对 root 类别的修改沿多代链到达 left 与 joined
    expect(commit.objects.map((o) => o.id).sort()).toEqual(['joined', 'left']);
    expect(commit.objects.every((o) => o.categoryId === cats[2].id)).toBe(true);
    expect(commit.mergeAudit?.relations).toHaveLength(3);
    expect(commit.mergeAudit?.relations.every((r) => r.decision === 'confirmed')).toBe(true);
  });

  it('reopens a disputed merge: unresolved disputes block completion and survive another round-trip', () => {
    const { img } = buildChainImage();
    const session = createMergeSession(img, 3, 4);
    const plan = planMerge(img, 3, 4);
    const splitRel = plan.relations.find((r) => r.kind === 'split')!;
    const mergeRel = plan.relations.find((r) => r.kind === 'merge')!;
    session.relations[splitRel.id] = 'confirmed';
    // 合并关系之外的其它拆合关系以及逐项类别冲突均保留争议
    session.relations[mergeRel.id] = 'disputed';
    const planWithSplit = planMerge(img, 3, 4);
    for (const rel of planWithSplit.relations) {
      if (session.relations[rel.id] === undefined) session.relations[rel.id] = 'disputed';
    }
    const categoryConflict = planWithSplit.conflicts
      .filter((c) => !c.id.startsWith('conflict:relation:'))
      .find((c) => c.part === 'category')!;
    session.resolutions[categoryConflict.id] = 'disputed';

    const raw = JSON.stringify(exportProject([img], cats, [session]));
    const first = reopenFresh(raw);
    expect(first.session.relations[mergeRel.id]).toBe('disputed');
    expect(first.session.resolutions[categoryConflict.id]).toBe('disputed');
    expect(() => applyMergeSession(first.image, first.session)).toThrow(/争议/);

    // 再导出再重开，争议仍在，且历史提交没有变化
    const rawAgain = JSON.stringify(exportProject([first.image], cats, [first.session]));
    const second = reopenFresh(rawAgain);
    expect(second.session.relations[mergeRel.id]).toBe('disputed');
    expect(second.image.versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
    expect(() => applyMergeSession(second.image, second.session)).toThrow(/争议/);
  });
});
