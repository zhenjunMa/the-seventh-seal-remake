"""Read-only original caption, loading page and local GDI mask export.

User screenshots correct the prior border/color/initial-facing inference.
Native ANM/effect/camera evidence is retained in the sequence report folder.
"""
import hashlib
import json
from pathlib import Path
import sys

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME/'web'
OUT = WEB/'assets/prologue'
REPORT = RUNTIME/'evidence/prologue_routes_20261020'
sys.path.insert(0,str(ROOT/'remake/runtime/tools'))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from source.dgp import DGP
import export_menu_font_gdi as gdi
import export_battle_ui as ui


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    sources={name:sha(ROOT/name) for name in ['GAME.exe','SYSTEM/SysMsessageA.dgp',
        'SYSTEM/SysMsessageB.dgp','SYSTEM/MessageWait1.dgp','Map/m72061.TLK',
        'SYSTEM/Progress01.dgp','SYSTEM/Progress.mnu','ROLE/013.dgp','Animate/Resurrect.ANM']}
    resources={}
    for key,name in [('ends','SysMsessageA'),('lines','SysMsessageB'),('wait','MessageWait1')]:
        path=ROOT/f'SYSTEM/{name}.dgp';d=DGP(path);frames=[]
        for i in range(d.frame_count):
            target=OUT/f'{key}_{i:02}.png';d.decode(i).save(target)
            frames.append({'image':'/'+target.relative_to(WEB).as_posix(),'sha256':sha(target)})
        resources[key]={'source':path.relative_to(ROOT).as_posix(),'source_sha256':d.sha256,
            'width':d.width,'height':d.height,'frames':frames,
            'interval_ms':d.actions[0]['interval_raw'] if d.actions else None,
            'source_action_hex':[raw.hex() for raw in d.source_actions]}
    opening=json.loads((WEB/'data/opening_program.json').read_text(encoding='utf-8'))
    chapter=json.loads((WEB/'data/chapter_story.json').read_text(encoding='utf-8'))
    texts=[]
    def collect(value):
        if isinstance(value,dict):
            if value.get('style')==3 and isinstance(value.get('text_raw'),str):texts.append(value['text_raw'])
            for item in value.values():collect(item)
        elif isinstance(value,list):
            for item in value:collect(item)
    collect(opening);collect(chapter)
    characters=''.join(sorted(set(''.join(texts)) - {'\n','\r'}))
    old_out,old_manifest=gdi.OUT,gdi.MANIFEST
    try:
        gdi.OUT=OUT;gdi.MANIFEST=WEB/'data/prologue_fonts.json'
        gdi.export([('caption19','宋体',19)],charset=characters,cell_width=32,cell_height=32,columns=32,character_extra=0)
        fonts=json.loads(gdi.MANIFEST.read_text(encoding='utf-8'))
        fonts.update(native_procedure='0x466450',native_evidence_id=None,
            parameters={'positive_lfHeight':True,'lfHeight':19,'lfWeight':400,'lfCharSet':1,
                        'lfQuality':4,'character_extra':0,'shadow_offsets':[[1,1]],
                        'text_origin':'GDI TextOut top-left cell origin; native pen step=height+2'})
        write(gdi.MANIFEST,fonts)
    finally:gdi.OUT,gdi.MANIFEST=old_out,old_manifest
    loading_dir=WEB/'assets/prologue_loading';loading_dir.mkdir(parents=True,exist_ok=True)
    progress=DGP(ROOT/'SYSTEM/Progress01.dgp');backgrounds=[]
    for i in range(progress.frame_count):
        target=loading_dir/f'background_{i:02}.png';progress.decode(i).save(target)
        backgrounds.append({'image':'/'+target.relative_to(WEB).as_posix(),'sha256':sha(target)})
    old_ui_out=ui.OUT
    try:
        ui.OUT=loading_dir
        loading_menu=ui.menu(ROOT/'SYSTEM/Progress.mnu')
    finally:ui.OUT=old_ui_out
    write(REPORT/'loading_mnu.json',loading_menu)
    loading={'backgrounds':backgrounds,'origin':{'x':233,'y':403},
        'frame':'/'+loading_menu['images'][0]['image'],
        'fill':'/'+loading_menu['images'][1]['image'],
        'fill_rect':loading_menu['widgets'][1]['rect'],
        'minimum_display_ms':600,
        'authority':'GAME.exe 4B77F0/4B7A40; Progress01 action origin and Progress.mnu control104. Progress counts browser preparation tasks.'}
    manifest={'schema':'seventh-seal-prologue-presentation','version':3,'resources':resources,'loading':loading,
        'font_manifest':'data/prologue_fonts.json','style':3,'font_height':19,'character_step':21,
        'character_interval_ms':120,'foreground':'#f0e8b8','shadow':'#e0b800','border':False,
        'staging':{'M72061':{'slots':[10,11,12,13,14],'initially_hidden':True,'axis_approach':True,
            'direct_arrivals':{'slots':[10,11,12,13],'direction':3,
                'authority':'User correction: four later arrivals should move directly to their final positions without an intermediate turn.'},
            'authority':'User original screenshots: empty first caption; actor14 first, four followers later; final approach faces up. Raw DAT direction retained.'}},
        'effects':{'tick_ms':20,'reveal_ticks':40,'particle_ticks':30},
        'authority':'User original screenshots and order; native ANM, camera, effect dispatch and original loading resources; local GDI caption masks.',
        'limitations':['Original screenshots supplied by user; no new original GAME.exe runtime capture.',
            'Browser clock, deterministic particle seed and 8-bit compositing approximate native render ticks, RNG and RGB565 blending.',
            'The four followers use a direct visual arrival per user request; intermediate source moves still execute in the VM. The lead actor retains its separate approach.',
            'Loading progress counts actual browser asset preparation tasks; cached transitions keep the page visible for 600ms.']}
    write(WEB/'data/prologue_presentation.json',manifest)
    assert sources=={name:sha(ROOT/name) for name in sources}
    outputs={p.relative_to(ROOT).as_posix():sha(p) for p in OUT.glob('*.png')}
    outputs.update({p.relative_to(ROOT).as_posix():sha(p) for p in loading_dir.rglob('*.png')})
    for name in ['prologue_presentation.json','prologue_fonts.json']:
        p=WEB/'data'/name;outputs[p.relative_to(ROOT).as_posix()]=sha(p)
    write(REPORT/'export.json',{'schema':'seventh-seal-prologue-export','passed':True,
        'source_unchanged':True,'source_hashes':sources,'output_hashes':outputs,
        'font_resolution':fonts['fonts']['caption19']['face_resolved'],'characters':len(characters),
        'scope':manifest['authority'],'limitations':manifest['limitations']})
    print(json.dumps({'passed':True,'images':len(outputs)-2,'characters':len(characters)}))


if __name__=='__main__':main()
