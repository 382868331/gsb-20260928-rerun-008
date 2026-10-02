import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MergePanel } from './MergePanel';
import { useStore } from '../store';
import {
  addDraftObject,
  createContour,
  defaultCategories,
  submitDraft,
  updateDraftObject,
} from '../core/versioning';
import type { AnnotationObject } from '../types';

const cats = defaultCategories();

function makeImage() {
  useStore.getState().addImages([{ name: 'a.png', width: 200, height: 200, dataUrl: 'x' } as never]);
  let img = useStore.getState().images[0];
  const r1 = addDraftObject(img, cats[0].id);
  img = updateDraftObject(r1.image, r1.objectId, (o) => {
    o.contours.push(createContour([
      { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 90 }, { x: 10, y: 90 },
    ]));
  });
  const r2 = addDraftObject(img, cats[1].id);
  img = updateDraftObject(r2.image, r2.objectId, (o) => {
    o.contours.push(createContour([
      { x: 110, y: 110 }, { x: 190, y: 110 }, { x: 190, y: 190 }, { x: 110, y: 190 },
    ]));
  });
  img = submitDraft(img);
  useStore.setState({ images: [img] });
  const obj1 = r1.objectId;
  const obj2 = r2.objectId;
  const revise = (mutate: (objects: AnnotationObject[]) => void) => {
    const images = useStore.getState().images;
    const current = images[0];
    const objects = structuredClone(current.versions[0].objects);
    mutate(objects);
    const next = structuredClone(current);
    next.versions.push({
      version: next.versions.length + 1,
      status: 'submitted',
      objects,
      createdAt: 't',
      submittedAt: 't',
      basedOn: 1,
    });
    useStore.setState({ images: images.map((im) => (im.id === current.id ? next : im)) });
  };
  revise((objs) => { objs.find((o) => o.id === obj1)!.categoryId = cats[1].id; });
  revise((objs) => { objs.find((o) => o.id === obj1)!.categoryId = cats[2].id; void obj2; });
  return useStore.getState().images[0];
}

describe('MergePanel', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({
      images: [], mergeSessions: [], selectedImageId: null,
      categories: defaultCategories(), lastImport: null,
    });
  });

  it('starts a merge without crashing and supports save-exit and resume', () => {
    const image = makeImage();
    const { rerender } = render(<MergePanel image={useStore.getState().images[0]} />);
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '2' } });
    fireEvent.change(screen.getAllByRole('combobox')[1], { target: { value: '3' } });
    fireEvent.click(screen.getByText('开始合并'));
    // 进入合并视图而不是白屏
    expect(screen.getByText(/合并 v2 与 v3/)).toBeTruthy();
    // 做出一项决定
    fireEvent.click(screen.getAllByText('采用 A')[0]);
    fireEvent.click(screen.getByText('保存并退出候选'));
    expect(screen.getByText('合并进行中')).toBeTruthy();
    expect(useStore.getState().mergeSessions).toHaveLength(1);
    // 再次进入：决定仍在
    fireEvent.click(screen.getByText('再次进入合并'));
    expect(screen.getByText(/已决定 1\//)).toBeTruthy();
    rerender(<MergePanel image={image} />);
  });
});
