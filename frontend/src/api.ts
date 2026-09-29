import type { AppState, DraftMap } from "./types";

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  const text = await r.text();
  const data = text ? JSON.parse(text) : {};
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
  return data as T;
}

export const api = {
  state: () => req<AppState>("/api/state"),
  upload(files: FileList | File[]) {
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append("files", f, f.name));
    return req<{ imported: unknown[]; skipped_duplicates: unknown[]; errors: unknown[] }>(
      "/api/images",
      { method: "POST", body: fd }
    );
  },
  saveDraft(annotations: DraftMap) {
    return req("/api/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotations }),
    });
  },
  submitVersion(note: string) {
    return req("/api/versions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note }),
    });
  },
  importBundle(file: File) {
    const fd = new FormData();
    fd.append("bundle", file, file.name);
    return req<{ imported_images: number; imported_annotations: number }>("/api/import", {
      method: "POST",
      body: fd,
    });
  },
  exportUrl(version?: number) {
    return "/api/export" + (version ? "?version=" + version : "");
  },
  imageUrl(id: string) {
    return "/api/images/" + id + "/raw";
  },
};
