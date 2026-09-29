"""Read pixel dimensions from common raster formats using the stdlib only."""

from __future__ import annotations

import struct


def image_dimensions(data: bytes) -> tuple[int, int, str]:
    if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n":
        width, height = struct.unpack(">II", data[16:24])
        return width, height, "png"
    if len(data) >= 6 and data[:6] in (b"GIF87a", b"GIF89a"):
        width, height = struct.unpack("<HH", data[6:10])
        return width, height, "gif"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return _webp_dims(data)
    if len(data) >= 2 and data[:2] == b"\xff\xd8":
        return _jpeg_dims(data)
    raise ValueError("unsupported or unrecognized image format")


def _webp_dims(data: bytes) -> tuple[int, int, str]:
    pos = 12
    n = len(data)
    while pos + 8 <= n:
        chunk = data[pos:pos + 4]
        (size,) = struct.unpack("<I", data[pos + 4:pos + 8])
        body = pos + 8
        if chunk == b"VP8 " and body + 10 <= n:
            width, height = struct.unpack("<HH", data[body + 6:body + 10])
            return width & 0x3FFF, height & 0x3FFF, "webp"
        if chunk == b"VP8L" and body + 5 <= n:
            b0, b1, b2, b3 = data[body:body + 4]
            width = 1 + (((b1 & 0x3F) << 8) | b0)
            height = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6))
            return width, height, "webp"
        if chunk == b"VP8X" and body + 10 <= n:
            width = 1 + struct.unpack("<I", data[body + 4:body + 7] + b"\x00")[0]
            height = 1 + struct.unpack("<I", data[body + 7:body + 10] + b"\x00")[0]
            return width, height, "webp"
        pos = body + size + (size & 1)
    raise ValueError("truncated webp container")


def _jpeg_dims(data: bytes) -> tuple[int, int, str]:
    pos = 2
    n = len(data)
    while pos + 4 <= n:
        if data[pos] != 0xFF:
            pos += 1
            continue
        marker = data[pos + 1]
        pos += 2
        if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            continue
        if pos + 2 > n:
            break
        (seg_len,) = struct.unpack(">H", data[pos:pos + 2])
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                      0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            if pos + 7 > n:
                break
            height, width = struct.unpack(">HH", data[pos + 3:pos + 7])
            return width, height, "jpeg"
        pos += seg_len
    raise ValueError("no JPEG SOF marker found")
