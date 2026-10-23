"""Established subset of v6 Map DAT: header + background cell references.

0x4A5F00 (loader): ev_86fb8504826b15ccbea2b3911eaa302ef3f5cbeba7d1b233df62109a9ff38681
0x4A3770 (background drawing): ev_2f7d67b0c8598838be7ac99150b959c5012222fdac93464caaf6732031f0b6e7
Remaining cell fields and trailing object/event sections are not interpreted.
"""
from pathlib import Path
import hashlib
import struct

from PIL import Image
from .dgp import DGP, DGPError, u32


class MapBackground:
    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        b = self.data
        if len(b) < 0x172 or u32(b, 0x14) != 6:
            raise DGPError('Only the established v6 DAT header is supported')
        self.width = u32(b, 0x146)
        self.height = u32(b, 0x14a)
        self.step = 1 << b[0x145]
        if not self.width or not self.height or not b[0x88]:
            raise DGPError('Only explicit dimensions and the rectangular background branch are supported')
        if self.step != 2 or self.width % 2 or self.height % 2:
            raise DGPError('This experiment supports the confirmed 2-cell / 32-pixel background stride')
        end = 0x172 + self.width * self.height * 64
        if end > len(b):
            raise DGPError('Truncated map cell table')
        self.grid_end = end
        self.cells = [struct.unpack_from('<ii', b, 0x172 + i * 64)
                      for i in range(self.width * self.height)]
        self.background_name = b[0x9a:0x13a].split(b'\0')[0].decode('ascii', 'strict')
        # Filename starts at 0x9a on this version; it is not inferred from the map name.
        if not self.background_name.lower().endswith('.dgp'):
            raise DGPError(f'Invalid background filename {self.background_name!r}')

    def compose(self, dgp: DGP):
        if dgp.width != 32 or dgp.height != 32:
            raise DGPError('Background frame size differs from the confirmed native draw stride')
        image = Image.new('RGBA', (self.width * 16, self.height * 16))
        decoded = {}
        used = set()
        empty = 0
        for y in range(0, self.height, self.step):
            for x in range(0, self.width, self.step):
                frame, resource = self.cells[y * self.width + x]
                if frame == 999999:
                    empty += 1
                    continue
                if resource != 0:
                    raise DGPError(f'Background references additional DGP resource {resource}, not yet supplied')
                if not 0 <= frame < dgp.frame_count:
                    raise DGPError(f'Invalid background frame {frame} at cell {x},{y}')
                if frame not in decoded:
                    decoded[frame] = dgp.decode(frame)
                image.paste(decoded[frame], (x * 16, y * 16))
                used.add(frame)
        return image, dict(referenced_frames=len(used), empty_blocks=empty,
                           columns=self.width // 2, rows=self.height // 2,
                           assembly='DAT even-cell index -> DGP frame; 0x4A3770 rectangular branch')

    def metadata(self):
        return dict(source=str(self.path), sha256=hashlib.sha256(self.data).hexdigest(),
                    bytes=len(self.data), version=6, grid_width=self.width, grid_height=self.height,
                    pixel_width=self.width * 16, pixel_height=self.height * 16,
                    background_name=self.background_name, header_hex=self.data[:0x172].hex(),
                    background_grid_end=self.grid_end, uninterpreted_tail_bytes=len(self.data) - self.grid_end,
                    scope='header and first two DWORDs of each cell only; not collision/events/objects')
