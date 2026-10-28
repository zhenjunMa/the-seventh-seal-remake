"""Read-only native dialogue art and local source-parameter GDI export.

Ordinary TLK style0/1 uses 17px; style2 uses Think_Msg and 13px.
Original files are hashed before and after; only remake outputs are written.
"""
import hashlib
import json
from pathlib import Path
import sys

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME/'web'
OUT = WEB/'assets/dialogue_ui'
REPORT = RUNTIME/'evidence/dialogue_alignment_20261021'
sys.path.insert(0,str(ROOT/'remake/runtime/tools'))
from incremental import write_json as incremental_json, recipe_hash, cached_png
sys.path.insert(0,str(Path(__file__).resolve().parent))
from source.dgp import DGP
import export_menu_font_gdi as gdi
from content_registration import definition


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    incremental_json(path, value)


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    resources = {}
    names = {'board':'SYSTEM/MessageBoard.dgp','think':'SYSTEM/Think_Msg.dgp',
        'wait1':'SYSTEM/MessageWait1.dgp','wait2':'SYSTEM/MessageWait2.dgp',
        'faces':'ROLE/face.dgp'}
    sources = {name:sha(ROOT/name) for name in ['GAME.exe',*names.values()]}
    for key,name in names.items():
        d = DGP(ROOT/name)
        frames = []
        for i in range(d.frame_count):
            target = OUT/f'{key}_{i:03}.png'
            cached_png(RUNTIME, target, d.sha256, {'frame':i}, recipe_hash([Path(__file__),Path(__file__).parent/'source/dgp.py']), lambda: d.decode(i))
            frames.append({'index':i,'image':'/'+target.relative_to(WEB).as_posix(),'sha256':sha(target)})
        resources[key] = {'source':name,'source_sha256':d.sha256,'width':d.width,'height':d.height,
            'frames':frames,'interval_ms':d.actions[0]['interval_raw'] if d.actions else None,
            'frame_count':d.frame_count,'source_actions':d.actions,'header_hex':d.header.hex(),
            'geometry_hex':d.geometry.hex(),'anchor_raw':d.anchor_raw}
    texts=[]
    text_sources=[]
    records=[]
    event_records={}
    def collect(value):
        if isinstance(value,dict):
            if isinstance(value.get('text_raw'),str):
                texts.append(value['text_raw'])
                if len(value.get('raw_hex',''))>=1647*2:
                    b=bytes.fromhex(value['raw_hex'])
                    records.append({'source':value.get('source'),'style':b[1],'face_id':b[2],
                        'portrait_left':b[6],'speaker':int.from_bytes(b[15:19],'little'),
                        'text':value['text_raw'],'inline_flags':[int.from_bytes(b[311+i*4:315+i*4],'little') for i in range(256)],
                        'choices':[{'index':i,'text':b[1335+i*104:1355+i*104].split(b'\0')[0].decode('gbk',errors='replace'),
                            'target':int.from_bytes(b[1435+i*104:1439+i*104],'little')}
                            for i in range(3) if b[1335+i*104]!=0]})
            for key,item in value.items():
                if key in ['speaker_name','name','text','label','speaker'] and isinstance(item,str):texts.append(item)
                if key!='raw_hex':collect(item)
            if value.get('op')=='say' and isinstance(value.get('source'),dict):
                source=value['source'];name=source.get('path');offset=source.get('record_offset')
                if name and isinstance(offset,int) and (ROOT/name).exists():
                    sources[name]=sha(ROOT/name)
                    b=(ROOT/name).read_bytes()[offset:offset+1647]
                    if len(b)==1647:
                        event_records[f"{name}#{source.get('record_id')}"]={'style':b[1],'portrait_id':b[2],
                            'region_byte_raw':b[6],'speaker':int.from_bytes(b[15:19],'little'),
                            'source':source,'text_raw':b[55:311].split(b'\0')[0].decode('gbk',errors='replace')}
        elif isinstance(value,list):
            for item in value:collect(item)
    paths=[WEB/'data/opening_program.json',WEB/'data/chapter_story.json',WEB/'data/events.json',
        *sorted((WEB/'data/events').glob('*.json'))]
    paths.extend(WEB/name for name in definition().get('story', {}).get('events', []) if WEB/name not in paths)
    for path in paths:
        if path.exists():
            text_sources.append({'path':path.relative_to(RUNTIME).as_posix(),'sha256':sha(path)})
            collect(json.loads(path.read_text(encoding='utf-8')))
    texts.extend(c['text'] for r in records for c in r['choices'])
    texts.extend(r['text_raw'] for r in event_records.values())
    chars=''.join(sorted({c for t in texts for c in t if c.isprintable()} | {chr(i) for i in range(32,127)}))
    old_out,old_manifest=gdi.OUT,gdi.MANIFEST
    try:
        gdi.OUT=OUT;gdi.MANIFEST=WEB/'data/dialogue_fonts.json'
        gdi.export([('dialogue17','宋体',17),('dialogue13','宋体',13),('caption19','宋体',19),
            ('latin17','Benguiat Bk BT',17),('latin13','Benguiat Bk BT',13)],
            charset=chars,cell_width=32,cell_height=32,columns=32,character_extra=0)
        fonts=json.loads(gdi.MANIFEST.read_text(encoding='utf-8'))
        fonts.update(schema='seventh-seal-dialogue-gdi-fonts',native_procedure='0x466450',
            native_evidence_id='ev_5a71b46ca5199b02cf3a94ce5e5813a9a8647ec44453f5de9fe51b21c877610e',
            parameters={'positive_lfHeight':True,'lfWeight':400,'lfCharSet':1,'lfQuality':4,
                'character_extra':0,'shadow_offsets':[[1,1]],'text_origin':'TextOut top-left; ordinary text uses logical origin minus1,-1; choices use logical origin exactly'},
            text_charset={'characters':chars,'character_count':len(chars),'sources':text_sources},
            style_fonts={'0':'dialogue17','1':'dialogue17','2':'dialogue13','3':'caption19'})
        write(gdi.MANIFEST,fonts)
    finally:
        gdi.OUT,gdi.MANIFEST=old_out,old_manifest
    manifest={'schema':'seventh-seal-dialogue-ui','version':1,'viewport':{'width':640,'height':480},
        'resources':resources,'font_manifest':'data/dialogue_fonts.json','record_overrides':event_records,
        'ordinary':{'styles':[0,1],'font_key':'dialogue17','ascii_font_key':'latin17',
            'font_height':17,'character_step':19,'line_step':21,'text_width':350,'text_height':60,
            'text_origin_x':40,'left_portrait_text_origin_x':268,'text_origin_y':{'0':60,'1':390},
            'text_draw_offset':[-1,-1],'board_origin':{'0':[0,10],'1':[0,360]},
            'portrait_origin':{'right':{'0':[392,0],'1':[392,172]},'left':{'0':[0,0],'1':[0,172]}},
            'portrait_id_field':'TLK byte+2; zero means none; frame=id-1',
            'portrait_side_field':'TLK byte+6 (region_byte_raw); zero=right; nonzero=left',
            'speaker_name_panel':False,'page_overflow':'Before adding a new line, next row y>text_height-10 waits; ordinary rows0,21,42.',
            'board_entry':{'start_x':-320,'step_x':32,'tick_ms':20,'end_x':0},
            'portrait_entry':{'initial_size':[148,208],'size_step':[10,10],'ticks':10,'tick_ms':20,'initial_alpha_raw':220,'alpha_step_raw':-20}},
        'thought':{'style':2,'font_key':'dialogue13','ascii_font_key':'latin13','font_height':13,
            'character_step':15,'line_step':15,'text_width':130,'text_height':54,
            'text_anchor':'actor x minus65, actor head y minus54, then clamp text rect to 640x480',
            'background_offset':[-28,-20],'text_draw_offset':[-1,-1],'auto_close':False},
        'timing':{'character_interval_ms':120,'waiting_marker':'ordinary=wait1, style2=wait2',
            'marker_origin':'logical origin + penX+2, penY+fontHeight-resource.height'},
        'colors':{'party':{'foreground':'#4b1410','shadow':'#fb8c39'},
            'npc':{'foreground':'#3f1c1c','shadow':'#e5b900'},'speaker_cutoff':11,
            'choice_selected':{'foreground':'#8b1a14','shadow':'#fffa84'},
            'choice_normal':{'foreground':'#ed0e00','shadow':'#faca66'},
            'choice_fill_rgb':[171,168,105],'choice_border_rgb':[116,106,62]},
        'input':{'typing':'Input routed into4661F0 requests fast fill; next timer draws remainder, no immediate branch.',
            'waiting':'style0/1 scroll upward one21px row and retain penY; style2 resets penY and clears its text surface. When source exhausted and choices absent follow TLK next.',
            'choices_appearance':'0x465350 invokes0x465700 when text reaches its terminator; final characters reveal choices automatically. A fill input cannot also submit a choice.',
            'choices':{'maximum':3,'default_index':0,'previous':['ArrowLeft','ArrowUp'],
                'next':['ArrowRight','ArrowDown'],'confirm':['Enter','Space'],'cancel':None,
                'layout':'Horizontal on row after text. DBCS choice advance17/13, no2 gap; gap between options=font height.',
                'highlight_padding':[-5,-2,5,2]},
            'escape':'No cancellation case in focused4661F0; outer input-dispatch coverage is separate.'},
        'limitations':['Static original-code/resource evidence; no original runtime observation in this pass.',
            'All connected audited TLK records use portrait-side byte0. Nonzero-side background position needs original runtime corroboration.',
            'Original font files absent: GDI face_resolved records the current Windows substitution; masks are derived, not original captures.',
            'Native RGB565 blend, global clock, scrolling and portrait alpha need browser adaptation.',
            'No new dialogue audio mapping inferred from menu audio. Focused rendering/input routines contain no sound call.']}
    write(WEB/'data/dialogue_ui.json',manifest)
    assert sources=={name:sha(ROOT/name) for name in sources}
    write(REPORT/'source_audit.json',{'schema':'seventh-seal-dialogue-source-audit','passed':True,
        'evidence_type':'native-static-and-source-resource-derived-local-GDI','original_runtime_observed':False,
        'source_unchanged':True,'source_hashes':sources,'text_sources':text_sources,
        'font_resolution':{k:v['face_resolved'] for k,v in fonts['fonts'].items()},'character_count':len(chars),
        'record_count_including_repeated_references':len(records),'unique_event_record_overrides':len(event_records),
        'used_face_ids':sorted({r['face_id'] for r in records}),
        'connected_portrait_side_bytes':sorted({r['portrait_left'] for r in records}),
        'output_hashes':{p.relative_to(ROOT).as_posix():sha(p) for p in [*OUT.glob('*.png'),WEB/'data/dialogue_ui.json',WEB/'data/dialogue_fonts.json']},
        'limitations':manifest['limitations']})
    write(REPORT/'connected_tlk_ui_records.json',records)
    print(json.dumps({'passed':True,'characters':len(chars),'art_frames':sum(r['frame_count'] for r in resources.values()),
        'records':len(records),'manifest':str(WEB/'data/dialogue_ui.json')},ensure_ascii=False))


if __name__=='__main__':main()
