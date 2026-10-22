"""Read-only DGP v8/v9 research decoder. No original files are ever written.

Loader layout: GAME.exe 0x51FCC4, ev_9abd5ba6645433c0752e35b69015a7f998c9c9b054862a5afdfadc7499e40962.
Row records: 0x5206FD, ev_6482fb38218f9adb514e906dac54cdf6c3c4a3feb48e936b7968d60150842102.
Unknown metadata is retained, not assigned invented game semantics.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import hashlib
import struct

from PIL import Image


class DGPError(ValueError):
    pass


def normalize_v8_action(raw: bytes) -> bytes:
    """GAME.exe 0x51FB00, verified from assembly (source record stays intact)."""
    if len(raw) != 0x90:
        raise DGPError('Legacy action must contain 0x90 bytes')
    out = bytearray(0xac)
    # The first fields, ten-entry sequence, then renamed string capacities.
    out[:0x20] = raw[:0x20]
    for src, dst, capacity in [(0x20,0x2a,0x14),(0x2f,0x3e,0x14),(0x42,0x56,0x14)]:
        text = raw[src:].split(b'\0',1)[0]
        if len(text) >= capacity:
            raise DGPError('Legacy action string exceeds normalized capacity')
        out[dst:dst+len(text)] = text
    for src,dst,size in [(0x3e,0x52,4),(0x56,0x6a,4),(0x5a,0x72,4),
                         (0x62,0x7a,4),(0x66,0x7e,1),(0x67,0x7f,1),
                         (0x68,0x80,4),(0x6c,0x84,3),(0x73,0x87,1),
                         (0x74,0x88,4),(0x78,0x8c,8),(0x80,0x94,4)]:
        out[dst:dst+size] = raw[src:src+size]
    return bytes(out)


class Reader:
    def __init__(self, data: bytes):
        self.data = data
        self.pos = 0

    def take(self, size: int) -> bytes:
        if size < 0 or self.pos + size > len(self.data):
            raise DGPError(f"Truncated block at 0x{self.pos:x}, need {size} bytes")
        result = self.data[self.pos:self.pos + size]
        self.pos += size
        return result

    def u32(self) -> int:
        return struct.unpack('<I', self.take(4))[0]


def u16(data: bytes, offset: int) -> int:
    return struct.unpack_from('<H', data, offset)[0]


def u32(data: bytes, offset: int) -> int:
    return struct.unpack_from('<I', data, offset)[0]


@dataclass
class Frame:
    page: int
    x: int
    y: int
    offset: int
    size: int


class DGP:
    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        self.sha256 = hashlib.sha256(self.data).hexdigest()
        r = Reader(self.data)
        self.header = r.take(0x43)
        if self.header[0] not in (8, 9):
            raise DGPError(f"Unsupported DGP version {self.header[0]}; requires v8/v9")
        # Native 0x51FCC4 reads v8's 0x90-byte actions and expands them with
        # 0x51FB00. Keep source bytes and normalize only the in-memory table.
        self.source_actions = [r.take(0xac if self.header[0] == 9 else 0x90)
                               for _ in range(self.header[2])]
        self.raw_actions = [raw if self.header[0] == 9 else normalize_v8_action(raw)
                            for raw in self.source_actions]
        self.geometry = r.take(0x2a)
        self.extra_header = r.take(0x30)
        self.width = u16(self.geometry, 0)
        self.height = u16(self.geometry, 2)
        self.frame_count = u32(self.geometry, 4)
        if not (0 < self.width <= 8192 and 0 < self.height <= 8192):
            raise DGPError(f"Invalid frame dimensions {self.width}x{self.height}")
        if not (0 < self.frame_count <= 100000):
            raise DGPError(f"Invalid frame count {self.frame_count}")
        self.raw_pages = [r.take(18) for _ in range(self.geometry[13])]
        self.frames = [Frame(*struct.unpack('<5I', r.take(20))) for _ in range(self.frame_count)]
        self.optional_blocks = []

        def keep(kind: str, size: int):
            start = r.pos
            block = r.take(size)
            self.optional_blocks.append(dict(kind=kind, offset=start, bytes=size))
            return block

        volume = [u32(self.extra_header, i) for i in (0, 4, 8)]
        if all(volume):
            keep('volume', volume[0] * volume[1] * volume[2])
        if self.header[5]:
            keep('per_frame_mask', self.width * self.height * self.frame_count)
        if self.header[6]:
            for _ in self.frames:
                keep('per_frame_records', r.u32() * 8)
        if self.geometry[41]:
            for _ in self.frames:
                keep('per_frame_blob', r.u32())
        self.indexed_auxiliary = []
        if self.header[19]:
            # 0x51FCC4 reads header[0x13]'s optional records into +0xC5,
            # then independently reads the main 16-bit rows into +0xB1.
            # The indexed records do not replace the main pixel stream.
            # Preserve them without inventing palette transparency, effects,
            # or a conversion to the main stream.
            for index, _ in enumerate(self.frames):
                record = dict(frame=index, record_offset=r.pos)
                active = r.take(1)[0]
                record['active_raw'] = active
                if active:
                    record['size_field_offset'] = r.pos
                    size = r.u32()
                    record['palette_offset'] = r.pos
                    palette = keep('palette', 0x300)
                    record['palette_sha256'] = hashlib.sha256(palette).hexdigest()
                    record['indexed_pixels_offset'] = r.pos
                    indexed = keep('indexed_pixels', size)
                    record['indexed_pixels_bytes'] = size
                    record['indexed_pixels_sha256'] = hashlib.sha256(indexed).hexdigest()
                record['end_offset'] = r.pos
                self.indexed_auxiliary.append(record)

        self.payload_start = u32(self.geometry, 32)
        self.payload_bytes = u32(self.geometry, 36)
        if r.pos != self.payload_start:
            raise DGPError(f"Payload boundary mismatch: read 0x{r.pos:x}, declared 0x{self.payload_start:x}")
        if sum(f.size for f in self.frames) != self.payload_bytes:
            raise DGPError('Frame byte counts do not equal declared payload byte count')
        expected_offset = 0
        for i, f in enumerate(self.frames):
            if f.offset != expected_offset:
                raise DGPError(f"Frame {i} payload offset mismatch: {f.offset} != {expected_offset}")
            expected_offset += f.size
        self.primary = r.take(self.payload_bytes)
        self.secondary = None
        if not self.header[21]:
            self.secondary = r.take(self.payload_bytes)
        if r.pos != len(self.data):
            raise DGPError(f"Unconsumed trailing bytes: {len(self.data) - r.pos}")
        self.actions = []
        for i, raw in enumerate(self.raw_actions):
            # 0x50E980 indexes 0xAC actions, reads the DWORD interval at +1,
            # and uses +0x72 as the physical frame base. Native +0x16
            # sequence tables / CHR ranges are separate from our atlas order.
            self.actions.append(dict(index=i, directions=max(1, raw[0]), directions_raw=raw[0], interval_raw=u32(raw, 1),
                                     loop_raw=raw[13], frames_per_direction=raw[14],
                                     first_frame=u32(raw, 0x72), identifier_raw=u32(raw, 0x7e),
                                     raw_hex=raw.hex()))
        self.anchor_raw = [u32(self.extra_header, i) for i in (16, 20, 24)]

    def rows(self, index: int, secondary: bool = False):
        frame = self.frames[index]
        source = self.secondary if secondary else self.primary
        if source is None:
            raise DGPError('No secondary pixel stream')
        r = Reader(source[frame.offset:frame.offset + frame.size])
        for y in range(self.height):
            count = u16(r.take(2), 0)
            spans = []
            if count != 0xffff:
                if count > self.width:
                    raise DGPError(f"Frame {index}, row {y}: excessive span count {count}")
                for _ in range(count):
                    skip, size = struct.unpack('<HH', r.take(4))
                    spans.append((skip, size, r.take(size * 2)))
            yield y, spans
        if r.pos != len(r.data):
            raise DGPError(f"Frame {index}: unread bytes {len(r.data) - r.pos}")

    def decode(self, index: int, span_mode: str = 'absolute') -> Image.Image:
        pixels = bytearray(self.width * self.height * 4)
        for y, spans in self.rows(index):
            cursor = 0
            for skip, size, raw in spans:
                x = skip if span_mode == 'absolute' else cursor + skip
                if x < cursor or x + size > self.width:
                    raise DGPError(f"Frame {index}, row {y}: span outside width / overlaps ({x}, {size})")
                for k, (value,) in enumerate(struct.iter_unpack('<H', raw)):
                    red = (value >> 11) & 31
                    green = (value >> 5) & 63
                    blue = value & 31
                    off = (y * self.width + x + k) * 4
                    pixels[off:off + 4] = bytes(((red << 3) | (red >> 2),
                                               (green << 2) | (green >> 4),
                                               (blue << 3) | (blue >> 2), 255))
                cursor = x + size
        return Image.frombytes('RGBA', (self.width, self.height), bytes(pixels))

    def verify_secondary(self):
        if self.secondary is None:
            return dict(present=False, checked_pixels=0)
        checked = 0
        for i in range(self.frame_count):
            for (y, rows565), (_, rows555) in zip(self.rows(i), self.rows(i, True), strict=True):
                if len(rows565) != len(rows555):
                    raise DGPError(f"Secondary frame {i}, row {y}: different row structure")
                for a, b in zip(rows565, rows555, strict=True):
                    if a[:2] != b[:2]:
                        raise DGPError(f"Secondary frame {i}, row {y}: different span structure")
                    for (v565,), (v555,) in zip(struct.iter_unpack('<H', a[2]), struct.iter_unpack('<H', b[2]), strict=True):
                        if (((v565 & 0xffe0) >> 1) & 0xffe0) | (v565 & 31) != v555:
                            raise DGPError(f"Secondary color conversion differs at frame {i}, row {y}")
                        checked += 1
        return dict(present=True, checked_pixels=checked, conversion='native 0x5206FD RGB565 to RGB555 exactly matches')

    def metadata(self):
        return dict(source=str(self.path), sha256=self.sha256, bytes=len(self.data), version=9,
                    frame_width=self.width, frame_height=self.height, frame_count=self.frame_count,
                    name_cp950=self.header[7:31].split(b'\0')[0].decode('cp950', 'replace'),
                    header_hex=self.header.hex(), geometry_hex=self.geometry.hex(),
                    extra_header_hex=self.extra_header.hex(), page_records_hex=[p.hex() for p in self.raw_pages],
                    optional_blocks=self.optional_blocks, payload_offset=self.payload_start,
                    payload_bytes=self.payload_bytes, dual_pixel_stream=self.secondary is not None,
                    indexed_auxiliary=self.indexed_auxiliary,
                    indexed_auxiliary_limit='Header[19] is a separately loaded auxiliary stream. Its effects/rendering semantics are not implemented; main 16-bit spans remain the decoded pixels.',
                    anchor_raw=self.anchor_raw, actions=self.actions,
                    frames=[vars(f) for f in self.frames], eof_verified=True)
