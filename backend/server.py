"""Zero-dependency HTTP API + static server for the annotation platform."""

from __future__ import annotations

import io
import json
import os
import re
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from store import Store, ClientError

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.normpath(os.path.join(BASE, "..", "frontend", "dist"))
STORE = Store(os.environ.get("DATA_DIR", os.path.join(BASE, "..", "data")))

CONTENT_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".js": "text/javascript",
    ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml",
    ".json": "application/json", ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "Annotate/1.0"

    def log_message(self, fmt, *args):
        pass

    # ---------- helpers ----------

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data, content_type, status=200, filename=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if filename:
            self.send_header("Content-Disposition",
                             'attachment; filename="%s"' % filename)
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        n = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(n) if n else b""

    def _multipart_files(self):
        ctype = self.headers.get("Content-Type", "")
        m = re.search(r"boundary=([^;]+)", ctype)
        if not m:
            raise ClientError("expected multipart/form-data", 400)
        boundary = m.group(1).strip().strip('"')
        body = self._read_body()
        delim = b"--" + boundary.encode()
        files = []
        fields = {}
        for part in body.split(delim):
            part = part.strip(b"\r\n")
            if not part or part == b"--":
                continue
            head, _, content = part.partition(b"\r\n\r\n")
            headers = head.decode("utf-8", "replace")
            if content.endswith(b"\r\n"):
                content = content[:-2]
            name_m = re.search(r'name="([^"]*)"', headers)
            fn_m = re.search(r'filename="([^"]*)"', headers)
            if not name_m:
                continue
            name = name_m.group(1)
            if fn_m:
                files.append((name, fn_m.group(1), content))
            else:
                fields[name] = content.decode("utf-8", "replace")
        return fields, files

    # ---------- routing ----------

    def do_GET(self):
        try:
            url = urlparse(self.path)
            q = parse_qs(url.query)
            path = url.path
            if path == "/api/state":
                self._json({
                    "project": STORE.project(),
                    "draft": STORE.draft(),
                    "versions": STORE.list_versions(),
                })
            elif path == "/api/versions":
                self._json({"versions": STORE.list_versions()})
            elif m := re.fullmatch("/api/versions/([0-9]+)", path):
                self._json(STORE.get_version(int(m.group(1))))
            elif m := re.fullmatch(r"/api/images/([0-9a-f]+)/raw", path):
                img, full = STORE.image_file(m.group(1))
                with open(full, "rb") as f:
                    ext = os.path.splitext(img["stored"])[1].lower()
                    self._bytes(f.read(), CONTENT_TYPES.get(ext, "application/octet-stream"))
            elif path == "/api/export":
                version_no = int(q["version"][0]) if q.get("version") else None
                manifest, files = STORE.export_package(version_no)
                buf = io.BytesIO()
                with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
                    for name, data in files:
                        z.writestr(name, data)
                tag = "v%s" % version_no if version_no else "draft"
                self._bytes(buf.getvalue(), "application/zip",
                            filename="annotations-%s.zip" % tag)
            else:
                self._serve_static(path)
        except ClientError as e:
            self._json({"error": str(e)}, e.status)
        except Exception as e:  # noqa: BLE001
            self._json({"error": "internal: %s" % e}, 500)

    def do_POST(self):
        try:
            url = urlparse(self.path)
            path = url.path
            if path == "/api/images":
                fields, files = self._multipart_files()
                imported, skipped, errors = [], [], []
                for _, filename, data in files:
                    if not data:
                        continue
                    try:
                        r = STORE.import_image(data, filename)
                        (skipped if r["already_exists"] else imported).append(r["image"])
                    except ClientError as e:
                        errors.append({"filename": filename, "error": str(e)})
                self._json({"imported": imported, "skipped_duplicates": skipped,
                            "errors": errors}, 207 if errors else 200)
            elif path == "/api/draft":
                payload = json.loads(self._read_body() or b"{}")
                self._json(STORE.save_draft(payload.get("annotations", {})))
            elif path == "/api/categories":
                payload = json.loads(self._read_body() or b"{}")
                self._json({"categories": STORE.set_categories(payload.get("categories"))})
            elif path == "/api/versions":
                payload = json.loads(self._read_body() or b"{}")
                self._json(STORE.submit_version(payload.get("note", "")))
            elif path == "/api/import":
                fields, files = self._multipart_files()
                if files:
                    _, _, zdata = files[0]
                    zf = zipfile.ZipFile(io.BytesIO(zdata))
                    names = set(zf.namelist())
                    if "manifest.json" not in names:
                        raise ClientError("zip has no manifest.json", 400)
                    manifest = json.loads(zf.read("manifest.json").decode("utf-8"))

                    def getter(stored):
                        key = "images/" + stored
                        return zf.read(key) if key in names else None
                else:
                    manifest = json.loads(self._read_body() or b"{}")
                    getter = lambda stored: None
                self._json(STORE.import_package(manifest, getter))
            else:
                self._json({"error": "not found"}, 404)
        except ClientError as e:
            detail = e.args[0] if e.args else str(e)
            try:
                parsed = json.loads(detail)
                self._json(parsed, e.status)
            except (ValueError, TypeError):
                self._json({"error": detail}, e.status)
        except zipfile.BadZipFile:
            self._json({"error": "not a valid zip package"}, 400)
        except Exception as e:  # noqa: BLE001
            self._json({"error": "internal: %s" % e}, 500)

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        rel = path.lstrip("/").replace(chr(92), "/")
        full = os.path.normpath(os.path.join(STATIC, rel))
        if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
            index = os.path.join(STATIC, "index.html")
            if os.path.isfile(index):
                full = index
            else:
                self._json({"error": "frontend not built; run: npm run build",
                            "api": "use /api/state"}, 404)
                return
        ext = os.path.splitext(full)[1].lower()
        with open(full, "rb") as f:
            self._bytes(f.read(), CONTENT_TYPES.get(ext, "application/octet-stream"))


def main():
    port = int(os.environ.get("PORT", "8000"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("annotation platform on http://localhost:%d" % port)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
