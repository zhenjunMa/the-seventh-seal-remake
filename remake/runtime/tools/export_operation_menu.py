"""Read-only export of source MNU menu pixels, widgets, and CAP references.

MNU v3 is not DGP. Its embedded bitmaps use the same 16-bit row spans
already established by runtime/tools/source/dgp.py; unknown widget fields are kept.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

from PIL import Image, ImageDraw, ImageChops, ImageOps

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(ROOT / "remake/runtime/tools"))
from incremental import save_png, write_json as incremental_json, resource, recipe_hash, cached_png
from content_registration import role_ids
from source.dgp import DGP, Reader, u16

OUT = RUNTIME / 'web/assets/menu'


def u32(data, off):
    return struct.unpack_from('<I', data, off)[0]


def string(data):
    return data.split(b'\0')[0].decode('cp950', 'replace')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def decode_rows(data, width, height, rgb555=False):
    r = Reader(data)
    pixels = bytearray(width * height * 4)
    structures = []
    colors = []
    for y in range(height):
        count = u16(r.take(2), 0)
        spans = []
        cursor = 0
        if count != 0xffff:
            if count > width:
                raise ValueError('excessive row span count')
            for _ in range(count):
                x, size = struct.unpack('<HH', r.take(4))
                if x < cursor or x + size > width:
                    raise ValueError('row span overlap or bounds error')
                spans.append((x, size))
                for k, (value,) in enumerate(struct.iter_unpack('<H', r.take(size * 2))):
                    colors.append(value)
                    red = (value >> (10 if rgb555 else 11)) & 31
                    green = (value >> 5) & (31 if rgb555 else 63)
                    blue = value & 31
                    off = (y * width + x + k) * 4
                    pixels[off:off + 4] = bytes(((red << 3) | (red >> 2),
                        ((green << 3) | (green >> 2)) if rgb555 else ((green << 2) | (green >> 4)),
                        (blue << 3) | (blue >> 2), 255))
                cursor = x + size
        structures.append(spans)
    if r.pos != len(data):
        raise ValueError(f'unconsumed row payload: {len(data) - r.pos}')
    return Image.frombytes('RGBA', (width, height), bytes(pixels)), structures, colors


def parse(path, export=True):
    if not export:
        return _parse(path, export=False)
    path=Path(path)
    cap=path.with_suffix('.CAP')
    def produce():
        menu=_parse(path, export=True)
        web=RUNTIME/'web'
        outputs=[web/menu['composed'],web/menu['sensor']['image']]
        outputs.extend(web/image[key] for image in menu['images'] for key in ('image','rgb_image','alpha_image') if image[key])
        if path.stem.lower()=='game001': outputs.append(OUT/'main.png')
        return menu, outputs
    return resource(RUNTIME,'menu/'+path.stem.lower(),
        {'source':sha(path.read_bytes()),'cap':sha(cap.read_bytes()) if cap.is_file() else None},
        recipe_hash([Path(__file__)]),produce)


def _parse(path, export=True):
    data = path.read_bytes()
    if u32(data, 0) != 3 or u32(data, 4) != 1:
        raise ValueError('Only supplied MNU v3 variant is supported')
    count = u32(data, 52)
    width, height = u32(data, 78), u32(data, 82)
    if count > 256 or not (0 < width <= 2048 and 0 < height <= 2048):
        raise ValueError('invalid menu dimensions/count')
    widgets = []
    for i in range(count):
        off = 1138 + 473 * i
        raw = data[off:off + 473]
        values = list(struct.unpack_from('<13i', raw, 25))
        widgets.append(dict(index=i, source_offset=off, type_raw=raw[0],
            name=string(raw[1:25]), values_at_25_raw=values,
            draw_point_raw=dict(x=values[1],y=values[2]),
            rect=dict(left=values[4], top=values[5], right=values[6], bottom=values[7]),
            bitmap_indices_raw=values[10:13], text_raw=string(raw[185:385]),
            font_raw=string(raw[405:437]), raw_hex=raw.hex()))
    sensor_start = 1138 + 473 * count
    sensor = data[sensor_start:sensor_start + width * height]
    if len(sensor) != width * height:
        raise ValueError('truncated sensor plane')
    target = OUT / path.stem.lower()
    if export:
        target.mkdir(parents=True, exist_ok=True)
        save_png(Image.frombytes('L', (width, height), sensor), target / 'sensor.png')
    images = []
    groups = []
    cursor = sensor_start + len(sensor)
    while cursor < len(data):
        start = cursor
        header = data[cursor:cursor + 61]
        if len(header) != 61:
            raise ValueError('truncated embedded image header')
        name = string(header[:20])
        frame_count = u32(header,20)
        if not 0 < frame_count <= 1000:
            raise ValueError('invalid image group frame count')
        group = dict(index=len(groups), name=name, source_offset=start,
            frame_count=frame_count, header_hex=header.hex(), images=[],
            blend_mode_raw_24=header[0x24])
        groups.append(group)
        cursor += 61
        for frame in range(frame_count):
            frame_start = cursor
            frame_header = data[cursor:cursor+20]
            w, h, size, alpha_size = [u32(frame_header, x) for x in (0, 4, 8, 16)]
            if not (0 < w <= 2048 and 0 < h <= 2048 and alpha_size in (0, w*h)):
                raise ValueError(f'invalid embedded image {name}: {w}x{h}, alpha {alpha_size}')
            cursor += 20
            primary = data[cursor:cursor + size]
            secondary = data[cursor + size:cursor + size*2]
            image, structure, colors = decode_rows(primary, w, h)
            _, second_structure, second_colors = decode_rows(secondary, w, h, True)
            if structure != second_structure or [(((v & 0xffe0) >> 1) & 0xffe0) | (v & 31) for v in colors] != second_colors:
                raise ValueError('RGB565/555 secondary stream mismatch')
            cursor += size*2
            alpha = data[cursor:cursor + alpha_size]
            if len(alpha) != alpha_size:
                raise ValueError('truncated alpha plane')
            cursor += alpha_size
            opaque_path = target / f'image_{len(images):03d}.png'
            alpha_path = None
            rgb_path = None
            if export:
                if alpha_size:
                    rgb_path = target / f'image_{len(images):03d}_rgb.png'
                    save_png(image, rgb_path)
                    alpha_path = target / f'image_{len(images):03d}_alpha.png'
                    transparency = Image.frombytes('L', (w,h), alpha)
                    save_png(transparency, alpha_path)
                    image.putalpha(ImageChops.multiply(image.getchannel('A'),ImageOps.invert(transparency)))
                save_png(image, opaque_path)
            rec = dict(index=len(images), group=group['index'], frame=frame, name=name,
                source_offset=frame_start, width=w, height=h, stream_bytes=size, alpha_bytes=alpha_size,
                alpha_range=[min(alpha), max(alpha)] if alpha else None,
                image=opaque_path.relative_to(RUNTIME / 'web').as_posix(),
                rgb_image=rgb_path.relative_to(RUNTIME / 'web').as_posix() if rgb_path else None,
                alpha_image=alpha_path.relative_to(RUNTIME / 'web').as_posix() if alpha_path else None,
                alpha_interpretation='Inverse transparency: PNG opacity=255-raw; preserve zero opacity outside row spans' if alpha_size else 'Opaque covered row spans; uncovered pixels transparent',
                header_hex=frame_header.hex(), secondary_verified=True,
                png_sha256=sha(opaque_path.read_bytes()) if export else None)
            images.append(rec)
            group['images'].append(rec['index'])
    for widget in widgets:
        normal,active,selected = widget['bitmap_indices_raw']
        for kind,index in [('normal',normal),('active',active),('selected',selected)]:
            widget[kind+'_images'] = [images[i]['image'] for i in groups[index-1]['images']] if 0 < index <= len(groups) else []
    composed_path = target / 'composed.png'
    if export:
        composed = Image.open(RUNTIME/'web'/images[0]['image']).convert('RGBA')
        # The main screen's four buttons have separate normal bitmap groups.
        # Other pages' labels are already in their background; bars, selection
        # overlays, and animation frames remain separate dynamic source assets.
        if path.stem.lower() == 'game001':
            for widget in widgets[1:5]:
                composed.alpha_composite(Image.open(RUNTIME/'web'/widget['normal_images'][0]),
                    (widget['draw_point_raw']['x'],widget['draw_point_raw']['y']))
            composed = composed.crop((0,0,640,480))
            save_png(composed, OUT/'main.png')
        save_png(composed, composed_path)
    cap = path.with_suffix('.CAP')
    cap_refs = []
    if cap.exists():
        cap_data = cap.read_bytes()
        cap_count = u32(cap_data, 8)
        cap_start = 1166 + 473 * u32(cap_data, 80)
        if cap_start + cap_count*549 != len(cap_data):
            raise ValueError('CAP record boundary mismatch')
        for i in range(cap_count):
            raw = cap_data[cap_start+i*549:cap_start+(i+1)*549]
            cap_refs.append(dict(index=i, kind_raw=raw[0], source_path=string(raw[1:257]),
                name=string(raw[257:277]), editor_rect_raw=list(struct.unpack_from('<4i',raw,513))))
    return dict(id=path.stem.lower(), source=path.relative_to(ROOT).as_posix(),
        source_sha256=sha(data), width=width, height=height, widget_count=count,
        header_hex=data[:1138].hex(), widgets=widgets, images=images, groups=groups,
        composed=composed_path.relative_to(RUNTIME/'web').as_posix(),
        sensor=dict(source_offset=sensor_start, bytes=len(sensor), sha256=sha(sensor),
            image=(target/'sensor.png').relative_to(RUNTIME/'web').as_posix(),
            value_counts={str(v):sensor.count(v) for v in sorted(set(sensor))}),
        cap_source=cap.relative_to(ROOT).as_posix() if cap.exists() else None,
        cap_sha256=sha(cap.read_bytes()) if cap.exists() else None,
        cap_references=cap_refs, eof_verified=cursor == len(data))


def bind_item_cards(result):
    """Recover category dispatch from ITM bytes, never from item names."""
    source = ROOT/'SYSTEM/Object.ITM'
    raw_source = source.read_bytes()
    items = json.loads((RUNTIME/'web/data/items.json').read_text(encoding='utf-8'))
    header = bytes.fromhex(items['catalog']['header_raw_hex'])
    if raw_source[:len(header)] != header:
        raise ValueError('Current items.json catalog differs from source Object.ITM')
    category_count = u32(header,0x1c)
    if 0x34 + category_count*0x38 != len(header):
        raise ValueError('ITM category table boundary mismatch')
    assets = {card['id']:card for card in result['item_card_assets']}
    categories = []
    for i in range(category_count):
        offset = 0x34+i*0x38
        raw = header[offset:offset+0x38]
        path = raw[0x18:0x28].split(b'\0')[0].decode('ascii')
        resource = Path(path).stem.lower() if path else None
        if resource and resource not in assets:
            raise ValueError(f'Category names an unexported image resource: {path}')
        categories.append(dict(index=i,source_offset=offset,type=u32(raw,0),subtype=u32(raw,4),
            name=raw[8:0x18].split(b'\0')[0].decode('cp936','replace'),
            source_path=path,resource=resource,raw_hex=raw.hex()))
    result['item_card_dispatcher'] = dict(evidence_type='native-static-confirmed',
        source='SYSTEM/Object.ITM',source_sha256=sha(raw_source),
        source_category_count_offset=0x1c,source_categories_offset=0x34,source_category_bytes=0x38,
        category_pair_definition_offsets=[0x24,0x25],
        frame_definition_offset=0x20,frame_index_base=1,
        native_functions=['0x49BDF0','0x49D330','0x49D6F0'],
        native_evidence='operation_menu_native.json',categories=categories,
        behavior='Match definition bytes +0x24/+0x25 to the original category type/subtype, load its nonempty DGP path, and draw definition u32+0x20 minus one. Empty paths and unmatched types have no borrowed card image.')
    result['item_cards'] = {}
    lookup = {(c['type'],c['subtype']):c for c in categories}
    for item_id,definition in items['definitions'].items():
        raw = bytes.fromhex(definition['raw_hex'])
        kind,subtype = raw[0x24],raw[0x25]
        frame_raw = u32(raw,0x20)
        category = lookup.get((kind,subtype))
        resource = category['resource'] if category else None
        card = assets.get(resource)
        frame = frame_raw - 1
        image = card['images'][frame] if card and 0 <= frame < card['frame_count'] else None
        result['item_cards'][item_id] = dict(id=int(item_id),type=kind,subtype=subtype,
            frame_raw=frame_raw,frame_index=frame,
            category_index=category['index'] if category else None,resource=resource,image=image,
            width=card['width'] if image else None,height=card['height'] if image else None,
            no_image_reason=None if image else ('No matching source category' if not category else
                'Source category path is empty' if not resource else 'Source frame index is outside its resource'))
    for card in result['item_card_assets']:
        card['binding'] = dict(dispatcher='item_card_dispatcher',frame_index='definition u32+0x20 minus one',
            category_pairs=[[c['type'],c['subtype']] for c in categories if c['resource']==card['id']])


def export_actor_menu_resources(result):
    source = ROOT/'Fight_Role/combo/menu_role_board.dgp'
    board = DGP(source)
    target = OUT/'actor_panels'
    target.mkdir(exist_ok=True)
    board_frames = []
    for i in range(board.frame_count):
        dest = target/f'frame_{i:03}.png'
        cached_png(RUNTIME, dest, board.sha256, {'frame':i}, recipe_hash([Path(__file__),Path(__file__).parent/'source/dgp.py']), lambda: board.decode(i))
        board_frames.append(dest.relative_to(RUNTIME/'web').as_posix())
    result['actor_panel_source'] = dict(source=source.relative_to(ROOT).as_posix(),
        sha256=board.sha256,width=board.width,height=board.height,frames=board_frames,
        secondary_verification=board.verify_secondary(),
        native_functions=['0x449590','0x449960','0x55FE80'],
        binding='Source frame is native actor index. Nonzero widget state adds six; frame0/1 are clear and frame6/7 blurred as observed in the source pixels and user reference screenshots.')
    result['actor_panels'] = {}
    for role in role_ids('player'):
        index = int(role)-1
        assert index >= 0 and index+6 < len(board_frames)
        result['actor_panels'][role] = dict(normal=board_frames[index],selected=board_frames[index],
            unfocused=board_frames[index+6],width=board.width,height=board.height,
            source=source.relative_to(ROOT).as_posix(),source_frame=index,unfocused_frame=index+6,
            confidence='native-static-and-source-pixel-confirmed',
            state_alias_limit='normal/selected/unfocused are visual aliases matched to supplied screenshots. The literal native widget state is separately preserved in actor_panel_source.binding; high-level focus-to-widget-state ordering remains under verification.',
            reference='operation_menu_reference_default_20261011.png / operation_menu_reference_roster_focus_20261011.png')
    result['standing_actors'] = {}
    # Menu DGPs retain their own source120ms metadata and pixels. Runtime idle
    # speed comes from the same role definition used by BattleView, so status,
    # equipment and formation cannot drift from combat independently.
    battle_view_path = RUNTIME/'web/data/party_battle_view.json'
    battle_roles = {role['id']:role for role in json.loads(battle_view_path.read_text('utf-8'))['roles']}
    result['runtime_dependencies'] = {'data/party_battle_view.json':sha(battle_view_path.read_bytes())}
    for role in role_ids('player'):
        source = ROOT/f'Fight_Role/combo/menu_role_{role}.dgp'
        dgp = DGP(source)
        target = OUT/'standing_actors'/role
        target.mkdir(parents=True,exist_ok=True)
        frames = []
        for i in range(dgp.frame_count):
            dest = target/f'frame_{i:03}.png'
            cached_png(RUNTIME, dest, dgp.sha256, {'frame':i}, recipe_hash([Path(__file__),Path(__file__).parent/'source/dgp.py']), lambda: dgp.decode(i))
            frames.append(dest.relative_to(RUNTIME/'web').as_posix())
        action = dgp.actions[0]
        idle_interval = battle_roles[role]['idle']['interval_raw']
        if not isinstance(idle_interval,(int,float)) or idle_interval<=0:
            raise ValueError(f'Role {role} is missing a valid shared idle interval')
        first,n = action['first_frame'],action['frames_per_direction']
        result['standing_actors'][role] = dict(frames=frames[first:first+n],all_frames=frames,
            width=dgp.width,height=dgp.height,anchor=dgp.anchor_raw,
            source=source.relative_to(ROOT).as_posix(),source_sha256=dgp.sha256,
            action=0,interval_ms=idle_interval,actions=dgp.actions,
            timing_source=dict(path='data/party_battle_view.json',role_id=role,pose='idle'),
            secondary_verification=dgp.verify_secondary(),position=dict(x=387,y=340),
            image_origin=dict(x=121,y=16),position_semantics='Source anchor point, subtract anchor to obtain complete image top-left',
            native_functions=['0x45E100','0x45DDD0','0x52BEC3'],
            position_source=dict(menu='game001b_2',origin=dict(x=300,y=120),width=174,height=270,
                image_origin_formula='(menu.x+menu.width/2-anchor.x, menu.y-50+menu.height-anchor.y)'),
            confidence='native-source pixels; runtime idle interval derived from the shared battle role definition',
            limit='Menu DGP action intervals remain source metadata; runtime standing playback follows the shared role idle interval. Original menu/global phase scheduling is not claimed.')
    item_menu = next(m for m in result['menus'] if m['id']=='game003_1')
    pic = next(w for w in item_menu['widgets'] if w['name'].lower()=='pic')['rect']
    rect = [pic['left'],pic['top'],pic['right']+1,pic['bottom']+1]
    card = Image.open(RUNTIME/'web'/item_menu['images'][0]['image']).crop(rect)
    dest = OUT/'item_card_back.png'
    save_png(card, dest)
    result['item_card_back'] = dict(image=dest.relative_to(RUNTIME/'web').as_posix(),
        width=card.width,height=card.height,source=item_menu['source'],source_frame=0,
        source_rect_exclusive=rect,confidence='source-pixel-and-reference-match',
        derivation='Crop only the original MNU background at its PIC rectangle; no screenshot pixels are used.')
    source = ROOT/'SYSTEM/ObjectIcon.dgp'
    icons = DGP(source)
    target = OUT/'item_row_icons'
    target.mkdir(exist_ok=True)
    icon_frames = []
    for index in range(icons.frame_count):
        dest = target/f'frame_{index:03}.png'
        cached_png(RUNTIME, dest, icons.sha256, {'frame':index}, recipe_hash([Path(__file__),Path(__file__).parent/'source/dgp.py']), lambda: icons.decode(index))
        icon_frames.append(dest.relative_to(RUNTIME/'web').as_posix())
    result['item_row_icons'] = dict(frames=icon_frames,width=icons.width,height=icons.height,
        source=source.relative_to(ROOT).as_posix(),source_sha256=icons.sha256,
        frame_count=icons.frame_count,anchor=icons.anchor_raw,
        secondary_verification=icons.verify_secondary(),
        confidence='native-static-and-source-pixel-confirmed',
        binding=dict(definition_frame_offset=0x1c,definition_frame_type='u32',frame_index_base=0,
            selected_frame_range_inclusive=[1,21],selected_frame_offset=95,
            grey_uses_ordinary_frame=True,
            native_functions=['0x49D330','0x4589B0','0x44C890'],
            behavior='Use definition u32+0x1C as the ordinary frame. If the row is selected and its ordinary frame is 1..21, add 95. Grey rows retain the ordinary source frame. The same source bank is used for crystal/device icons.'))
    for name,index in [('ordinary',1),('active',96)]:
        dest = target/f'{name}.png'
        cached_png(RUNTIME, dest, icons.sha256, {'frame':index}, recipe_hash([Path(__file__),Path(__file__).parent/'source/dgp.py']), lambda: icons.decode(index))
        result['item_row_icons'][name] = dict(image=dest.relative_to(RUNTIME/'web').as_posix(),
            width=icons.width,height=icons.height,source=source.relative_to(ROOT).as_posix(),
            source_sha256=icons.sha256,source_frame=index,
            confidence='native-static-and-source-pixel-confirmed')
    for key,filename in [('item_target_panels','menu_choice_role.dgp'),
                         ('item_target_bars','menu_use_bar.dgp')]:
        source = ROOT/'Fight_Role/combo'/filename
        dgp = DGP(source)
        target = OUT/key
        target.mkdir(exist_ok=True)
        frames = []
        for index in range(dgp.frame_count):
            dest = target/f'frame_{index:03}.png'
            cached_png(RUNTIME, dest, dgp.sha256, {'frame':index}, recipe_hash([Path(__file__),Path(__file__).parent/'source/dgp.py']), lambda: dgp.decode(index))
            frames.append(dest.relative_to(RUNTIME/'web').as_posix())
        result[key] = dict(frames=frames,width=dgp.width,height=dgp.height,
            anchor=dgp.anchor_raw,source=source.relative_to(ROOT).as_posix(),
            source_sha256=dgp.sha256,frame_count=dgp.frame_count,
            secondary_verification=dgp.verify_secondary(),
            native_functions=['0x45E100'],confidence='native-source-and-pixel-confirmed')
    result['item_target_panels'].update(normal=result['item_target_panels']['frames'][0],
        selected=result['item_target_panels']['frames'][1],
        frame_observations=['Dark parchment target panel','Bright parchment target panel'],
        native_draw_function='0x45C530',
        native_evidence_id='ev_b1708725adc06f1b51b2eea520e25518956f8e1eaa69b617dd319ae28e6e8559',
        binding=dict(widget_state_function='0x55FE80',state_zero_frame=0,state_nonzero_frame=1,
            automatic_mode_frame=1,automatic_mode_address='0x02B90052'),
        layout=dict(coordinate_basis='relative to each target row origin',
            name=dict(x=20,y=13,font_size=20),
            hp=dict(current_x=110,maximum_x=155,y=30,bar_x=49,bar_y=47),
            mp=dict(current_x=110,maximum_x=155,y=53,bar_x=49,bar_y=70)))
    result['item_target_bars'].update(hp_frame=1,mp_frame=0,native_draw_function='0x45C530',
        length_formula='floor(147 * current / maximum)',
        maximum_source='Actor stored maximum plus linked equipment contribution',
        native_evidence_id='ev_b1708725adc06f1b51b2eea520e25518956f8e1eaa69b617dd319ae28e6e8559')


def main():
    names = ['game000', 'game001', 'game001a', 'game001a_2', 'game001a_3', 'game001b',
        'game001b_2', 'game001c', 'game001c_1', 'game001c_2', 'game001c_3',
        'game001c_4', 'game001c_a', 'game001d', 'game001e', 'game001f',
        'game001g', 'game001h', 'game002a', 'game002b', 'game002c',
        'game002_1', 'game002_1a', 'game002_1b', 'game002_1c', 'game002_1d',
        'game002_1e', 'game002_2a', 'game002_2b', 'game003a', 'game003_1',
        'game003_2', 'game003_3', 'game003_4', 'game005', 'game005a',
        'game005_1', 'game005_2']
    sources = [ROOT / 'SYSTEM' / f'{name}.mnu' for name in names]
    card_names = ['_arms','_equip','_item','_keyite','_crystal','_cmpite']
    original_inputs = sources + [p.with_suffix('.CAP') for p in sources if p.with_suffix('.CAP').exists()]
    original_inputs += [ROOT/'SYSTEM/game001a.dgp',ROOT/'GAME.exe',ROOT/'SYSTEM/Object.ITM']
    original_inputs += [ROOT/'SYSTEM'/f'{name}.dgp' for name in card_names]
    original_inputs += [ROOT/'Fight_Role/combo/menu_role_board.dgp',ROOT/'SYSTEM/ObjectIcon.dgp']
    original_inputs += [ROOT/f'Fight_Role/combo/menu_role_{role}.dgp' for role in role_ids('player')]
    original_inputs += [ROOT/'Fight_Role/combo/menu_choice_role.dgp',ROOT/'Fight_Role/combo/menu_use_bar.dgp']
    before = {str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in original_inputs}
    result = dict(version=1, evidence_type='static-resource-observation',
        native_canvas=dict(width=640,height=480), menus=[],
        limitations=['No original-game execution observed by this exporter. User reference screenshots are separate supplied observations.',
            'Source rectangles and bitmap indices are preserved; remaining event binding and exact animation ordering need native code/runtime corroboration.',
            'CAP image paths describe original editor inputs, which are not present. MNU embedded pixels supply the exported images.',
            'Original native alpha blends integer RGB565/RGB555 channels with truncation. Exported RGBA uses the confirmed 255-raw opacity, so browser 8-bit blending may differ slightly at intermediate opacity.'])
    result['mnu_alpha_rule'] = dict(evidence_type='native-static-confirmed',
        native_functions=['0x56CF40','0x51E5F0'],
        native_assembly=['0x56D622','0x56D6FC','0x56D71E','0x56D73E'],
        transparency_range=[0,255],opaque_raw=0,transparent_raw=255,
        native_channel_formula='src + trunc((dst-src)*raw_transparency/255)',
        png_opacity_formula='255-raw_transparency; zero outside row-span coverage',
        additional_mode='Exported MNU bitmap groups have serialized byte+0x24=0; fixed half-transparent/additive overrides are absent for these resources.')
    for path in sources:
        record = parse(path)
        result['menus'].append(record)
        print(f'{record["id"]}: {record["width"]}x{record["height"]}, {len(record["images"])} images, {len(record["widgets"])} widgets')
    result['page_bindings'] = dict(
        main=dict(menu='game001',image='assets/menu/main.png',origin=dict(x=0,y=0),
            origin_source='Native 0x44A140, 0x55ECF0(0,0); see operation_menu_native.json'),
        characters=dict(header='game001d',selector='game000',
            state='game001a_2',equipment='game001a',formation='game001a_3',
            weapon_details='game001c',equipment_list='game001b',equipment_details='game001b_2',
            elements='game001f',physical_rates='game001g',defense_rates='game001h',
            header_origin=dict(x=10,y=-20),selector_origin=dict(x=20,y=50),
            state_origin=dict(x=20,y=145),equipment_origin=dict(x=20,y=135),
            formation_origin=dict(x=20,y=50),equipment_list_origin=dict(x=180,y=138),
            equipment_details_origin=dict(x=300,y=120),
            origins_source='Native 0x44C120/0x449A20/0x44BE50/0x44B2A0/0x45EB90/0x43C4C0/0x45DD30; see operation_menu_native.json'),
        items=dict(header='game003a',items='game003_1',equipment='game003_2',crystals='game003_3',
            target_selector='game003_4',header_labels=['道具','防具','水晶石'],
            bottom_filter_category_pairs=[[5,1],[5,4],[5,3],[3,2],[5,2]],
            header_origin=dict(x=-2,y=-8),items_origin=dict(x=11,y=52),
            equipment_origin=dict(x=10,y=50),crystals_origin=dict(x=10,y=50),
            target_origin=dict(x=280,y=67),
            origins_source='Native 0x458680/0x459B80/0x45AE20/0x45BD30/0x45CA50; see operation_menu_native.json'),
        techniques=dict(header='game002a',use='game002_1',edit_categories='game002b',
            compose_characters='game002_2a',compose_crystals='game002_2b',
            header_origin=dict(x=-6,y=-10),use_origin=dict(x=20,y=145),
            origins_source='Native 0x44E550/0x450BE0; see operation_menu_native.json'))
    result['actor_bar'] = dict(source_menu='game001c_1',image='assets/menu/game001c_1/composed.png',
        deprecated=True,replacement='actor_panels',
        limit='The source MNU is a blurred editor template with fixed 英格妮. Runtime actor panels come from Menu_Role_Board.DGP and retain each actor name.')
    slot_dgp = DGP(ROOT/'SYSTEM/game001a.dgp')
    slot_dir = OUT/'slot_icons'
    slot_dir.mkdir(exist_ok=True)
    result['slot_icons'] = dict(source='SYSTEM/game001a.dgp',sha256=slot_dgp.sha256,
        width=slot_dgp.width,height=slot_dgp.height,frame_count=slot_dgp.frame_count,
        frames=[],labels_observed=['法器','头饰','颈饰','手饰','佩饰','宝器'],
        binding_limit='Labels are read from the decoded frame pixels; native item-slot action binding is a separate requirement.')
    for i in range(slot_dgp.frame_count):
        dest = slot_dir/f'frame_{i:03}.png'
        cached_png(RUNTIME, dest, slot_dgp.sha256, {'frame':i}, recipe_hash([Path(__file__),Path(__file__).parent/'source/dgp.py']), lambda: slot_dgp.decode(i))
        result['slot_icons']['frames'].append(dest.relative_to(RUNTIME/'web').as_posix())
    result['item_card_assets'] = []
    for name in card_names:
        source = ROOT/'SYSTEM'/f'{name}.dgp'
        dgp = DGP(source)
        card_dir = OUT/'cards'/name
        card_dir.mkdir(parents=True,exist_ok=True)
        record = dict(id=name,source=source.relative_to(ROOT).as_posix(),sha256=dgp.sha256,
            width=dgp.width,height=dgp.height,frame_count=dgp.frame_count,
            secondary_verification=dgp.verify_secondary(),images=[])
        for i in range(dgp.frame_count):
            dest = card_dir/f'frame_{i:03}.png'
            cached_png(RUNTIME, dest, dgp.sha256, {'frame':i}, recipe_hash([Path(__file__),Path(__file__).parent/'source/dgp.py']), lambda: dgp.decode(i))
            record['images'].append(dest.relative_to(RUNTIME/'web').as_posix())
        result['item_card_assets'].append(record)
        print(f'{name}: {dgp.frame_count} source item-card frames')
    bind_item_cards(result)
    export_actor_menu_resources(result)
    thumbs = []
    for menu in result['menus']:
        img = Image.open(RUNTIME/'web'/menu['composed']).convert('RGBA')
        scale = min(1,320/img.width,230/img.height)
        img = img.resize((int(img.width*scale),int(img.height*scale)))
        tile = Image.new('RGB',(340,255),'#181818')
        tile.paste(img,(10,22),img)
        ImageDraw.Draw(tile).text((10,4),menu['id'],fill='white')
        thumbs.append(tile)
    sheet = Image.new('RGB',(1700,((len(thumbs)+4)//5)*255))
    for i,tile in enumerate(thumbs):
        sheet.paste(tile,((i%5)*340,(i//5)*255))
    save_png(sheet, RUNTIME/'evidence/operation_menu_contact_sheet.png')
    after = {str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in original_inputs}
    result['original_inputs_unchanged'] = before == after
    dest = RUNTIME / 'web/data/operation_menu.json'
    incremental_json(dest, result)
    output_hashes = {path.relative_to(ROOT).as_posix():sha(path.read_bytes())
        for path in sorted(OUT.rglob('*')) if path.is_file()}
    output_hashes[dest.relative_to(ROOT).as_posix()] = sha(dest.read_bytes())
    evidence = RUNTIME / 'evidence/operation_menu_resources.json'
    incremental_json(evidence, dict(passed=before == after, source_hashes=before,
        output_hashes=output_hashes,
        menus=len(result['menus']), images=sum(len(m['images']) for m in result['menus']),
        item_card_frames=sum(c['frame_count'] for c in result['item_card_assets']),
        item_card_bindings=sum(bool(c['image']) for c in result['item_cards'].values()),
        actor_panel_frames=len(result['actor_panel_source']['frames']),
        standing_actor_frames=sum(len(c['all_frames']) for c in result['standing_actors'].values()),
        runtime_dependencies=result['runtime_dependencies'],
        item_row_icon_frames=result['item_row_icons']['frame_count'],
        item_target_panel_frames=result['item_target_panels']['frame_count'],
        item_target_bar_frames=result['item_target_bars']['frame_count'],
        mnu_bitmap_groups=sum(len(m['groups']) for m in result['menus']),
        mnu_blend_modes=sorted({g['blend_mode_raw_24'] for m in result['menus'] for g in m['groups']}),
        eof_verified=all(m['eof_verified'] for m in result['menus']),
        limits=result['limitations']))
    return 0 if before == after else 1


if __name__ == '__main__':
    sys.exit(main())
