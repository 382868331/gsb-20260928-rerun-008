"""File-based storage with atomic writes and strict content-hash identity."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import uuid
from datetime import datetime, timezone

from geometry import GeometryError, validate_multipolygon
from imgmeta import image_dimensions


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, root: str):
        self.root = os.path.abspath(root)
        self.data_dir = os.path.join(self.root, "data")
        self.images_dir = os.path.join(self.root, "images")
        os.makedirs(self.images_dir, exist_ok=True)
        self.project_path = os.path.join(self.data_dir, "project.json")
        self.draft_path = os.path.join(self.data_dir, "draft.json")
        self.versions_dir = os.path.join(self.data_dir, "versions")
        os.makedirs(self.versions_dir, exist_ok=True)
        self.lock = threading.RLock()
        if not os.path.exists(self.project_path):
            self._write_json(self.project_path, {
                "id": uuid.uuid4().hex,
                "created_at": now_iso(),
                "images": [],
                "categories": ["object", "car", "person", "animal"],
            })
        if not os.path.exists(self.draft_path):
            self._write_json(self.draft_path, {"annotations": {}, "updated_at": now_iso()})

    # ---------- low level ----------

    def _write_json(self, path: str, obj) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(obj, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)

    def _read_json(self, path: str):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def project(self):
        with self.lock:
            return self._read_json(self.project_path)

    def _save_project(self, p):
        self._write_json(self.project_path, p)

    def draft(self):
        with self.lock:
            return self._read_json(self.draft_path)

    def _find_image(self, p, image_id):
        for img in p["images"]:
            if img["id"] == image_id:
                return img
        return None

    # ---------- images ----------

    def import_image(self, data: bytes, filename: str) -> dict:
        sha = hashlib.sha256(data).hexdigest()
        try:
            width, height, fmt = image_dimensions(data)
        except ValueError as e:
            raise ClientError(str(e), 415)
        with self.lock:
            p = self.project()
            for img in p["images"]:
                if img["sha256"] == sha:
                    return {"already_exists": True, "image": img}
            ext = os.path.splitext(filename)[1].lower()[:10] or (".%s" % fmt)
            image_id = uuid.uuid4().hex
            stored = "%s%s" % (sha, ext)
            dest = os.path.join(self.images_dir, stored)
            if not os.path.exists(dest):
                with open(dest, "wb") as f:
                    f.write(data)
            img = {
                "id": image_id,
                "sha256": sha,
                "filename": filename,
                "stored": stored,
                "width": width,
                "height": height,
                "format": fmt,
                "size": len(data),
                "imported_at": now_iso(),
            }
            p["images"].append(img)
            self._save_project(p)
            return {"already_exists": False, "image": img}

    def image_file(self, image_id: str) -> tuple[dict, str]:
        p = self.project()
        img = self._find_image(p, image_id)
        if not img:
            raise ClientError("image not found", 404)
        return img, os.path.join(self.images_dir, img["stored"])

    # ---------- annotations / draft ----------

    def save_draft(self, annotations_by_image: dict) -> dict:
        """Replace the whole draft. Validates ownership and geometry."""
        with self.lock:
            p = self.project()
            valid_ids = {i["id"] for i in p["images"]}
            clean = {}
            seen_object_ids = set()
            if not isinstance(annotations_by_image, dict):
                raise ClientError("annotations must be an object keyed by image id", 400)
            for image_id, anns in annotations_by_image.items():
                if image_id not in valid_ids:
                    raise ClientError("unknown image id: %s" % image_id, 400)
                if not isinstance(anns, list):
                    raise ClientError("annotations for %s must be a list" % image_id, 400)
                out = []
                for a in anns:
                    obj_id = str(a.get("object_id") or "").strip()
                    if not obj_id:
                        raise ClientError("object_id is required", 400)
                    if obj_id in seen_object_ids:
                        raise ClientError("duplicate object_id within draft: %s" % obj_id, 400)
                    seen_object_ids.add(obj_id)
                    category = str(a.get("category") or "").strip()
                    if not category:
                        raise ClientError("category is required for %s" % obj_id, 400)
                    try:
                        geom = validate_multipolygon(a.get("geometry"))
                    except GeometryError as e:
                        raise ClientError("invalid geometry for %s: %s" % (obj_id, e), 400)
                    out.append({
                        "object_id": obj_id,
                        "category": category,
                        "geometry": geom,
                        "updated_at": now_iso(),
                    })
                clean[image_id] = out
            d = {"annotations": clean, "updated_at": now_iso()}
            self._write_json(self.draft_path, d)
            return d

    def set_categories(self, categories):
        if not isinstance(categories, list) or not all(isinstance(c, str) and c.strip() for c in categories):
            raise ClientError("categories must be a non-empty list of strings", 400)
        with self.lock:
            p = self.project()
            p["categories"] = categories
            self._save_project(p)
            return p["categories"]

    # ---------- versions ----------

    def submit_version(self, note: str = "") -> dict:
        with self.lock:
            p = self.project()
            d = self._read_json(self.draft_path)
            existing = self.list_versions()
            version_no = max((v["version"] for v in existing), default=0) + 1
            snapshot = {
                "version": version_no,
                "id": uuid.uuid4().hex,
                "submitted_at": now_iso(),
                "note": note,
                "project_id": p["id"],
                "images": [
                    {k: img[k] for k in
                     ("id", "sha256", "filename", "width", "height", "format", "size", "stored")}
                    for img in p["images"]
                ],
                "annotations": d["annotations"],
            }
            digest = hashlib.sha256(
                json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode("utf-8")
            ).hexdigest()
            snapshot["digest"] = digest
            path = os.path.join(self.versions_dir, "v%04d.json" % version_no)
            if os.path.exists(path):
                raise ClientError("version file already exists", 409)
            self._write_json(path, snapshot)
            return snapshot

    def list_versions(self):
        with self.lock:
            out = []
            for fn in sorted(os.listdir(self.versions_dir)):
                if fn.endswith(".json"):
                    v = self._read_json(os.path.join(self.versions_dir, fn))
                    out.append({
                        "version": v["version"],
                        "id": v["id"],
                        "submitted_at": v["submitted_at"],
                        "note": v.get("note", ""),
                        "digest": v["digest"],
                        "image_count": len(v["images"]),
                        "annotation_count": sum(len(a) for a in v["annotations"].values()),
                    })
            return out

    def get_version(self, version_no: int):
        path = os.path.join(self.versions_dir, "v%04d.json" % version_no)
        if not os.path.exists(path):
            raise ClientError("version not found", 404)
        return self._read_json(path)

    # ---------- export / import ----------

    def export_package(self, version_no: int | None = None) -> tuple[dict, list[tuple[str, bytes]]]:
        """Return (manifest, files) for a self-describing, hash-verified bundle."""
        with self.lock:
            if version_no is None:
                snapshot = None
                p = self.project()
                d = self.draft()
                images = p["images"]
                annotations = d["annotations"]
                kind = "draft"
            else:
                snapshot = self.get_version(version_no)
                images = snapshot["images"]
                annotations = snapshot["annotations"]
                kind = "version"
            files = []
            for img in images:
                with open(os.path.join(self.images_dir, img["stored"]), "rb") as f:
                    files.append((os.path.join("images", img["stored"]), f.read()))
            manifest = {
                "package_type": "image-annotation-bundle",
                "kind": kind,
                "exported_at": now_iso(),
                "format_version": 1,
                "version": version_no,
                "images": images,
                "annotations": annotations,
            }
            manifest["manifest_digest"] = hashlib.sha256(
                json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode("utf-8")
            ).hexdigest()
            files.append(("manifest.json",
                          json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")))
            return manifest, files

    def import_package(self, manifest: dict, blob_getter) -> dict:
        """Import a bundle.

        blob_getter(stored_name) -> bytes|None.
        Every referenced image must hash to its declared sha256, otherwise the
        import is rejected wholesale. A missing image is reported explicitly and
        never silently matched to another file by name.
        """
        with self.lock:
            if manifest.get("package_type") != "image-annotation-bundle":
                raise ClientError("not an image annotation bundle", 400)
            images = manifest.get("images", [])
            annotations = manifest.get("annotations", {})
            if not isinstance(images, list) or not isinstance(annotations, dict):
                raise ClientError("malformed manifest", 400)

            p = self.project()
            by_sha = {i["sha256"]: i for i in p["images"]}

            resolved = []
            missing, hash_mismatch = [], []
            pending = []
            for img in images:
                sha = img.get("sha256")
                stored = img.get("stored")
                if not sha or not stored:
                    raise ClientError("manifest image missing sha256/stored", 400)
                if sha in by_sha:
                    resolved.append(by_sha[sha])
                    continue
                data = blob_getter(stored)
                if data is None:
                    missing.append(img.get("filename") or sha)
                    continue
                actual = hashlib.sha256(data).hexdigest()
                if actual != sha:
                    hash_mismatch.append({"filename": img.get("filename"),
                                          "expected": sha, "actual": actual})
                    continue
                pending.append((img, data))

            if missing or hash_mismatch:
                raise ClientError(json.dumps({
                    "error": "bundle rejected: image integrity problems",
                    "missing": missing,
                    "hash_mismatch": hash_mismatch,
                }, ensure_ascii=False), 422)

            for img, data in pending:
                r = self.import_image(data, img.get("filename", img.get("stored")))
                resolved.append(r["image"])

            sha_to_newid = {img["sha256"]: img["id"] for img in resolved}
            merged = self.draft()["annotations"]
            imported_count = 0
            for old_img in images:
                sha = old_img["sha256"]
                new_id = sha_to_newid[sha]
                anns = annotations.get(old_img["id"], [])
                validated = []
                for a in anns:
                    try:
                        geom = validate_multipolygon(a.get("geometry"))
                    except GeometryError as e:
                        raise ClientError("invalid geometry: %s" % e, 400)
                    validated.append({
                        "object_id": str(a["object_id"]),
                        "category": str(a["category"]),
                        "geometry": geom,
                        "updated_at": now_iso(),
                    })
                    imported_count += 1
                existing = merged.get(new_id, [])
                known = {a["object_id"] for a in existing}
                for a in validated:
                    if a["object_id"] not in known:
                        existing.append(a)
                merged[new_id] = existing
            self.save_draft(merged)
            return {"imported_images": len(images), "imported_annotations": imported_count}


class ClientError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status
