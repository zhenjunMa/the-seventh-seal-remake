"""Read-only battle MNU/DGP pixel export with source geometry and bounds.

This does not observe original execution. Widget positions remain relative to
their menu until the native caller's placement has separately been recovered.
"""
from pathlib import Path
import json
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(ROOT / "remake/runtime/tools"))
from PIL import Image, ImageDraw, ImageChops, ImageOps
from source.dgp import DGP
from export_combat_presentation import indexed_contribution, native_frame_sequence
from export_operation_menu import decode_rows, sha, string, u32

WEB = RUNTIME / 'web'
OUT = WEB / 'assets/battle_ui'
NATIVE_RECORDS = {
    'party_native.json': [
        'ev_64964521f140b6b84a9d1cee76e4a1cce4e75a30e5d44c3a2d9ca0e73794fe73',
        'ev_9ffabf0d5428d17a3310f53d4e5a631e452c5439361f5f3aaada9cd4150292cc',
        'ev_d55c840cd25503629d7ddbfc171d1da8ae0ad9adad902ea4cf16a762c3be01ae',
        'ev_ac93054f796bab1718652b21135c20942ff613bbd7d425bdbf1b1897f4f265a1',
        'ev_37c85bf027ebd1e64d8f74b3b5754c20408a1bef1a1519c343d0d636ed01dc9b',
        'ev_5fa683e3644f349e84d776330e7229183892923d8f71d8b18308d147a92ec0cd',
        'ev_054ea9df277519594095db21278d4fb49e87efadf8c197a952921b9c277ffe38',
        'ev_a40be7ba4dd6dea79df4e4272a0283350f97d1c78de8c29545a93fc279a5c7f6',
        'ev_e8c682f007b176eb7b5375df3c241435778308acf063beab53071675397a406c'],
    'operation_menu_native.json': [
        'ev_99f6ed2c5f47d193aa31bcf957f18c4fa2c98b8f423c338fe4ba5f6225792da4',
        'ev_5d20e858d57da5884c138203f623e7a5a9a398d54964d62b64db80e6414d7b4f']}


def pe_data(va, count):
    """Read an explicit virtual address from the supplied PE, without execution."""
    b = (ROOT/'GAME.exe').read_bytes()
    pe = u32(b,60)
    sections = struct.unpack_from('<H',b,pe+6)[0]
    optional = pe+24
    imagebase = u32(b,optional+28)
    table = optional+struct.unpack_from('<H',b,pe+20)[0]
    rva = va-imagebase
    for i in range(sections):
        p = table+40*i
        virtual_size,virtual_rva,raw_size,raw_offset = struct.unpack_from('<4I',b,p+8)
        if virtual_rva <= rva and rva+count <= virtual_rva+raw_size:
            off = raw_offset+rva-virtual_rva
            return dict(source='GAME.exe',source_sha256=sha(b),virtual_address=hex(va),
                file_offset=off,bytes=count,raw_hex=b[off:off+count].hex())
    raise ValueError('Explicit PE data range is not backed by source bytes')


