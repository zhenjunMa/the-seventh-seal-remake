"""Read-only, bounded v6 DAT object-table probe.

The table boundary, initialized footprint, and image placement are established
by saved native evidence. Initial frames are read from the DAT. Animation state
and role-layer initialization are not yet reconstructed.
"""
from __future__ import annotations

from pathlib import Path
import hashlib
import json
import re
import struct


LOADER_EVIDENCE = 'ev_86fb8504826b15ccbea2b3911eaa302ef3f5cbeba7d1b233df62109a9ff38681'
OCCUPANCY_EVIDENCE = 'ev_6093394ea87d8eb856eef46d19eabdaf9e4735e58a8a18243c3aa798fda1feb5'
PROJECTION_EVIDENCE = 'ev_c0c0aa49cfd0507760600c7f4f475d3912f8210c498f1896a6fb058f80960b5b'
OBJECT_READ_EVIDENCE = 'ev_05dce0e80a25427e4e72280265291973d42f600238f7f832c0320114fed82fb7'
OBJECT_INIT_EVIDENCE = 'ev_70e72b030eca65a4073731754bc443a383f4b215be5da103ed824b0c1a97727a'
OBJECT_DRAW_EVIDENCE = 'ev_02ca024fc6f9093e9bd38f06052ee2a4f2b2671240c4df2293cf1a50c4e2ae02'
OBJECT_RESOURCE_EVIDENCE = 'ev_813d397c0060f8bec0ba044eadc20f12cfb9fd8a36a56b19620629114d4ec9a7'
DEPTH_COMPARE_EVIDENCE = 'ev_f32a0609558d1fb49c46e1a996c57b11aa62f681842c5ee0f86256aa7b74ffbe'
DEPTH_FIELDS_EVIDENCE = 'ev_0781814eee25b61ac8bbd2b2ede6999858f4f7041d5b908f25c58d7a7691a89d'
DGP_LOADER_EVIDENCE = 'ev_9abd5ba6645433c0752e35b69015a7f998c9c9b054862a5afdfadc7499e40962'


def u32(data: bytes, offset: int) -> int:
    return struct.unpack_from('<I', data, offset)[0]


def i32(data: bytes, offset: int) -> int:
    return struct.unpack_from('<i', data, offset)[0]


class MapObjectError(ValueError):
    pass


