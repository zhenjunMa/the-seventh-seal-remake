"""Read-only export of the native picture-based startup menu.

PAK layout and two-pass indexed span compositor: native 4BC1E0, 4C5170,
4C5880, 4C58E0. Original carriers and saves are never written.
"""
from __future__ import annotations

import argparse
import hashlib
from io import BytesIO
import json
from pathlib import Path
import shutil
import struct
import subprocess

from PIL import Image, ImageDraw

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME / 'web'
OUT = WEB / 'assets/startup'
GAME_SHA = 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def save(path, data):
    assert path.resolve().is_relative_to(RUNTIME.resolve())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', 'utf-8')


def rgba565(value):
    r, g, b = value >> 11, (value >> 5) & 63, value & 31
    return ((r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2), 255)


def spans(blob, offset, count, stride):
    result = []
    for _ in range(count):
        y, x, size = struct.unpack_from('<HHH', blob, offset)
        offset += 6
        payload = blob[offset:offset + size * stride]
        assert len(payload) == size * stride
        result.append((y, x, size, payload))
        offset += size * stride
    return result, offset


def sprite(blob, palette, blend_palette):
    count, x, y, width, height, second = struct.unpack_from('<5HI', blob)
    primary, end = spans(blob, 14, count, 1)
    assert end == second
    n2, x2, y2, w2, h2 = struct.unpack_from('<5H', blob, second)
    secondary, end = spans(blob, second + 10, n2, 2)
    assert end == len(blob)
    bounds = (min(x, x2) if n2 else x, min(y, y2) if n2 else y,
              max(x + width, x2 + w2) if n2 else x + width,
              max(y + height, y2 + h2) if n2 else y + height)
    # Retain local span coordinates inside the PNG; caller adds only draw anchor.
    # Source header bounds can understate a span by one pixel. The native
    # compositor uses explicit span positions, so include every encoded span.
    image = Image.new('RGBA', (max([bounds[2]]+[col+size for _,col,size,_ in primary+secondary]),
                               max([bounds[3]]+[row+1 for row,_,_,_ in primary+secondary])))
    for row, col, size, payload in primary:
        for i, color in enumerate(payload):
            image.putpixel((col + i, row), rgba565(struct.unpack_from('<H', palette, color * 2)[0]))
    zero_additive = 0
    # The native second pass adds preweighted 5-bit source RGB to attenuated
    # RGB565 destination. PNG stores the equivalent unassociated color/opacity.
    # Browser 8-bit source-over rounding differs from original integer 565 by
    # at most the quantization step; preserve native layers in metadata.
    for row, col, size, payload in secondary:
        for i in range(size):
            color, opacity = payload[i * 2:i * 2 + 2]
            rgb = blend_palette[color * 4:color * 4 + 3]
            if opacity == 0:
                zero_additive += int(any(rgb))
                continue
            source = tuple(min(255, round(channel * 255 * 255 / (31 * opacity))) for channel in rgb)
            dest=image.getpixel((col+i,row)); alpha=opacity+dest[3]*(255-opacity)/255
            composed=tuple(round((source[c]*opacity+dest[c]*dest[3]*(255-opacity)/255)/alpha) for c in range(3))
            image.putpixel((col+i,row),(*composed,round(alpha)))
    assert zero_additive == 0, 'Additive zero-alpha pixels need a separate compositor'
    return image, dict(source_bounds=dict(x=x,y=y,width=width,height=height),
        blend_bounds=dict(x=x2,y=y2,width=w2,height=h2), opaque_spans=count,
        blend_spans=n2, blend_offset=second, encoded_bytes=len(blob), offset=dict(x=0,y=0),
        pixel_policy='Original local span positions retained; source RGB565 and preweighted 5-bit alpha colors expanded to RGBA')


