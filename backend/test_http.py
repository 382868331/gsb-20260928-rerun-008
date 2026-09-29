"""In-process HTTP E2E tests (sandbox blocks real sockets)."""

import io
import json
import os
import shutil
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server as srv
from test_platform import make_png, square

TMP = tempfile.mkdtemp()
srv.STORE = srv.Store(TMP)

CRLF = "\r\n"


class FakeConn:
    def __init__(self):
        self.rfile = io.BytesIO()
        self.wfile = io.BytesIO()

    def sendall(self, data):
        self.wfile.write(data)

    def makefile(self, mode, *_):
        return self.rfile if "r" in mode else self.wfile


def call(method, path, body=b"", content_type=None):
    conn = FakeConn()
    headers = "%s %s HTTP/1.1" % (method, path) + CRLF
    headers += "Content-Length: %d" % len(body) + CRLF
    if content_type:
        headers += "Content-Type: " + content_type + CRLF
    conn.rfile = io.BytesIO((headers + CRLF).encode() + body)
    srv.Handler(conn, ("1.1.1.1", 1), None)
    raw = conn.wfile.getvalue()
    head, _, payload = raw.partition((CRLF + CRLF).encode())
    status = int(head.split(CRLF.encode())[0].split()[1])
    return status, payload


def multipart(fields_files):
    boundary = "----testboundary"
    buf = b""
    for name, filename, data in fields_files:
        head = "--%s" % boundary + CRLF
        head += 'Content-Disposition: form-data; name="%s"; filename="%s"' % (name, filename) + CRLF + CRLF
        buf += head.encode() + data + CRLF.encode()
    buf += ("--%s--" % boundary + CRLF).encode()
    return buf, "multipart/form-data; boundary=" + boundary


def jbody(obj):
    return json.dumps(obj).encode(), "application/json"


def main():
    png1 = make_png(100, 80, (200, 10, 10))
    png2 = make_png(60, 120, (10, 200, 10))
    body, ct = multipart([("files", "one.png", png1), ("files", "two.png", png2)])
    st, payload = call("POST", "/api/images", body, ct)
    assert st == 200, (st, payload[:200])
    up = json.loads(payload)
    assert len(up["imported"]) == 2
    id1, id2 = up["imported"][0]["id"], up["imported"][1]["id"]
    sha1 = up["imported"][0]["sha256"]

    body, ct = multipart([("files", "renamed.png", png1)])
    st, payload = call("POST", "/api/images", body, ct)
    assert json.loads(payload)["skipped_duplicates"][0]["sha256"] == sha1

    donut = [[[[.05, .05], [.95, .05], [.95, .95], [.05, .95]],
              [[.4, .4], [.6, .4], [.6, .6], [.4, .6]]]]
    anns = {
        id1: [
            {"object_id": "A", "category": "car", "geometry": donut},
            {"object_id": "B", "category": "person", "geometry": square(.3, .3, .8, .8)},
        ],
        id2: [{"object_id": "A2", "category": "car", "geometry": square(.1, .1, .5, .5)}],
    }
    st, payload = call("POST", "/api/draft", *jbody({"annotations": anns}))
    assert st == 200, payload

    st, _ = call("POST", "/api/draft", *jbody({"annotations": {
        id1: [{"object_id": "Z", "category": "car", "geometry": square(0, 0, 1.5, 1)}]}}))
    assert st == 400

    st, payload = call("POST", "/api/versions", *jbody({"note": "frozen"}))
    assert st == 200
    digest1 = json.loads(payload)["digest"]

    anns[id1] = [{"object_id": "A", "category": "truck", "geometry": square(0, 0, 1, 1)}]
    call("POST", "/api/draft", *jbody({"annotations": anns}))
    call("POST", "/api/versions", *jbody({"note": "later"}))
    st, payload = call("GET", "/api/versions/1")
    got = json.loads(payload)
    assert got["digest"] == digest1
    assert got["annotations"][id1][0]["category"] == "car"
    assert len(got["annotations"][id1][0]["geometry"][0]) == 2

    st, bundle = call("GET", "/api/export?version=1")
    assert st == 200
    zf = zipfile.ZipFile(io.BytesIO(bundle))
    names = zf.namelist()
    assert "manifest.json" in names
    img_files = [n for n in names if n.startswith("images/")]
    b1, b2 = zf.read(img_files[0]), zf.read(img_files[1])
    manifest_bytes = zf.read("manifest.json")

    fresh = tempfile.mkdtemp()
    srv.STORE = srv.Store(fresh)

    def zip_from(pairs):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for name, data in pairs:
                z.writestr(name, data)
        return buf.getvalue()

    tampered = zip_from([("manifest.json", manifest_bytes),
                         (img_files[0], b2), (img_files[1], b1)])
    st, payload = call("POST", "/api/import", *multipart([("bundle", "bad.zip", tampered)]))
    assert st == 422, (st, payload[:200])
    detail = json.loads(payload)
    assert detail["hash_mismatch"]

    partial = zip_from([("manifest.json", manifest_bytes), (img_files[0], b1)])
    st, payload = call("POST", "/api/import", *multipart([("bundle", "p.zip", partial)]))
    assert st == 422
    detail = json.loads(payload)
    assert len(detail["missing"]) == 1

    st, payload = call("POST", "/api/import", *multipart([("bundle", "good.zip", bundle)]))
    assert st == 200, (st, payload[:200])
    res = json.loads(payload)
    assert res["imported_images"] == 2 and res["imported_annotations"] == 3

    st, payload = call("GET", "/api/state")
    state = json.loads(payload)
    assert len(state["project"]["images"]) == 2
    assert sum(len(a) for a in state["draft"]["annotations"].values()) == 3

    new_id = state["project"]["images"][0]["id"]
    st, payload = call("GET", "/api/images/%s/raw" % new_id)
    assert st == 200 and payload[:8] == bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

    shutil.rmtree(TMP, ignore_errors=True)
    shutil.rmtree(fresh, ignore_errors=True)
    print("HTTP E2E OK: upload/dedup/draft/freeze/export/tamper/missing/remap/raw")


if __name__ == "__main__":
    main()