class MapObjects:
    """Confirmed DAT table boundaries plus raw object fields, no game execution."""
    RECORD_BYTES = 0x112

    def __init__(self, path: Path):
        self.path = Path(path)
        self.data = self.path.read_bytes()
        b = self.data
        if len(b) < 0x172 or u32(b, 0x14) != 6:
            raise MapObjectError('Only v6 DAT is established')
        if not b[0x88]:
            raise MapObjectError('This object footprint probe supports the rectangular branch only')
        self.scale = b[0x145]
        self.coordinate_shift = b[0x142] or 3  # Native loader replaces zero with 3.
        if self.scale > 5 or self.coordinate_shift > 16:
            raise MapObjectError('Unexpected scale/coordinate shift')
        self.width = u32(b, 0x146) or (b[0x80] * 40 << self.scale)
        self.height = u32(b, 0x14a) or (b[0x81] * 40 << self.scale)
        if not 0 < self.width * self.height <= 4_000_000:
            raise MapObjectError('Invalid map dimensions')
        self.grid_end = 0x172 + self.width * self.height * 0x40
        if self.grid_end > len(b):
            raise MapObjectError('Truncated map cells')

        # 0x4A5F00 reads these four fixed tables before calling 0x422470.
        self.compatibility_variant = u32(b, 0x18)
        sizes = [0x2a, 0x42 if self.compatibility_variant == 1 else 0x2b, 0x1b, 0x110]
        self.fixed_sections = []
        start = self.grid_end
        for size in sizes:
            self.fixed_sections.append(dict(offset=start, count=32, record_bytes=size, bytes=32 * size))
            start += 32 * size
        self.object_start = start
        self.object_count = u32(b, 0x82)
        self.resource_base_raw = b[0x14e:0x16e].split(b'\0')[0].decode('ascii', 'strict')
        self.object_end = start + self.object_count * self.RECORD_BYTES
        if self.object_end > len(b):
            raise MapObjectError('Truncated object table')

        self.objects = []
        self.occupancy = [0] * (self.width * self.height)
        self.graphics = None
        self.initialized_occupancy = None
        for index in range(self.object_count):
            offset = start + index * self.RECORD_BYTES
            raw = b[offset:offset + self.RECORD_BYTES]
            x, y, width, height = struct.unpack_from('<4i', raw, 0x26)
            # These legacy absolute paths are ignored for ordinary resources
            # by 0x421E80; retain them solely as original metadata.
            prefix = raw[:0x1e].split(b'\0')[0]
            matches = re.findall(rb'([^\\/:\x00]+\.dgp)', prefix, re.I)
            filename = matches[-1].decode('ascii') if matches else None
            cell_x = x >> self.coordinate_shift
            cell_y = y >> self.coordinate_shift
            item = dict(index=index, offset=offset, record_bytes=self.RECORD_BYTES,
                        path_prefix_raw=prefix.decode('cp950', 'replace'),
                        resource_filename_observed=filename, resource_identifier_raw=i32(raw, 0x1e),
                        library_raw=raw[0xb3],
                        x_native=x, y_native=y, width_cells=width, height_cells=height,
                        cell_x=cell_x, cell_y=cell_y, kind_raw=raw[0xce],
                        occupancy_override_raw=raw[0x109], initial_frame_raw=i32(raw, 0x3c),
                        drawing_effect_raw=raw[0xe2], raw_hex=raw.hex())
            self.objects.append(item)
            if raw[0xce] < 4:
                # Rectangular branch of 0x4A18F0. This occupies logical cells;
                # it does not mean the object's complete visual bounds block.
                for yy in range(max(0, cell_y), min(self.height, cell_y + height)):
                    for xx in range(max(0, cell_x), min(self.width, cell_x + width)):
                        k = yy * self.width + xx
                        if not self.occupancy[k] or raw[0x109]:
                            self.occupancy[k] = index + 1

    def resource_relative_base(self):
        """The native header's ordinary-resource directory, never the map slug."""
        raw = self.resource_base_raw.replace('\\', '/')
        match = re.fullmatch(r'(?:\./)?mapm/([A-Za-z0-9_-]+)/?', raw, re.IGNORECASE)
        if not match:
            raise MapObjectError(f'Object resource base is not a confined native Mapm directory: {self.resource_base_raw!r}')
        return 'mapm/' + match[1].lower()

    def resource_source(self, identifier):
        if type(identifier) is not int or identifier <= 0 or identifier > 0x7fffffff:
            raise MapObjectError('Only positive native ordinary resource identifiers are prepared')
        return f'{self.resource_relative_base()}/{identifier:03d}.dgp'

    def resource_paths(self, root):
        """Resolve only referenced native basenames under the DAT header base.

        Both the Mapm root and each final file stay inside the supplied game
        root, including when a directory or file is a symbolic link.
        """
        if not self.objects:
            return {}
        root = Path(root).resolve()
        directory = root.joinpath(*self.resource_relative_base().split('/')).resolve()
        mapm = (root / 'mapm').resolve()
        if not mapm.is_relative_to(root) or not directory.is_relative_to(mapm):
            raise MapObjectError('Object resource directory escapes the local Mapm root')
        result = {}
        for item in self.objects:
            if item['library_raw']:
                raise MapObjectError('Only ordinary map resource libraries are prepared')
            filename = Path(self.resource_source(item['resource_identifier_raw'])).name
            path = directory / filename
            if not path.is_file() and directory.is_dir():
                # Native Windows lookup is case insensitive; still require the
                # exact basename in the one source-declared directory.
                matches = [candidate for candidate in directory.iterdir()
                           if candidate.name.lower() == filename and candidate.is_file()]
                if len(matches) == 1:
                    path = matches[0]
            path = path.resolve()
            if not path.is_relative_to(directory) or not path.is_relative_to(mapm):
                raise MapObjectError('Object resource file escapes the native Mapm directory')
            if not path.is_file():
                raise MapObjectError(f'Missing exact native object resource: {self.resource_source(item["resource_identifier_raw"])}')
            result[filename] = path
        return result

    def prepare_graphics(self, resources):
        """Bind exact observed resource basenames to supplied, parsed DGPs.

        Returns established initial placement and frame metadata. The caller
        supplies the correct map's resources; this does not follow obsolete
        developer-machine absolute paths stored in the DAT. Layer and depth
        fields follow the confirmed rectangular queue branch.
        """
        lookup = {name.lower(): value for name, value in resources.items()}
        if self.coordinate_shift != 3 or self.scale != 1 or self.data[0x143] != 0:
            raise MapObjectError('Only the confirmed M01010 native-to-pixel scale is prepared')
        if self.data[0x89]:
            raise MapObjectError('Special map object blending branch is not supported')
        result = []
        occupancy = [0] * (self.width * self.height)
        for item in self.objects:
            if item['library_raw'] or item['resource_identifier_raw'] <= 0:
                raise MapObjectError('Only nonzero ordinary map resource identifiers are prepared')
            # 0x421E80 formats identifier<10 with "00%d.DGP", <100 with
            # "0%d.DGP", otherwise "%d.DGP", under header+0x14E base path.
            filename = f'{item["resource_identifier_raw"]:03d}.DGP'
            if filename.lower() not in lookup:
                raise MapObjectError(f'Missing exact observed object resource: {filename!r}')
            dgp = lookup[filename.lower()]
            raw = bytes.fromhex(item['raw_hex'])
            if item['kind_raw'] >= 4 or item['drawing_effect_raw']:
                raise MapObjectError('Only ordinary kind<4 initial object drawing is established')
            frame = item['initial_frame_raw']
            if not 0 <= frame < dgp.frame_count:
                raise MapObjectError(f'Object {item["index"]}: initial frame outside DGP')
            # Native init (0x422660) overwrites footprint with DGP +0x75/+0x79.
            width, height = u32(dgp.extra_header, 4), u32(dgp.extra_header, 8)
            if not 0 < width <= self.width or not 0 < height <= self.height:
                raise MapObjectError('Invalid DGP object footprint')
            # (raw << (coord_shift+2)) >>5 is identity for this confirmed sample.
            x_native, y_native = item['x_native'], item['y_native']
            x_world, y_world = x_native * 2, y_native * 2
            # Runtime DGP +0x81/+0x85 == file extra-header +0x10/+0x14.
            anchor_x, anchor_y = i32(dgp.extra_header, 16), i32(dgp.extra_header, 20)
            item_graphic = dict(index=item['index'], resource_filename=filename,
                                source=self.resource_source(item['resource_identifier_raw']),
                                resource_sha256=dgp.sha256, initial_frame=frame, frame=frame,
                                x_native=x_native, y_native=y_native,
                                x_world=x_world, y_world=y_world,
                                anchor_x=anchor_x, anchor_y=anchor_y,
                                draw_x=x_world-anchor_x, draw_y=y_world-anchor_y,
                                frame_width=dgp.width, frame_height=dgp.height,
                                width_cells=width, height_cells=height,
                                cell_x=x_native >> 3, cell_y=y_native >> 3,
                                kind_raw=item['kind_raw'], layer=item['kind_raw'],
                                sort_x=x_world+(width-height)*32,
                                sort_y=y_world+(width+height)*16,
                                depth_rule='0x4AA110 rectangular branch; stable (layer, sort_y) ascending')
            result.append(item_graphic)
            for yy in range(max(0, item_graphic['cell_y']), min(self.height, item_graphic['cell_y'] + height)):
                for xx in range(max(0, item_graphic['cell_x']), min(self.width, item_graphic['cell_x'] + width)):
                    k = yy * self.width + xx
                    if not occupancy[k] or raw[0x109]:
                        occupancy[k] = item['index'] + 1
        self.graphics = result
        self.initialized_occupancy = occupancy
        return result

    def metadata(self):
        return dict(source=str(self.path), sha256=hashlib.sha256(self.data).hexdigest(),
                    source_bytes=len(self.data), version=6, grid_width=self.width,
                    grid_height=self.height, coordinate_shift=self.coordinate_shift,
                    scale=self.scale, grid_end=self.grid_end,
                    compatibility_variant=self.compatibility_variant,
                    object_resource_base_raw=self.resource_base_raw,
                    fixed_sections=self.fixed_sections,
                    object_start=self.object_start, object_end=self.object_end,
                    object_count=self.object_count, object_record_bytes=self.RECORD_BYTES,
                    occupied_cells=sum(bool(x) for x in self.occupancy), objects=self.objects,
                    graphics_prepared=self.graphics is not None, graphics=self.graphics,
                    initialized_occupied_cells=(sum(bool(x) for x in self.initialized_occupancy)
                                                if self.initialized_occupancy is not None else None),
                    unexplained_tail_bytes=len(self.data) - self.object_end,
                    authority='local resource bytes + retained native static evidence',
                    evidence=[LOADER_EVIDENCE, OCCUPANCY_EVIDENCE, PROJECTION_EVIDENCE,
                              OBJECT_READ_EVIDENCE, OBJECT_INIT_EVIDENCE, OBJECT_DRAW_EVIDENCE,
                              OBJECT_RESOURCE_EVIDENCE, DEPTH_COMPARE_EVIDENCE,
                              DEPTH_FIELDS_EVIDENCE, DGP_LOADER_EVIDENCE],
                    scope='table bounds; initialized footprint; native anchor-based initial placement if supplied DGPs',
                    depth_sort='layer ascending, then sort_y ascending, with stable ties (0x4AE100)',
                    role_layer_status='Role record+0xF3 supplies layer; initialization/value not verified',
                    unknowns=['Role record+0xF3 initialization/value; equal-key insertion order across roles and objects',
                              'Object animation advancement and runtime/script state',
                              'Post-object DAT remainder is not explained'])


if __name__ == '__main__':
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from .dgp import DGP
    project = Path(__file__).resolve().parents[2]
    root = project.parents[1]
    objects = MapObjects(root / 'Map/m01010.dat')
    objects.prepare_graphics({path.name: DGP(path) for path in (root / 'mapm/m01010').glob('*.dgp')})
    result = objects.metadata()
    result['source'] = 'Map/m01010.dat'
    out = project / 'evidence/source/map_layers_probe.json'
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k: result[k] for k in ['object_start', 'object_end', 'object_count',
                                           'occupied_cells', 'unexplained_tail_bytes']}, ensure_ascii=False))
