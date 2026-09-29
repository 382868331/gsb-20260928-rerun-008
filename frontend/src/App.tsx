import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, AppState, DraftMap, VersionMeta } from "./types";
import { api } from "./api";
import { colorFor } from "./Editor";
import Editor from "./Editor";

type SaveStatus = "idle" | "saving" | "saved" | "error";

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [draft, setDraft] = useState<DraftMap>({});
  const [imageId, setImageId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [readOnly, setReadOnly] = useState<AppState | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bundleRef = useRef<HTMLInputElement>(null);
  const dirtyRef = useRef(false);

  const refresh = useCallback(async () => {
    const s = await api.state();
    setState(s);
    setDraft(s.draft.annotations);
    setImageId((cur) => cur || s.project.images[0]?.id || null);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // debounced autosave -> survives page close recovery on reload
  useEffect(() => {
    if (!state) return;
    dirtyRef.current = true;
    setSaveStatus("saving");
    const t = setTimeout(async () => {
      try {
        await api.saveDraft(draft);
        dirtyRef.current = false;
        setSaveStatus("saved");
      } catch (e) {
        setSaveStatus("error");
        setToast("草稿保存失败：" + (e as Error).message);
      }
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (saveStatus === "saving" || dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [saveStatus]);

  const images = state?.project.images || [];
  const image = images.find((i) => i.id === imageId) || null;
  const annotations = useMemo(() => (image ? draft[image.id] || [] : []), [draft, image]);

  function updateAnnotations(next: Annotation[]) {
    if (!image) return;
    setDraft((d) => ({ ...d, [image.id]: next }));
  }

  async function upload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.length) return;
    setBusy(true);
    try {
      const r = await api.upload(e.target.files);
      await refresh();
      setToast(`导入 ${r.imported.length} 张，去重 ${r.skipped_duplicates.length} 张` +
        (r.errors.length ? `，失败 ${r.errors.length} 张` : ""));
    } catch (err) {
      setToast("导入失败：" + (err as Error).message);
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  async function submitVersion() {
    const note = prompt("提交说明（可选）", "") ?? "";
    setBusy(true);
    try {
      await api.saveDraft(draft);
      const v = await api.submitVersion(note);
      await refresh();
      setToast(`已提交不可变版本 v${(v as VersionMeta).version}`);
    } catch (err) {
      setToast("提交失败：" + (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function importBundle(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setBusy(true);
    try {
      const r = await api.importBundle(f);
      await refresh();
      setToast(`导入成功：${r.imported_images} 张图片，${r.imported_annotations} 条标注（按内容哈希匹配）`);
    } catch (err) {
      setToast("导入被拒绝：" + (err as Error).message);
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  async function openVersion(v: number) {
    const s = await (await fetch("/api/versions/" + v)).json();
    setReadOnly(s);
    setViewingVersion(v);
  }

  if (!state) return <div className="loading">加载中…</div>;

  const totalObjs = Object.values(draft).reduce((n, a) => n + a.length, 0);

  return (
    <div className="app">
      <header className="topbar">
        <strong>多边形图像标注平台</strong>
        <span className="spacer" />
        <span className={"save " + saveStatus}>
          草稿：{saveStatus === "saving" ? "保存中…" : saveStatus === "saved" ? "已自动保存" : saveStatus === "error" ? "保存失败" : ""}
        </span>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={upload} />
        <button onClick={() => fileRef.current?.click()} disabled={busy}>导入图片</button>
        <button className="primary" onClick={submitVersion} disabled={busy || images.length === 0}>提交固定版本</button>
        <a className="btn" href={api.exportUrl()} download>导出当前草稿</a>
        <input ref={bundleRef} type="file" accept=".zip" hidden onChange={importBundle} />
        <button onClick={() => bundleRef.current?.click()} disabled={busy}>导入标注包</button>
      </header>
      <div className="main">
        <aside className="sidebar">
          <h3>图片（{images.length}）</h3>
          <div className="img-list">
            {images.map((img) => {
              const count = (draft[img.id] || []).length;
              return (
                <div key={img.id} className={"img-item " + (img.id === imageId && !readOnly ? "active" : "")}
                     onClick={() => { setImageId(img.id); setSelectedId(null); setReadOnly(null); setViewingVersion(null); }}>
                  <img src={api.imageUrl(img.id)} alt={img.filename} />
                  <div className="meta">
                    <div className="fname" title={img.filename}>{img.filename}</div>
                    <div className="sub">{img.width}×{img.height} · {count} 物</div>
                    <div className="sub hash" title={img.sha256}>{img.sha256.slice(0, 10)}</div>
                  </div>
                </div>
              );
            })}
            {images.length === 0 && <div className="empty">先导入一批图片</div>}
          </div>
          <h3>已提交版本（{state.versions.length}）· 不可变</h3>
          <div className="ver-list">
            {state.versions.map((v) => (
              <div key={v.version} className={"ver-item " + (viewingVersion === v.version ? "active" : "")} onClick={() => openVersion(v.version)}>
                <div>v{v.version} · {v.annotation_count} 标注 / {v.image_count} 图</div>
                <div className="sub">{v.submitted_at}</div>
                <a href={api.exportUrl(v.version)} download onClick={(e) => e.stopPropagation()}>下载快照 zip</a>
              </div>
            ))}
            {state.versions.length === 0 && <div className="empty">尚未提交版本</div>}
          </div>
        </aside>

        <section className="workspace">
          {readOnly && image ? (
            <ReadOnlyView version={readOnly} imageId={image.id} />
          ) : image ? (
            <Editor
              image={image}
              annotations={annotations}
              categories={state.project.categories}
              onChange={updateAnnotations}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          ) : (
            <div className="empty big">没有图片，请先导入</div>
          )}
        </section>

        <aside className="objects">
          <h3>本图物体（{annotations.length}）· 共 {totalObjs}</h3>
          {readOnly ? null : annotations.map((a) => (
            <div key={a.object_id} className={"obj-item " + (a.object_id === selectedId ? "active" : "")}
                 onClick={() => setSelectedId(a.object_id)}>
              <span className="dot" style={{ background: colorFor(a.object_id) }} />
              <span className="cat">{a.category}</span>
              <span className="sub">{a.geometry.length} 轮廓</span>
            </div>
          ))}
        </aside>
      </div>
      {toast && <div className="toast" onClick={() => setToast(null)}>{toast}</div>}
    </div>
  );
}

function ReadOnlyView({ version, imageId }: { version: any; imageId: string }) {
  const vImg = version.images.find((i: any) => i.id === imageId);
  const anns = (version.annotations[imageId] || []) as Annotation[];
  const img = vImg;
  if (!img) return <div className="empty big">该版本中不含此图片（内容哈希不匹配的图片不会被错误对应）</div>;
  return (
    <div className="readonly">
      <div className="ro-banner">只读查看 v{version.version} 快照 · digest {String(version.digest).slice(0, 12)}… · 之后的草稿不会影响此版本</div>
      <svg viewBox={`0 0 ${img.width} ${img.height}`} className="ro-svg">
        <image href={api.imageUrl(imageId)} width={img.width} height={img.height} />
        {anns.map((a) => (
          <g key={a.object_id}>
            {a.geometry.map((poly, pi) => (
              <path key={pi}
                d={poly.map((ring) =>
                  ring.map(([x, y], k) => (k ? "L" : "M") + x * img.width + "," + y * img.height).join(" ") + " Z"
                ).join(" ")}
                fill={colorFor(a.object_id)} fillOpacity={0.18} stroke={colorFor(a.object_id)} />
            ))}
          </g>
        ))}
      </svg>
    </div>
  );
}
