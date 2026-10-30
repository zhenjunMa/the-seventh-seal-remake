"""Rebuild the complete numeric, Chinese and MNU menu-font manifest.

The checked-in recipe preserves existing atlas coordinates. Each export appends
characters needed by newly connected content. Requested legacy MNU faces are sent to GDI literally;
GetTextFaceW records the actual local resolution.
"""
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent))
from incremental import write_json as incremental_json
from export_menu_font_gdi import export, RUNTIME, MANIFEST


RECIPE=Path(__file__).with_name('menu_font_recipe.json')


def collect_text_charset():
    data=RUNTIME/'web/data';texts=[];sources=[]
    def load(path):
        raw=path.read_bytes();sources.append({'path':path.relative_to(RUNTIME).as_posix(),
            'sha256':hashlib.sha256(raw).hexdigest()});return json.loads(raw)
    def add(value):
        if isinstance(value,str):texts.append(value)
    items=load(data/'items.json')
    for row in items['definitions'].values():add(row.get('name'));add(row.get('description'))
    roles=load(data/'party_skills.json')['roles']
    for role in roles.values():
        add(role.get('name'))
        for index in sorted(set(role['learned_indices'])|set(role.get('exposed_indices',[]))):
            row=role['skills'][index];add(row.get('name'))
            description=bytes.fromhex(row['fixed_raw_hex'])[0x3b:0x3b+200].split(b'\0',1)[0]
            add(description.decode('gbk'))
    for actor in load(data/'forest_combat.json')['actors'].values():add(actor['name'])
    for path in sorted((data/'maps').glob('*.json')):add(load(path).get('name'))
    for row in load(data/'world_map.json').get('destinations',[]):add(row.get('name'))
    menus=load(data/'operation_menu.json')['menus']
    technique_data=load(data/'operation_techniques.json')
    techniques=technique_data['menus']
    # A saved combination can use any original naming character, even when
    # that character does not occur in the currently learned skill names.
    for character in technique_data['name_charset']['characters']:add(character)
    for menu in menus+techniques:
        for widget in menu['widgets']:add(widget.get('text_raw'))
    # Current operation-menu labels/messages originate in these source modules;
    # only quoted text containing Chinese is collected, never raw-hex/catalogs.
    import re
    font_faces={row['face'] for row in json.loads(RECIPE.read_text(encoding='utf-8'))['fonts']}
    filenames={'web/controllers/menu.mjs','web/core/operation_menu.mjs',
        'web/core/equipment.mjs','web/core/field_items.mjs','web/core/field_skills.mjs'}
    filenames.update(p.relative_to(RUNTIME).as_posix() for p in (RUNTIME/'web').glob('operation_*_view.mjs'))
    filenames.update(p.relative_to(RUNTIME).as_posix() for p in (RUNTIME/'web/core').glob('menu_*.mjs'))
    filenames.add('web/battle_menu_view.mjs')
    filenames.update(p.relative_to(RUNTIME).as_posix() for pattern in ['battle_*.mjs','combat*.mjs'] for p in (RUNTIME/'web/core').glob(pattern))
    for filename in sorted(filenames):
        path=RUNTIME/filename
        if not path.exists():continue
        raw=path.read_bytes();sources.append({'path':filename,'sha256':hashlib.sha256(raw).hexdigest()})
        for match in re.finditer(r"(['\"`])([^'\"`\n]*)\1",raw.decode('utf-8')):
            if match[2] not in font_faces and re.search(r'[\u3400-\u9fff]',match[2]):add(match[2])
    characters=''.join(sorted({c for text in texts for c in text if c.isprintable()}|set('0123456789/ -x()：，。．、!?%+→　')))
    return characters,sources


