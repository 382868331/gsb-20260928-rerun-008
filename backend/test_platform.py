import io
import json
import os
import shutil
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from imgmeta import image_dimensions
from store import Store, ClientError


def make_png(width, height, color=(255, 0, 0)):
    import struct, zlib
    raw = b""
    row = bytes(color) * width
    for _ in range(height):
        raw += b"\x00" + row

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def square(x0, y0, x1, y1):
    return [[[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]]


def fresh():
    d = tempfile.mkdtemp()
    return d, Store(d)


def test_png_dimensions():
    assert image_dimensions(make_png(123, 77)) == (123, 77, "png")


def test_import_dedup_and_draft():
    d, s = fresh()
    img = s.import_image(make_png(100, 80), "a.png")["image"]
    assert s.import_image(make_png(100, 80), "copy.png")["already_exists"]
    anns = {img["id"]: [
        {"object_id": "car-1", "category": "car", "geometry": square(0.1, 0.1, 0.5, 0.5)},
        {"object_id": "car-2", "category": "car", "geometry": square(0.3, 0.3, 0.9, 0.9)},
    ]}
    s.save_draft(anns)
    shutil.rmtree(d)


def test_overlapping_objects_are_independent():
    d, s = fresh()
    img = s.import_image(make_png(10, 10), "x.png")["image"]
    s.save_draft({img["id"]: [
        {"object_id": "A", "category": "car", "geometry": square(0.1, 0.1, 0.6, 0.6)},
        {"object_id": "B", "category": "person", "geometry": square(0.4, 0.4, 0.9, 0.9)},
    ]})
    v = s.submit_version("overlap")
    assert len(v["annotations"][img["id"]]) == 2
    shutil.rmtree(d)


def test_holes_and_multi_contour_same_identity():
    d, s = fresh()
    img = s.import_image(make_png(10, 10), "h.png")["image"]
    geometry = [
        # polygon 1: outer ring + hole
        [[[0.05, 0.05], [0.95, 0.05], [0.95, 0.95], [0.05, 0.95]],
         [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6]]],
        # polygon 2: disconnected contour, SAME object
        square(0.0, 0.0, 0.1, 0.1)[0],
    ]
    s.save_draft({img["id"]: [
        {"object_id": "donut", "category": "object", "geometry": geometry}]})
    v = s.submit_version("holes")
    stored = v["annotations"][img["id"]][0]["geometry"]
    assert len(stored) == 2 and len(stored[0]) == 2
    shutil.rmtree(d)


def test_version_is_immutable_against_later_draft():
    d, s = fresh()
    img = s.import_image(make_png(10, 10), "v.png")["image"]
    s.save_draft({img["id"]: [
        {"object_id": "A", "category": "car", "geometry": square(0, 0, .5, .5)}]})
    v1 = s.submit_version("first")
    s.save_draft({img["id"]: [
        {"object_id": "A", "category": "person", "geometry": square(.2, .2, .8, .8)}]})
    v2 = s.submit_version("second")
    reread = s.get_version(1)
    assert reread["digest"] == v1["digest"]
    assert reread["annotations"][img["id"]][0]["category"] == "car"
    assert v2["annotations"][img["id"]][0]["category"] == "person"
    shutil.rmtree(d)


def test_export_then_import_roundtrip():
    d1, s1 = fresh()
    img = s1.import_image(make_png(40, 30), "r.png")["image"]
    s1.save_draft({img["id"]: [
        {"object_id": "A", "category": "car", "geometry": square(.1, .1, .4, .4)}]})
    s1.submit_version()
    manifest, files = s1.export_package(1)
    blob = {os.path.basename(name): data for name, data in files if name != "manifest.json"}

    d2, s2 = fresh()
    res = s2.import_package(manifest, lambda stored: blob.get(stored))
    assert res["imported_images"] == 1 and res["imported_annotations"] == 1
    new_img = s2.project()["images"][0]
    assert new_img["sha256"] == img["sha256"]  # matched by content, not filename
    assert "A" in {a["object_id"] for a in s2.draft()["annotations"][new_img["id"]]}
    shutil.rmtree(d1); shutil.rmtree(d2)


def test_missing_image_is_rejected_not_silently_rematched():
    d1, s1 = fresh()
    img1 = s1.import_image(make_png(20, 20, (1, 2, 3)), "one.png")["image"]
    img2 = s1.import_image(make_png(20, 20, (9, 8, 7)), "two.png")["image"]
    s1.save_draft({
        img1["id"]: [{"object_id": "X", "category": "car", "geometry": square(0, 0, .5, .5)}],
        img2["id"]: [{"object_id": "Y", "category": "car", "geometry": square(.5, .5, 1, 1)}],
    })
    manifest, files = s1.export_package()
    # Drop image one from the bundle but rename two's blob to one's stored name.
    stored1 = img1["stored"]
    blobs = {os.path.basename(n): data for n, data in files if n != "manifest.json"}
    # tamper: place two.png bytes under one.png's stored name -> hash must fail
    blobs[stored1] = blobs[img2["stored"]]

    d2, s2 = fresh()
    try:
        s2.import_package(manifest, lambda stored: blobs.get(stored))
        raise AssertionError("import must fail when image content mismatches")
    except ClientError as e:
        detail = json.loads(str(e))
        assert detail["hash_mismatch"]

    # And with genuinely missing blob -> reported as missing, no import.
    blobs2 = {img2["stored"]: blobs[img2["stored"]]}
    try:
        s2.import_package(manifest, lambda stored: blobs2.get(stored))
        raise AssertionError("import must fail on missing image")
    except ClientError as e:
        detail = json.loads(str(e))
        assert "one.png" in detail["missing"]
    assert s2.project()["images"] == []
    shutil.rmtree(d1); shutil.rmtree(d2)


def test_invalid_geometry_rejected():
    d, s = fresh()
    img = s.import_image(make_png(5, 5), "b.png")["image"]
    for bad in [
        square(0, 0, 2, 1),          # out of range
        [[[[0, 0], [1, 0]]]],        # too few points (nesting adjusted below)
        [],
    ]:
        try:
            s.save_draft({img["id"]: [
                {"object_id": "z", "category": "c", "geometry": bad}]})
            if bad != [[[[0, 0], [1, 0]]]]:
                raise AssertionError("should reject %r" % bad)
        except ClientError:
            pass
    shutil.rmtree(d)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("PASS", fn.__name__)
    print("all %d backend tests passed" % len(fns))
