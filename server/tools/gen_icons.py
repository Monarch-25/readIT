#!/usr/bin/env python3
"""Generate simple PNG icons for the extension (no PIL dependency).

Creates a dark rounded square with an open-book glyph in warm amber,
at 16/32/48/128 px. Pure-python PNG writer (RGBA, zlib).
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parents[2] / "extension" / "icons"
BG = (31, 36, 48, 255)       # #1f2430
BG_EDGE = (24, 28, 38, 255)
INK = (255, 181, 69, 255)     # amber accent
INK_DIM = (245, 166, 35, 255)
PAPER = (232, 236, 245, 255)


def write_png(path: Path, size: int, pixels):
    """pixels: list of rows, each row list of (r,g,b,a)."""
    raw = b"".join(
        b"\x00" + b"".join(bytes(px) for px in row) for row in pixels
    )

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    blob = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(blob)


def render(size: int):
    r = max(2, size // 8)  # corner radius
    px = [[BG_EDGE for _ in range(size)] for _ in range(size)]

    # Rounded-rect background (approximate AA on the border only).
    for y in range(size):
        for x in range(size):
            cx = min(x, size - 1 - x)
            cy = min(y, size - 1 - y)
            if cx < r and cy < r:
                dx, dy = r - cx - 0.5, r - cy - 0.5
                if dx * dx + dy * dy > (r + 0.5) ** 2:
                    continue
                if dx * dx + dy * dy > (r - 0.5) ** 2:
                    px[y][x] = BG
                else:
                    px[y][x] = BG
            else:
                px[y][x] = BG

    # Open book: two page shapes meeting at a spine.
    m = max(2, size // 6)          # margin
    spine_y0 = int(size * 0.30)
    spine_y1 = size - m - max(1, size // 10)
    mid = size // 2
    page_gap = max(1, size // 24)

    # fill page rectangles with a slight perspective (top edge inset)
    for y in range(size):
        for x in range(size):
            if spine_y0 <= y <= spine_y1:
                # left page
                left_outer = m + (size // 16) * (1 if (y - spine_y0) > (spine_y1 - spine_y0) // 2 else 0)
                left_inner = mid - page_gap
                right_inner = mid + page_gap
                right_outer = size - m - (size // 16) * (1 if (y - spine_y0) > (spine_y1 - spine_y0) // 2 else 0)
                # top of pages narrower (perspective)
                t = (y - spine_y0) / max(1, (spine_y1 - spine_y0))
                inset = int((1 - t) * (size // 10))
                if left_outer + inset <= x <= left_inner:
                    px[y][x] = PAPER if (y - spine_y0) % max(2, size // 10) else INK
                elif right_inner <= x <= right_outer - inset:
                    px[y][x] = PAPER if (y - spine_y0) % max(2, size // 10) else INK

    # spine on top
    for y in range(spine_y0, spine_y1 + 1):
        for x in range(mid - max(1, size // 40), mid + max(1, size // 40) + 1):
            if 0 <= x < size:
                px[y][x] = INK

    # amber bookmark ribbon
    rib_x = mid + max(1, size // 8)
    rib_y1 = min(size - m // 2 - 1, spine_y1 + max(1, size // 12))
    rib_y0 = int(size * 0.18)
    for y in range(rib_y0, rib_y1 + 1):
        w = max(1, size // 14)
        for x in range(rib_x - w, rib_x + w + 1):
            if 0 <= x < size:
                px[y][x] = INK
    # ribbon notch
    notch_y = rib_y1
    w = max(1, size // 14)
    for i in range(w):
        for x in range(rib_x - w + i, rib_x + w - i + 1):
            if 0 <= x < size:
                px[notch_y - i][x] = BG if notch_y - i >= 0 else BG

    return px


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = OUT / f"icon{size}.png"
        write_png(path, size, render(size))
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()