def main():
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--refresh-charset',action='store_true',help='Compatibility flag; every export now appends connected characters while preserving existing glyph coordinates.')
    parser.add_argument('--evidence',default=None,
        help='New report filename inside runtime/evidence; an existing report is never replaced.')
    args=parser.parse_args()
    report_name=args.evidence or 'menu_text_finish_export_20261014.json'
    evidence=RUNTIME/'evidence'/report_name
    if evidence.exists() and args.evidence is None:
        from datetime import datetime,timezone
        evidence=evidence.with_name(evidence.stem+'_'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'.json')
    if evidence.parent.resolve()!=(RUNTIME/'evidence').resolve():parser.error('--evidence must be a filename inside runtime/evidence')
    if evidence.exists():parser.error('Evidence report already exists; choose a new --evidence filename')
    recipe=json.loads(RECIPE.read_text(encoding='utf-8'))
    current,sources=collect_text_charset()
    recipe['text_characters']+=''.join(c for c in current if c not in recipe['text_characters'])
    recipe['text_sources']=sources
    incremental_json(RECIPE, recipe)
    characters,sources=recipe['text_characters'],recipe['text_sources']
    numeric=[(r['key'],r['face'],r['height']) for r in recipe['fonts'] if r['kind']=='numeric']
    text_fonts=[(r['key'],r['face'],r['height']) for r in recipe['fonts'] if r['kind']=='text']
    export(numeric,recipe['numeric_characters'],preserve=False)
    export(text_fonts,characters,preserve=True,cell_width=40,cell_height=40,columns=32)
    manifest=json.loads(MANIFEST.read_text(encoding='utf-8'))
    manifest['text_charset']={'character_count':len(characters),'characters':characters,
        'sha256':hashlib.sha256(characters.encode('utf-8')).hexdigest(),'sources':sources,
        'scope':'Current item catalog names/descriptions, exposed/learned player skill names and raw-record descriptions, integrated enemy target names, integrated map names, all original combination naming characters, and connected operation/battle menu views and rule messages.',
        'original_font_boundary':'全真特黑體 is a literal MNU requested face. face_resolved records current Windows mapping; no original font file is supplied.'}
    manifest['MNU_parameters']={'procedure':'0x56DD00','draw_procedure':'0x5344F0',
        'measure_procedures':['0x5341A1','0x53434C'],
        'lfHeight':'Declared widget raw+0x1BB minus1; default declaration16 if zero.',
        'weight':'400 unless flags+0x1BC bit5 selects900.',
        'shadow_enabled':'flags+0x1BC bit1; foreground+0x1C2, shadow+0x1C6 are COLORREF.',
        'glyph_advance':'DBCS characters use declared fontsize; ASCII group layout uses exported glyph.char_width (GetCharWidthA, excludes charExtra1). TextOut ink still uses glyph.advance. A nonterminal group adds 2+(declared fontsize>>1).',
        'horizontal_alignment':'raw+0x1B9:0 center,1 left,2 right',
        'vertical_alignment':'raw+0x1BA:0 center,1 top,2 bottom',
        'coordinates':'Widget rect (raw+0x29..0x35) plus menu origin, not draw_point_raw.'}
    manifest['export_recipe']={'path':RECIPE.relative_to(RUNTIME).as_posix(),
        'sha256':hashlib.sha256(RECIPE.read_bytes()).hexdigest(),'single_command':'python remake/runtime/tools/export_menu_text_gdi.py'}
    incremental_json(MANIFEST, manifest)
    incremental_json(evidence, {'evidence_type':'source-parameter-derived-local-GDI','runtime_original_observed':False,
        'character_count':len(characters),'charset_sha256':manifest['text_charset']['sha256'],
        'fonts':{k:{'requested':v['face_requested'],'resolved':v['face_resolved'],'height':v['height'],
            'image_sha256':v['sha256']} for k,v in manifest['fonts'].items() if k.endswith(('_text','_mnu'))},
        'sources':sources,'limitations':manifest['limitations']})
    print(json.dumps({'character_count':len(characters),'manifest':str(MANIFEST),'evidence':str(evidence)},ensure_ascii=False))


if __name__=='__main__':main()