def retain_native():
    records, sources = [], []
    game_hash = sha((ROOT/'GAME.exe').read_bytes())
    for name, identifiers in NATIVE_RECORDS.items():
        p = RUNTIME/'evidence'/name
        bundle = json.loads(p.read_text('utf-8'))
        artifact_hashes = {a.get('digest',{}).get('sha256') for a in bundle.get('artifacts',[])}
        if game_hash not in artifact_hashes:
            raise ValueError('Retained native evidence is bound to another executable')
        lookup = {r['evidence_id']:r for r in bundle['records']}
        for ident in identifiers:
            if ident not in lookup:
                raise ValueError('Required retained native record missing')
            records.append(dict(retained_from=name,record=lookup[ident]))
        sources.append(dict(path=p.relative_to(RUNTIME).as_posix(),sha256=sha(p.read_bytes()),evidence_ids=identifiers))
    out = RUNTIME/'evidence/battle_ui_native_retained.json'
    out.write_text(json.dumps(dict(evidence_type='historical-native-static-retained',
        original_game_execution_observed=False,rea_analysis_rerun_this_export=False,
        game_sha256=game_hash,sources=sources,records=records,
        limits=['Records are copied verbatim from existing static REA evidence, not newly decompiled or runtime observed.',
            'Some historical query parameters are interior addresses; normalized_result function names identify the recovered entry.']),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return out


def bindings(result):
    hud_evidence = NATIVE_RECORDS['party_native.json'][1]
    wheel_evidence = NATIVE_RECORDS['operation_menu_native.json'][0]
    icon_evidence = NATIVE_RECORDS['party_native.json'][6]
    stat_table = pe_data(0x673e18,32)
    xy = struct.unpack('<8i',bytes.fromhex(stat_table['raw_hex']))
    ready_cap = pe_data(0x679c74,4)
    panel_calls = {}
    for name, va, handle in [('technique',0x42bb4e,0x02b8f954),('item',0x42cc03,0x02b8f958)]:
        record = pe_data(va,21)
        raw = bytes.fromhex(record['raw_hex'])
        expected = b'\x68'+struct.pack('<I',274)+b'\x68'+struct.pack('<I',467)+b'\xa1'+struct.pack('<I',handle)+b'\x50\xe8'
        call_target = va+21+struct.unpack_from('<i',raw,17)[0]
        if raw[:17] != expected or call_target != 0x55ecf0:
            raise ValueError('Native panel origin instruction bytes differ')
        panel_calls[name] = dict(**record,evidence_type='direct-pe-code-byte-observation',
            decoded_instructions=['push 274','push 467',f'mov eax,[{handle:#x}]','push eax','call 0x55ecf0'],
            call_virtual_address=hex(va+16),call_target=hex(call_target),
            menu_handle=hex(handle),origin=dict(x=467,y=274),
            limit='Source machine instruction bytes inspected directly. This is static evidence, not a new REA decompilation or original-game execution.')
    result['semantic_bindings'] = dict(
        evidence_boundary='Resource aliases combine source-pixel visual inspection and retained native static drawing evidence. No original execution was observed.',
        wheel=dict(menu='game002d',origin=dict(x=490,y=340),native_canvas=dict(width=640,height=480),
            origin_formula='(surface_width-150,surface_height-140)',native_function='0x42a910',evidence=wheel_evidence,
            background='assets/battle_ui/game002d/image_000.png',
            obsolete_templates=['fight_char','menu'],scale=1,
            slots=[dict(slot=i,widget=str(i+1).zfill(3),**pos) for i,pos in enumerate([
                dict(position='top',rect=[50,5,73,29]),dict(position='upper_left',rect=[9,30,32,53]),
                dict(position='lower_left',rect=[9,76,32,99]),dict(position='bottom',rect=[50,99,73,122]),
                dict(position='lower_right',rect=[89,76,112,99]),dict(position='upper_right',rect=[89,30,112,53]),
                dict(position='center',rect=[49,53,76,80])])],
            slot_limit='Rects identify original sensor regions. Actual command placement is dynamic and must follow the loaded command layout; position alone does not prove action semantics.'),
        ally_status=dict(menu='fight_stat',background='assets/battle_ui/fight_stat/image_000.png',
            origin_table_source=stat_table,origin_table=[dict(slot=i,x=xy[i*2],y=xy[i*2+1]) for i in range(4)],
            origin_binding_limit='0x42efc0 directly confirms the first table pair. Remaining pairs are observed contiguous source coordinates; all four native event callbacks should corroborate slot association.',
            first_slot_evidence=NATIVE_RECORDS['party_native.json'][3],
            name_asset='fight_role_name',name_origin=dict(x=70,y=3),
            name_frame_formula='native_actor_field_at_absolute_0x524a9d0+actor_index*0x30274 minus 1',
            name_frame_pixels=['英格妮','凯','娃蒂','佛兰珂','朱特','赛拉飞尔'],
            hp=dict(text_origin=dict(x=70,y=21),bar_origin=dict(x=75,y=40),bar_image='assets/battle_ui/fight_stat/image_001.png',bar_width=52,bar_height=4),
            mp=dict(text_origin=dict(x=144,y=21),bar_origin=dict(x=141,y=40),bar_image='assets/battle_ui/fight_stat/image_002.png',bar_width=52,bar_height=4),
            action_ball=dict(asset='time_bar',glass='time_glass',origin=dict(x=16,y=1),
                native_function='0x42ead0',evidence=hud_evidence,charge_cap_source=ready_cap,
                charge_cap=struct.unpack('<I',bytes.fromhex(ready_cap['raw_hex']))[0],
                source_half_height=23,
                ordinary_phase=dict(condition='actor u32 at absolute 0x521a7bd+actor*0x30274 == 0',
                    charge_source='u32 absolute 0x521a7b9+actor*0x30274, clamped to 0x679c74',
                    fill_height='floor(min(charge,cap)*23/cap)',unfilled_height='23-fill_height',
                    color_intermediate='u8 floor(unfilled_height*255/23); signed-byte c=(255-2*intermediate), negative c becomes 0',
                    color_call_raw='0x51e854(c,0x80,intermediate)',
                    clip_top='ball_origin.y+unfilled_height'),
                preparation_phase=dict(condition='0 < actor u32 absolute 0x521a7bd+actor*0x30274 < cap',
                    remaining_formula='cap-field',fill_height='floor(remaining*23/cap)',
                    clip_top='ball_origin.y+46-fill_height',
                    limit='Preserved native two-phase formula; color channel order and signed-byte wrapping should be corroborated at the 0x51e854/0x5394cd callers before claiming exact pixel equivalence.'),
                draw_order=['time_bar clipped/tinted primary','time_glass primary']),
            selected=dict(asset='fight_mark',origin=dict(x=-30,y=-16),frame_variable='DAT_02b9052c',
                draw_function='0x536fa0',blend='lighter',evidence=hud_evidence,
                condition='actor byte absolute 0x521a77a+actor*0x30274 is nonzero'),
            evidence=hud_evidence),
        info=dict(menu='fight_info',background='assets/battle_ui/fight_info/image_000.png',origin=dict(x=0,y=443),
            text_origin=dict(x=2,y=14),evidence=NATIVE_RECORDS['party_native.json'][4],native_function='0x42f410'),
        default_commands=dict(native_initializer='0x444590',evidence=NATIVE_RECORDS['party_native.json'][7],
            dispatch_function='0x428750',dispatch_evidence=NATIVE_RECORDS['party_native.json'][8],
            slots=[dict(slot=3,position='bottom',type=2,index_one_based=1,icon=0,color=0,command='使用招式',behavior='Open Fight001 technique list'),
                dict(slot=4,position='lower_right',type=2,index_one_based=2,icon=1,color=0,command='使用物品',behavior='Open Fight002 item list'),
                dict(slot=5,position='upper_right',type=2,index_one_based=3,icon=2,color=0,command='防御',behavior='Commit native actor action type 4'),
                dict(slot=6,position='center',type=2,index_one_based=4,icon=3,color=0,command='逃跑',behavior='Commit native actor action type 5')],
            limit='These are new-game defaults, corroborated by two retained original saves. All seven slots can be rebound; consume the current slot type/id instead of hard-coding these positions.',
            crosscheck='evidence/battle_ui_slot_crosscheck.json'),
        icons=dict(other_ball=dict(normal_frames=[0,1,2,3],active_offset=4,
            visual_labels=['單 glyph','bag glyph','shield glyph','running figure/action glyph'],
            command_names=['使用招式','使用物品','防御','逃跑'],
            command_ids=[1,2,3,4],command_type=2,
            semantic_evidence=NATIVE_RECORDS['party_native.json'][8]),
            magic_ball1=dict(normal_frames=list(range(6)),active_offset=6,
                visual_labels=['fire','cyan spiral','blue waves','green star','yellow sun','purple moon']),
            name_ball=dict(normal_frames=list(range(88)),active_offset=88,
                native_type1_frame_formula='command icon byte e8; selected adds 0x58',
                screenshot_correspondences=[dict(source_frame=0,pixels='pink fire glyph'),dict(source_frame=1,pixels='pink spiral glyph')]),
            magic_ball1_num=dict(frame_formula='attribute_index*7+count-1',count_limit=[1,7],
                origin_relative_to_icon=dict(x=14,y=12)),evidence=icon_evidence),
        actor_cursor=dict(asset='fight_cursor1',visual='blue large pointer',primary_blend='source-over',indexed_blend='lighter',
            anchor_raw=result['assets']['fight_cursor1']['anchor_raw'],
            limit='Native cursor anchor placement relative to actor height remains in caller investigation.'),
        target_cursor=dict(asset='fight_cursor2',visual='orange/red large pointer',primary_blend='source-over',indexed_blend='lighter',
            anchor_raw=result['assets']['fight_cursor2']['anchor_raw'],
            limit='Native cursor anchor placement relative to target height remains in caller investigation.'),
        technique_panel=dict(menu='fight001',row_highlight_group='BAR',row_highlight_image='assets/battle_ui/fight001/image_010.png',
            origin=dict(x=467,y=274),origin_evidence=panel_calls['technique']),
        item_panel=dict(menu='fight002',row_highlight_group='BAR_CEL',row_highlight_image='assets/battle_ui/fight002/image_001.png',
            origin=dict(x=467,y=274),origin_evidence=panel_calls['item']))


def image_output(image, path):
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)
    with Image.open(path) as saved:
        if saved.convert('RGBA').tobytes() != image.convert('RGBA').tobytes():
            raise ValueError('PNG pixel roundtrip differs')
    return path.relative_to(WEB).as_posix()


def menu(source):
    data = source.read_bytes()
    if u32(data, 0) != 3 or u32(data, 4) != 1:
        raise ValueError('Only source MNU v3 variant is supported')
    count, width, height = u32(data, 52), u32(data, 78), u32(data, 82)
    widgets = []
    for index in range(count):
        off = 1138 + 473 * index
        raw = data[off:off + 473]
        values = list(struct.unpack_from('<13i', raw, 25))
        widgets.append(dict(index=index, source_offset=off, type_raw=raw[0],
            name=string(raw[1:25]), values_at_25_raw=values,
            draw_point_raw=dict(x=values[1], y=values[2]),
            rect=dict(left=values[4], top=values[5], right=values[6], bottom=values[7]),
            bitmap_indices_raw=values[10:13], text_raw=string(raw[185:385]),
            font_raw=string(raw[405:437]), raw_hex=raw.hex()))
    sensor_start = 1138 + 473 * count
    sensor = data[sensor_start:sensor_start + width * height]
    target = OUT / source.stem.lower()
    sensor_image = image_output(Image.frombytes('L', (width, height), sensor), target / 'sensor.png')
    cursor = sensor_start + len(sensor)
    images, groups = [], []
    while cursor < len(data):
        group_start = cursor
        header = data[cursor:cursor + 61]
        name, n = string(header[:20]), u32(header, 20)
        if len(header) != 61 or not 0 < n <= 1000:
            raise ValueError(f'Invalid group at {cursor:#x}')
        group = dict(index=len(groups), name=name, source_offset=cursor,
            frame_count=n, header_hex=header.hex(), images=[], blend_mode_raw_24=header[0x24])
        groups.append(group)
        cursor += 61
        for frame in range(n):
            off = cursor
            frame_header = data[cursor:cursor + 20]
            w, h, size, mask_size, alpha_size = struct.unpack('<5I', frame_header)
            if not 0 < w <= 2048 or not 0 < h <= 2048 or mask_size not in (0, w*h) or alpha_size not in (0, w*h):
                raise ValueError('Unexpected MNU image geometry/planes')
            cursor += 20
            primary = data[cursor:cursor + size]
            secondary = data[cursor + size:cursor + size*2]
            image, structure, colors = decode_rows(primary, w, h)
            _, other, colors555 = decode_rows(secondary, w, h, True)
            if structure != other or [(((v & 0xffe0) >> 1) & 0xffe0) | (v & 31) for v in colors] != colors555:
                raise ValueError('Secondary RGB555 stream differs')
            cursor += size*2
            mask_offset = cursor if mask_size else None
            mask = data[cursor:cursor + mask_size]
            cursor += mask_size
            alpha_offset = cursor if alpha_size else None
            alpha = data[cursor:cursor + alpha_size]
            cursor += alpha_size
            index = len(images)
            rgb_path = image_output(image, target / f'image_{index:03}_primary.png')
            mask_image = image_output(Image.frombytes('L', (w,h), mask), target / f'image_{index:03}_mask.png') if mask else None
            alpha_image = image_output(Image.frombytes('L', (w,h), alpha), target / f'image_{index:03}_alpha.png') if alpha else None
            if alpha:
                image.putalpha(ImageChops.multiply(image.getchannel('A'),ImageOps.invert(Image.frombytes('L',(w,h),alpha))))
            image_path = image_output(image, target / f'image_{index:03}.png')
            rec = dict(index=index, group=group['index'], frame=frame, name=name,
                source_offset=off, width=w, height=h, stream_bytes=size,
                header_hex=frame_header.hex(), image=image_path, primary_image=rgb_path,
                png_sha256=sha((WEB/image_path).read_bytes()),
                pixel_bounds=image.getbbox(),
                mask_bytes=mask_size, mask_source_offset=mask_offset, mask_image=mask_image,
                mask_sha256=sha(mask) if mask else None,
                mask_limit='Preserved as raw byte plane; its runtime sensor/blending role is not inferred.' if mask else None,
                alpha_bytes=alpha_size, alpha_source_offset=alpha_offset, alpha_image=alpha_image,
                alpha_rule='Opacity=255-raw, with sparse uncovered pixels transparent' if alpha else None,
                secondary_verified=True)
            images.append(rec)
            group['images'].append(index)
    for widget in widgets:
        for kind, index in zip(('normal', 'active', 'selected'), widget['bitmap_indices_raw']):
            widget[kind+'_images'] = [images[i]['image'] for i in groups[index-1]['images']] if 0 < index <= len(groups) else []
    return dict(id=source.stem.lower(), source=source.relative_to(ROOT).as_posix(),
        source_sha256=sha(data), width=width, height=height, widget_count=count,
        header_hex=data[:1138].hex(), widgets=widgets, groups=groups, images=images,
        sensor=dict(source_offset=sensor_start, bytes=len(sensor), sha256=sha(sensor), image=sensor_image),
        eof_verified=cursor == len(data),
        coordinates='Source widget draw points and rectangles are relative to this MNU; absolute screen placement requires native caller evidence.')


def dgp(source):
    a = DGP(source)
    target = OUT / source.stem.lower()
    frames = []
    mask_block = next((x for x in a.optional_blocks if x['kind']=='per_frame_mask'), None)
    for i in range(a.frame_count):
        raw_image = a.decode(i)
        primary = image_output(raw_image, target / f'frame_{i:03}.png')
        rec = dict(index=i, image=primary, png_sha256=sha((WEB/primary).read_bytes()),
            source_frame_record=vars(a.frames[i]), pixel_bounds=raw_image.getbbox())
        if mask_block:
            off = mask_block['offset'] + a.width*a.height*i
            mask = a.data[off:off+a.width*a.height]
            mask_path = image_output(Image.frombytes('L',(a.width,a.height),mask),target/f'frame_{i:03}_mask.png')
            rec.update(mask_source_offset=off,mask_bytes=len(mask),mask_sha256=sha(mask),mask_image=mask_path)
            # Separate candidate, never silently substitute for the source spans.
            masked = raw_image.copy()
            masked.putalpha(ImageChops.multiply(raw_image.getchannel('A'),ImageOps.invert(Image.frombytes('L',(a.width,a.height),mask))))
            rec['inverse_mask_image'] = image_output(masked,target/f'frame_{i:03}_inverse_mask.png')
        if a.indexed_auxiliary:
            intrinsic, stats = indexed_contribution(a,i)
            rec['indexed_image'] = image_output(intrinsic,target/f'frame_{i:03}_indexed.png')
            rec['indexed_record'] = a.indexed_auxiliary[i]
            rec['indexed_stats'] = stats
            rec['indexed_blend'] = 'lighter'
        frames.append(rec)
    actions = []
    for action, raw in zip(a.actions,a.raw_actions):
        n = action['frames_per_direction']
        action = {**action, 'frame_sequence':native_frame_sequence(raw,0,n,0)}
        actions.append(action)
    return dict(id=source.stem.lower(), source=source.relative_to(ROOT).as_posix(),
        source_sha256=a.sha256,width=a.width,height=a.height,frame_count=a.frame_count,
        anchor_raw=a.anchor_raw,frames=frames,actions=actions,
        secondary_verification=a.verify_secondary(),metadata=a.metadata(),
        mask_limit='Inverse-mask PNGs are explicit rendering candidates only. Source raw mask plane and primary spans remain independently available; exact per-resource native blend caller must corroborate their use.' if mask_block else None)


def main():
    mnu_names = ['Fight001','Fight002','Fight_Char','Fight_Info','Fight_Stat','game002d']
    dgp_names = ['menu','time_bar','time_glass','fight_role_name','fight_cursor1',
        'fight_cursor2','fight_cursor3','fight_mark','fight_board_mask','fight_board_disable',
        'board_bright','board_brightB','magic_ball1','magic_ball1_attr','magic_ball1_num',
        'other_ball','use_ball','use_ball_num','char_ball','name_ball']
    sources = [ROOT/'SYSTEM'/(name+'.mnu') for name in mnu_names]
    sources += [ROOT/'Fight_Role/combo'/(name+'.dgp') for name in dgp_names]
    sources.append(ROOT/'GAME.exe')
    before = {p.relative_to(ROOT).as_posix():sha(p.read_bytes()) for p in sources}
    result = dict(version=1,evidence_type='static-source-resource-observation',
        native_canvas=dict(width=640,height=480),menus=[menu(p) for p in sources if p.suffix.lower()=='.mnu'],
        assets={p.stem.lower():dgp(p) for p in sources if p.suffix.lower()=='.dgp'},
        source_hashes=before,original_game_execution_observed=False,
        limitations=['Original-game behavior and native callers are not observed by this exporter.',
            'MNU coordinates are local source geometry. Screen placement and dynamic bitmap frame selection need separate native evidence.',
            'DGP primary and indexed layers remain separate. Indexed additive pixels need lighter blending after primary drawing.',
            'Exported DGP inverse-mask images are explicit candidates pending native per-resource blending confirmation.',
            'No screenshot pixels are used in game assets. User screenshot observations are separate reference evidence.'])
    native_path = retain_native()
    result['retained_native_evidence'] = dict(path=native_path.relative_to(RUNTIME).as_posix(),
        sha256=sha(native_path.read_bytes()),rea_analysis_rerun_this_export=False)
    bindings(result)
    after = {p.relative_to(ROOT).as_posix():sha(p.read_bytes()) for p in sources}
    if before != after:
        raise ValueError('Original source changed during export')
    result['original_inputs_unchanged'] = True
    dest = WEB/'data/battle_ui.json'
    dest.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    hashes = {p.relative_to(ROOT).as_posix():sha(p.read_bytes()) for p in sorted(OUT.rglob('*.png'))}
    hashes[dest.relative_to(ROOT).as_posix()] = sha(dest.read_bytes())
    hashes[native_path.relative_to(ROOT).as_posix()] = sha(native_path.read_bytes())
    ev = dict(passed=True,original_inputs_unchanged=True,source_hashes=before,
        output_hashes=hashes,menus=len(result['menus']),asset_count=len(result['assets']),
        mnu_images=sum(len(a['images']) for a in result['menus']),
        dgp_frames=sum(a['frame_count'] for a in result['assets'].values()),
        eof_verified=all(a['eof_verified'] for a in result['menus']),
        png_roundtrip_verified=True,original_game_execution_observed=False,limitations=result['limitations'])
    (RUNTIME/'evidence/battle_ui_resources.json').write_text(json.dumps(ev,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:ev[k] for k in ('passed','menus','asset_count','mnu_images','dgp_frames','eof_verified')},ensure_ascii=False))


if __name__ == '__main__':
    main()