def carrier(path):
    raw = path.read_bytes()
    key = path.stem.lower()
    target = OUT / key
    target.mkdir(parents=True, exist_ok=True)
    frames = []
    if key == 'menuback':
        assert raw[0] == 1
        count = struct.unpack_from('<I', raw, 1)[0]
        assert count == 6
        for i in range(count):
            off, size = struct.unpack_from('<II', raw, 5 + i * 72)
            name = raw[13 + i * 72:77 + i * 72].split(b'\0')[0].decode('ascii')
            bmp = raw[off:off+size]
            assert len(bmp) == size and bmp.startswith(b'BM')
            image = Image.open(BytesIO(bmp)).convert('RGBA')
            image.load()
            frames.append((image,dict(source_offset=off,source_bytes=size,source_name=name,offset=dict(x=0,y=0))))
    else:
        single = key in ('menulbk', 'menulbx')
        if single:
            size = struct.unpack_from('<I',raw)[0]
            count, offsets, start = 1, [0], 4
        else:
            count, size = struct.unpack_from('<II',raw)
            offsets = list(struct.unpack_from('<' + str(count) + 'I', raw, 8))
            start = 8 + count * 4
        assert offsets[0] == 0 and offsets == sorted(offsets)
        assert len(raw) == start + size + count * 1536
        palette_start = start + size
        blend_start = palette_start + count * 512
        for i, off in enumerate(offsets):
            end = offsets[i+1] if i+1 < count else size
            image, info = sprite(raw[start+off:start+end], raw[palette_start+i*512:palette_start+(i+1)*512], raw[blend_start+i*1024:blend_start+(i+1)*1024])
            frames.append((image,dict(source_offset=start+off,**info)))
    records = []
    for i, (image, info) in enumerate(frames):
        dest = target / f'frame_{i:03d}.png'
        image.save(dest)
        records.append(dict(index=i,path='/' + dest.relative_to(WEB).as_posix(),width=image.width,height=image.height,
                            sha256=sha(dest.read_bytes()),**info))
    return dict(source=dict(path=path.relative_to(ROOT).as_posix(),bytes=len(raw),sha256=sha(raw)),frames=records,
                frame_count=len(records),indexing='Zero based source index, with local span positions retained inside PNG')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--ffmpeg',default=shutil.which('ffmpeg'))
    parser.add_argument('--ffprobe',default=shutil.which('ffprobe'))
    args=parser.parse_args()
    assert args.ffmpeg and args.ffprobe
    assert sha((ROOT/'GAME.exe').read_bytes()) == GAME_SHA
    paths=sorted((ROOT/'picture').glob('Menu*.pak')) + [ROOT/'picture/SpecialBack.pak']
    assets={path.stem.lower():carrier(path) for path in paths}
    clips={}
    gallery=[dict(index=i,clip='sound/Special/'+(f'GGT/GGT{i+1:03d}.wav' if i<18 else f'Mitsuda/YM{i-17:03d}.wav')) for i in range(30)]
    audio_sources=['sound/menu/'+name+'.wav' for name in ['MBack','mMainMenu','mUpdown','mDecide','mSubMenu']]+[track['clip']for track in gallery]
    for source in audio_sources:
        original=ROOT/source
        raw=original.read_bytes()
        mpeg=raw.startswith(b'ID3') or raw[0]==255 and raw[1]&224==224
        output=OUT/'audio'/Path(source).relative_to('sound').with_suffix('.mp3' if mpeg else '.wav')
        output.parent.mkdir(parents=True,exist_ok=True)
        if mpeg: output.write_bytes(raw)
        else: subprocess.run([args.ffmpeg,'-v','error','-y','-i',str(original),'-map','0:a:0','-vn','-c:a','pcm_s16le',str(output)],check=True)
        def digest(p):
            return subprocess.run([args.ffmpeg,'-v','error','-i',str(p),'-map','0:a:0','-f','md5','-'],check=True,capture_output=True,text=True).stdout.strip()
        pcm=digest(original)
        if mpeg:
            assert output.read_bytes()==raw
        else:
            assert pcm==digest(output)
        probe=json.loads(subprocess.run([args.ffprobe,'-v','error','-show_entries','stream=codec_name,sample_rate,channels:format=duration','-of','json',str(output)],check=True,capture_output=True,text=True).stdout)
        stream=probe['streams'][0]
        clips[source]=dict(path='/' + output.relative_to(WEB).as_posix(),mime='audio/mpeg' if mpeg else 'audio/wav',sha256=sha(output.read_bytes()),
            source=dict(path=source,sha256=sha(raw),bytes=len(raw),declared_extension='.wav',observed_encoding='MPEG Layer III' if mpeg else 'RIFF/WAVE PCM'),
            audio=dict(codec=stream['codec_name'],sample_rate=int(stream['sample_rate']),channels=stream['channels'],duration_seconds=float(probe['format']['duration'])),
            export=dict(method='byte-preserving MPEG suffix correction' if mpeg else 'canonical PCM RIFF rewrap',decoded_pcm_md5=pcm,decoded_audio_unchanged=True))
    native=RUNTIME/'evidence/startup_menu_native_20261020.json'
    bundle=json.loads(native.read_text('utf-8'))
    extracted={}
    retained=RUNTIME/'evidence/startup_menu_retained_20261020'
    retained.mkdir(exist_ok=True)
    for record in bundle['records']:
        if record['operation']=='batch_decompile':
            for item in record['normalized_result']['items']:
                if item.get('pseudocode'):
                    address=item['procedure']['address']
                    (retained/(address+'.c')).write_text(item['pseudocode'],'utf-8')
                    extracted[address]=record['evidence_id']
    layout=dict(viewport=dict(width=640,height=480),button=dict(x=420,y=320),
        plaques=dict(x=450,y=100,step_y=50,initial_x=640,initial_step_x=50),help=dict(x=0,y=400,initial_x=-432),
        read=dict(initial_x=-432,x=-8,y=60,selection_x=0,selection_y=[81,188,295],slot_x=2,slot_y=[87,195,301]),
        special=dict(initial_x=-432,x=-8,y=70,rows_x=3,rows_y=117,row_step_y=39,heading_x=16,heading_y=60,
                     selected_asset='menuspecial00',normal_asset='menuspecial01',heading_asset='menuspecial30',
                     music_groups=[dict(first=0,last=17,heading_frame=0,window_first_min=0,window_first_max=11),dict(first=18,last=29,heading_frame=1,window_first_min=18,window_first_max=23)],
                     window='first=clamp(selected-3,group.window_first_min,group.window_first_max),last=first+6'),
        movies=dict(gametitle=dict(x=0,y=90,width=640,height=300),preopenpress=dict(x=0,y=0,width=640,height=480),openpress=dict(x=0,y=0,width=640,height=480)))
    manifest=dict(schema='seventh-seal-startup-menu',version=1,game_sha256=GAME_SHA,assets=assets,layout=layout,
        timing=dict(button_frame_ms=10,tick_ms=10,source='4BE350 uses 66F7F0 float32 0.01 seconds; reverse rotation and sliding gated by tick; forward rotation advances once per render loop',
                    fidelity_boundary='Browser uses a 10ms logical clock; native positive rotation depends on render-loop speed',
                    button=dict(positive='Increment zero-based index each render until target, wrap36',negative='Decrement index on 10ms tick until target, wrap36'),
                    plaque_slide=dict(initial_x=640,initial_step_x=50,target_x=450,
                                      step=[dict(if_x_at_least=481,delta=-10),dict(if_x_at_least=461,delta=-5),dict(if_x_at_least=451,delta=-1)],
                                      source='4BE350: x>=481 subtract10; x461..480 subtract5; x451..460 subtract1; stop450'),
                    help_slide=dict(initial_x=-432,target_x=0,step=[dict(if_x_below=-100,delta=32),dict(if_x_below=-50,delta=24),dict(if_x_below=-20,delta=16),dict(if_x_below=0,delta=8)],
                                    source='4BE350: first matching ascending threshold, on10ms tick; remaining positive branches unreachable from initial state'),
                    panel_slide=dict(initial_x=-432,target_x=0,open_step=[dict(if_x_below=-100,delta=32),dict(if_x_below=80,delta=16)],
                                     close_step=[dict(if_x_below=-100,delta=-32),dict(if_x_below=80,delta=-16)],
                                     source='4BE350: initial negative range to0 opens in32 then16 steps; closes from0 to-432 in16 then32 steps, on10ms tick')),
        menu=dict(stable_frames=dict(read=1,start=10,special=19,exit=28),frame_count=36,default='read',
                  plaque_counts=dict(read=1,start=1,special=3,exit=2),plaque_policy='Current submenu selector853 uses MenuSubN; other rows use MenuSubN2. Row index is not main category index.',
                  exit_count=dict(startup=1,in_game=2),navigation='Up/Down clamp submenu, extras row and save row/scroll; Left/Right cycle main categories',
                  extras_gates='MenuCode/83B can restrict selection;861==0 forces visible count1/selector0. Unlock rules remain incomplete.',
                  music_tracks=[dict(index=i,source='sound/Special/'+(f'GGT/GGT{i+1:03d}.wav' if i<18 else f'Mitsuda/YM{i-17:03d}.wav')) for i in range(30)],
                  left_cycle=['read','start','special','exit'],right_cycle=['read','exit','special','start']),
        audio=dict(clips=clips,music='sound/menu/MBack.wav',gallery=gallery,cues=dict(move='sound/menu/mUpdown.wav',rotate='sound/menu/mMainMenu.wav',submenu='sound/menu/mSubMenu.wav',confirm='sound/menu/mDecide.wav',open='sound/menu/mDecide.wav',cancel=None),
                   triggers=dict(rotate='4BE350: current frame2,11,20,29 calls mMainMenu',submenu='4C2130 /4C30A0: mSubMenu played while initializing category plaques',
                                 confirm='4C15E0: opening load/extras and accepting selections use mDecide',cancel='4BBAC0 WM_KEYDOWN Escape clears flags/selectors without a sound call',
                                 move='4BFAC0 /4C0260 mUpdown on changed submenu or extras row; save row path has its own boundary details',
                                 gallery='4C15E0 stops/frees950 then loads selected track and loops;4BBAC0 Escape only clears list selectors, retaining current950 track;4BDA10 stops/frees950 when leaving main menu')),
        evidence=dict(bundle=native.relative_to(ROOT).as_posix(),bundle_sha256=sha(native.read_bytes()),procedures=extracted,
                      initial_rules='remake/runtime/evidence/startup_rules.json',authority='Source carrier bytes plus native Ghidra static calls; not original runtime observation'),
        limitations=['Native alpha overlays use 5-bit preweighted color and RGB565 destination quantization; PNG exports preserve source color/alpha with browser rounding differences.',
                     'MenuCode registry and extras unlock gates are retained as unknown; assets include selected/normal row variants without claiming completion unlocks.',
                     'Read panel images are original; actual remake save metadata must be rendered from browser saves, never inferred from original user save bytes.'])
    save(WEB/'data/startup_menu.json',manifest)
    # Contact sheets retain source frame sequence and make review independent
    # of runtime presentation. These are extraction QA, not GUI observations.
    for key in ['menubtn','menusub0','menusub1','menusub2','menusub3']:
        records=assets[key]['frames']
        width=max(f['width'] for f in records);height=max(f['height'] for f in records)
        columns=min(6,len(records));rows=(len(records)+columns-1)//columns
        sheet=Image.new('RGB',(columns*width,rows*(height+20)),(24,24,24));draw=ImageDraw.Draw(sheet)
        for i,frame in enumerate(records):
            image=Image.open(WEB/frame['path'].lstrip('/')).convert('RGBA')
            x=(i%columns)*width;y=(i//columns)*(height+20)
            sheet.paste(image,(x,y),image);draw.text((x,y+height),str(i),fill='white')
        sheet.save(RUNTIME/'evidence'/f'startup_{key}_frames_20261020.png')
    source_hashes={'GAME.exe':GAME_SHA,**{a['source']['path']:a['source']['sha256'] for a in assets.values()},**{c['source']['path']:c['source']['sha256']for c in clips.values()}}
    output_hashes={**{'remake/runtime/web'+f['path']:f['sha256']for a in assets.values()for f in a['frames']},
                   **{'remake/runtime/web'+c['path']:c['sha256']for c in clips.values()},
                   'remake/runtime/web/data/startup_menu.json':sha((WEB/'data/startup_menu.json').read_bytes())}
    assert all(sha((ROOT/name).read_bytes())==expected for name,expected in source_hashes.items()),'Original input changed during export'
    report=dict(schema='seventh-seal-startup-menu-export',version=1,assets=len(assets),frames=sum(len(a['frames']) for a in assets.values()),audio_clips=len(clips),
                input_policy='Read only GAME.exe, picture and sound originals; writes confined to remake/runtime',manifest_sha256=sha((WEB/'data/startup_menu.json').read_bytes()),
                passed=True,source_bytes_unchanged=True,original_inputs_unchanged=True,source_hashes=source_hashes,output_hashes=output_hashes,native_evidence=manifest['evidence'],layout=layout)
    save(RUNTIME/'evidence/startup_menu_export_20261020.json',report)
    findings=dict(schema='seventh-seal-startup-menu-findings',version=1,authority='Native static pseudocode and carrier byte parsing; no new original GUI observation',
        evidence=manifest['evidence'],findings=[
            dict(question='Frame indexing and animation',status='answered static',source=['0x4bc1e0','0x4be350'],
                 conclusion='36 zero-based PAK records; stable1/10/19/28 are exact array indices. Forward every render; backward10ms tick. 66F7F0 VA maps to GAME.exe file0x47f0 bytes0ad7233c (float0.01).'),
            dict(question='Menu layout and slide timing',status='answered static',source=['0x4bc1e0','0x4be350','0x4c5170'],
                 conclusion='All draw anchors and incremental slide thresholds are in manifest.layout/timing. PAK span pixels add local coordinates; header bounds can understate actual spans by one pixel. PNG preserves every span.'),
            dict(question='GameTitle position',status='answered static',source=['0x530c50','0x530d56'],
                 conclusion='BinkCopyToBuffer receives viewport origin+(viewport dimension-Bink dimension)/2; 640x300 GameTitle is(0,90) within640x480.'),
            dict(question='Top plaque states, help and navigation',status='answered static with gates unresolved',source=['0x4be350','0x4bfac0','0x4c0260','0x4bbac0'],
                 conclusion='MenuSubN selected/large;MenuSubN2 unselected/smaller. 853 selects current row, Up/Down clamps. HelpMenuHLPN+row reloads and starts atx-432. Startup Exit has1 row, in-game has2.'),
            dict(question='Read window and saves',status='answered static for drawing',source=['0x4be350','0x4c15e0'],
                 conclusion='MenuLBK background at(-8,60); MenuLBX selected row at(0,81/188/295). Three metadata draws at(2,87/195/301), selector847 plus scroll843. No original saves written or represented as browser saves.'),
            dict(question='Special window and audio',status='partially answered static',source=['0x4be350','0x4c15e0','0x4c69a0'],
                 conclusion='SpecialBack at(-8,70); MenuSpecial00/01 selected/normal music rows at(3,117+39*i).30 rows map18GGT+12Mitsuda tracks; seven visible rows within composer group. MenuSpecial30 frames0/1 draw corresponding composer header(16,60). Source music rows and selected/normal assets exported; completion/registry gating remains unresolved.'),
            dict(question='Pixel compositor',status='answered static with RGBA adaptation',source=['0x4c5170','0x4c5880','0x4c58e0'],
                 conclusion='First pass paletteRGB565 opaque row spans; second preweighted5-bit RGB plus integer-attenuated565 destination. PNG expands to RGBA; browser quantization differs from native integer arithmetic.'),
            dict(question='Runtime verification',status='unresolved by this asset worker',source=[],conclusion='Contact sheets inspect extracted frames only; parent task supplies actual browser workflow evidence. No claim of original-game timing observation.')])
    save(RUNTIME/'evidence/startup_menu_findings_20261020.json',findings)
    print(json.dumps(dict(assets=len(assets),frames=report['frames'],audio_clips=len(clips),manifest=str(WEB/'data/startup_menu.json'))))


if __name__=='__main__':
    main()
