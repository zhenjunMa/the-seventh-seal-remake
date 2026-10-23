"""Read-only native skill-test route and isolated TestStage pixel export.

Never rewrites the forest stage, party source manifests or dated old evidence.
The source test aliases are retained separately from the runtime's numeric
enemy templates. Their DGP files agree byte-for-byte; their CHR files do not.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
WEB = RUNTIME/'web'
EVIDENCE = RUNTIME/'evidence/skill_test_20261020'
ASSETS = WEB/'assets/skill_test_stage'
sys.path.insert(0, str(ROOT / "remake/runtime/tools"))
from PIL import Image
from source.combat_resources import CHR, GAME_SHA256
from source.dgp import DGP
from export_skill_layers import SourceAudit, save_layer
from export_forest_stage import image_asset

NATIVE = EVIDENCE/'native_evidence.json'
FOREST_NATIVE = RUNTIME/'evidence/forest_stage_native.json'
ALIASES = (('wolf','013'),('slime','012'),('eagle','011'))
STAGE_FILES = ('FSBLACK.DGP','FGTEST.DGP','FBTEST.DGP')


def sha(data): return hashlib.sha256(data).hexdigest()
def u32(raw,at): return struct.unpack_from('<I',raw,at)[0]
def i32(raw,at): return struct.unpack_from('<i',raw,at)[0]
def save(path,value):
    if not path.resolve().is_relative_to(RUNTIME.resolve()):
        raise ValueError('Skill-test output must remain in runtime')
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')


def proof(bundle,address,operation='procedure_pseudo_code'):
    records=json.loads(bundle.read_text('utf-8'))['records']
    r=next(r for r in records if r['operation']==operation and
        (r['parameters'].get('procedure') or r['parameters'].get('address'))==address)
    if r['subject']['digest']['sha256']!=GAME_SHA256:
        raise ValueError('Native source identity differs')
    return dict(bundle=bundle.relative_to(RUNTIME).as_posix(),evidence_id=r['evidence_id'],
        operation=operation,address=address)


def export_aliases():
    result=[]
    for alias,ident in ALIASES:
        a=CHR(ROOT/f'Fight_Role/{alias}.CHR')
        n=CHR(ROOT/f'Fight_Role/{ident}.CHR')
        if a.parsed_end!=len(a.data) or n.parsed_end!=len(n.data):
            raise ValueError('Alias CHR did not reach EOF')
        p=ROOT/f'Fight_Role/{alias}.dgp'
        q=ROOT/f'Fight_Role/{ident}.dgp'
        if sha(p.read_bytes())!=sha(q.read_bytes()):
            raise ValueError('Runtime visual alias pixels differ')
        skills=[]
        for s in a.skills:
            raw=bytes.fromhex(s['fixed_raw_hex'])
            typ=u32(raw,0x32)&15
            if typ:
                skills.append(dict(index=s['index'],original_id_raw=raw[0],type_raw=typ,
                    learned_raw=raw[0x23],name_raw_hex=s['name_raw_hex'],
                    name_cp936=bytes.fromhex(s['name_raw_hex']).decode('cp936','replace'),
                    source_offset=s['offset'],fixed_raw_hex=raw.hex(),
                    record_sha256=sha(raw),actions=s['actions']))
        learned=[s['index'] for s in skills if s['learned_raw']]
        if len(learned)!=1 or not any(s['original_id_raw']==67 and s['type_raw']==3 and s['learned_raw'] for s in skills):
            raise ValueError('Source dummy passive command differs')
        result.append(dict(alias=alias,runtime_enemy_resource=ident,
            source_chr=dict(path=f'Fight_Role/{alias}.CHR',sha256=a.sha256,header_raw_hex=a.header.hex()),
            runtime_template_chr=dict(path=f'Fight_Role/{ident}.CHR',sha256=n.sha256),
            source_dgp=dict(path=f'Fight_Role/{alias}.dgp',sha256=sha(p.read_bytes())),
            numeric_dgp=dict(path=f'Fight_Role/{ident}.dgp',sha256=sha(q.read_bytes())),
            dgp_bytes_equal=True,chr_bytes_equal=a.sha256==n.sha256,
            raw_hp_current=i32(a.header,0x30),raw_hp_maximum=i32(a.header,0x34),
            raw_mp_current=i32(a.header,0x38),raw_mp_maximum=i32(a.header,0x3c),
            source_skill_count=a.skill_count,numeric_skill_count=n.skill_count,
            learned_command_indices=learned,command_skills=skills,
            passive_command=dict(chr_skill_index=learned[0],original_id_raw=67,type_raw=3,name='不攻击'),
            limit='Runtime reuses the registered numeric enemy definition; matching DGP bytes do not imply identical CHR attributes or command tables.'))
    return result


def main():
    inputs=['GAME.exe','Fight_Bk/TestStage.scn',*[f'Fight_Bk/{n}' for n in STAGE_FILES],
        *[f'Fight_Role/{i}.{ext}' for pair in ALIASES for i in pair for ext in ('CHR','dgp')]]
    before={p:sha((ROOT/p).read_bytes()) for p in inputs}
    if before['GAME.exe']!=GAME_SHA256: raise ValueError('Source GAME differs')
    frozen=[WEB/'data/forest_stage.json',RUNTIME/'evidence/forest_stage_export.json',
        FOREST_NATIVE,WEB/'data/party_battle_view.json',WEB/'data/party_skills.json',
        RUNTIME/'evidence/menu_technique_native_20261013.json',
        RUNTIME/'evidence/menu_technique_native_20261013.snapshot.json']
    frozen_hashes={p.relative_to(ROOT).as_posix():sha(p.read_bytes()) for p in frozen}
    native_hash=sha(NATIVE.read_bytes())
    evidence=dict(entry=proof(NATIVE,'0x44e430','procedure_assembly'),
        party=proof(NATIVE,'0x4451c0','procedure_assembly'),
        literals=proof(NATIVE,'0x66d804','read_bytes'),hp_gate=proof(NATIVE,'0x5005c0','procedure_assembly'),
        mp_gate=proof(NATIVE,'0x501aa0'),escape_success=proof(NATIVE,'0x41f070','procedure_assembly'),
        individual_escape=proof(NATIVE,'0x50e4b0'),dispatch=proof(NATIVE,'0x42fe40'),
        item_effect=proof(NATIVE,'0x41b3e9'),inventory_consume=proof(NATIVE,'0x47c8e0'),
        cleanup=proof(NATIVE,'0x445f80'),party_writeback=proof(NATIVE,'0x4fe0c0'),
        ui_suspend=proof(NATIVE,'0x562de0'),ui_resume=proof(NATIVE,'0x562e70'),
        stage_loader=proof(FOREST_NATIVE,'0x51c48f'),viewport=proof(FOREST_NATIVE,'0x67c3a0','read_bytes'),
        sky_draw=proof(FOREST_NATIVE,'0x5154d8'),ground_scanlines=proof(FOREST_NATIVE,'0x5145d0','procedure_assembly'),
        object_projection=proof(FOREST_NATIVE,'0x513fc0','procedure_assembly'),sort=proof(FOREST_NATIVE,'0x515320'))
    s=(ROOT/'Fight_Bk/TestStage.scn').read_bytes()
    count=u32(s,0x34)+2
    if u32(s,0)!=2 or count!=3 or len(s)!=0x62c4+count*0x47:
        raise ValueError('Uncovered TestStage SCN geometry')
    layers=[];checks=[];generated=[];images={}
    for index,name in enumerate(STAGE_FILES):
        at=0x62c4+index*0x47;raw=s[at:at+0x47]
        if raw[0]!=index or raw[1:21].split(b'\0')[0].decode('ascii').upper()!=name:
            raise ValueError('TestStage layer identity differs')
        d=DGP(ROOT/f'Fight_Bk/{name}');audit=SourceAudit(d.data)
        if (d.width,d.height,d.frame_count)!=((640,480,1),(1400,400,1),(899,399,1))[index] or d.indexed_auxiliary or d.actions:
            raise ValueError('Uncovered TestStage DGP geometry')
        image=d.decode(0);rgba,check=audit.sparse(0,False)
        path=ASSETS/Path(name).stem/'frame_000.png';path.parent.mkdir(parents=True,exist_ok=True)
        frame=save_layer(image,path,rgba,check);generated.append(path);images[name]=image
        checks.append(dict(layer=name,source_frame=0,**check))
        layers.append(dict(id=Path(name).stem,role=('sky','ground','scene_object')[index],
            source=dict(path=f'Fight_Bk/{name}',sha256=d.sha256,width=d.width,height=d.height,frame_count=1,
                anchor_raw=d.anchor_raw,header_raw_hex=d.header.hex()),
            scn=dict(record_index=index,offset=at,bytes=0x47,raw_hex=raw.hex(),type_raw_00=raw[0],
                current_frame_raw_1d=u32(raw,0x1d),position_raw=dict(x=i32(raw,0x21),y=i32(raw,0x25),z=i32(raw,0x29)),
                flags_raw_31_36=list(raw[0x31:0x37]),sort_category_raw_36=raw[0x36]),
            frames=[dict(index=0,**frame)],animation=None))
    width,height=640,480;gh=layers[1]['source']['height'];gx=(1400-width)//2;gy=95;rows=gh-gy;horizon=height-rows
    ground=images['FGTEST.DGP'].crop((gx,gy,gx+width,gh))
    ground_path=ASSETS/'ground_default.png';ground_asset=image_asset(ground,ground_path);generated.append(ground_path)
    pos=layers[2]['scn']['position_raw'];anchor=layers[2]['source']['anchor_raw']
    ox=pos['x']-anchor[0];oy=pos['y']+pos['z']+height-gh-anchor[1]-32
    composition=dict(viewport=dict(width=width,height=height,evidence=evidence['viewport']),
        camera=dict(x=0,y=0,z=0,authority='source SCN loader zero-camera initialization'),
        sky=dict(layer_id='FSBLACK',initial_frame=0,source_rect=[0,0,width,horizon],destination_rect=[0,0,width,horizon],
            clip_bottom=horizon,origin_ignores_dgp_anchor=True,evidence=evidence['sky_draw']),
        ground=dict(layer_id='FGTEST',frame=0,source_rect=[gx,gy,width,rows],destination_rect=[0,horizon,width,rows],
            cropped_asset=ground_asset,source_x_at_camera_zero=gx,evidence=evidence['ground_scanlines']),
        scene_objects=[dict(layer_id='FBTEST',frame=0,source_rect=[0,0,899,399],destination_rect=[ox,oy,899,399],
            sort_category=layers[2]['scn']['sort_category_raw_36'],sort_y=pos['y'],placement_is_top_left=True,
            evidence=evidence['object_projection'])],
        draw_order='sky, ground, scenery textures, combat actors sorted by ground Y, then effects and HUD',
        camera_limit_x=(1400-width)//2+30,sort_evidence=evidence['sort'],animated_camera_projection_implemented=False,
        browser_adapter='Shared640x480 uniform stage geometry; actor placement uses the existing formal-battle presentation adapter.')
    preview=Image.new('RGBA',(width,height),'black')
    preview.alpha_composite(images['FSBLACK.DGP'].crop((0,0,width,horizon)),(0,0))
    preview.alpha_composite(ground,(0,horizon));preview.paste(images['FBTEST.DGP'],(ox,oy),images['FBTEST.DGP'])
    preview_path=ASSETS/'default_composite.png';preview_asset=image_asset(preview,preview_path);generated.append(preview_path)
    stage_path=WEB/'data/skill_test_stage.json'
    save(stage_path,dict(schema='seventh-seal-battle-stage',version=1,stage_id='TestStage',
        source_scn=dict(path='Fight_Bk/TestStage.scn',sha256=before['Fight_Bk/TestStage.scn'],version_raw=2,
            header_raw_hex=s[:0x4c].hex(),record_start=0x62c4,record_bytes=0x47,record_count=count,
            additional_objects_raw_34=u32(s,0x34),rendering_mode_raw_38=u32(s,0x38),
            opaque_block=dict(offset=0x4c,bytes=0x62c4-0x4c,sha256=sha(s[0x4c:0x62c4]))),
        layers=layers,default_composition=composition,default_composite=preview_asset,
        source_hashes={p:h for p,h in before.items() if p=='GAME.exe' or p.startswith('Fight_Bk/')},
        native_evidence=evidence,native_bundle=dict(path=NATIVE.relative_to(ROOT).as_posix(),sha256=native_hash),
        original_game_execution_observed=False,limitations=['Source TestStage pixels and zero-camera geometry are statically derived; no original battle runtime was observed.',
            'Original dynamic projection, native RGB565 mixing and camera changes are not claimed by this export.']))
    generated.append(stage_path)
    aliases=export_aliases()
    rules=dict(schema='seventh-seal-skill-test',version=1,
        enemy_resources=[i for _,i in ALIASES],enemy_source_aliases=aliases,
        stage=dict(path='/data/skill_test_stage.json',stage_id='TestStage',sha256=sha(stage_path.read_bytes())),
        native_mode=dict(global_055ee004=1,passive_enemies=True,
            hp_damage_commit_enabled=False,skill_mp_cost_enabled=False,escape_success_forced=True,escape_rng_draws=0,
            replenish_player_hp_mp_on_entry=False,inventory_consumption_is_source_normal=True,
            source_note='Global test flag gates HP damage and skill MP costs; it does not make all state/inventory transactions reversible.'),
        target_policy=dict(passive=True,source='Alias CHR only learned command is rawid67/type3 不攻击.',
            hp_policy='Damage settlement blocked through native test gate; no per-frame HP refill or invented infinite numeric HP.'),
        party=dict(selection='all_joined_first_six',entry_source='4451C0 visits party join flags in raw slot order0..5.',
            resources='Copy current party source header/skills through common loader; no test-specific HP/MP fill was observed in entry.',
            ko_limit='InitialKO handling remains the common loader/lifecycle behavior; test flag does not itself revive party actors.'),
        source=dict(path='GAME.exe',sha256=GAME_SHA256,entry_address='0x44e430',
            battle_dispatch='0x4451c0',enemy_literal_addresses=['0x66d81c','0x66d810','0x66d804'],stage_literal_address='0x66d828'),
        source_hashes=before,evidence=list(evidence.values()),
        native_bundle=dict(path=NATIVE.relative_to(RUNTIME).as_posix(),sha256=native_hash),
        native_exit=dict(escape='41F070 test gate returns success without RNG; 50E4B0 still marks one actor state11.',
            direct_end='Tab and R test HUD paths invoke50D1C0; test bypasses normal rewards/statistics.',
            inventory='41B3C0 success invokes47C8E0(-1,itemid), decrementing source global inventory without a test-mode gate.',
            party_writeback='445F80→50B050→4FE0C0 uses normal party header/skill writeback; 562DE0/E70 only save/restore UI callback context.'),
        combinations='Original test uses shared42FE40 single/combo/item/fixed dispatch, with no test-specific combination prohibition.',
        runtime_adaptations=['Use the already registered numeric013/012/011 enemy definitions and source-identical DGP pixels; do not claim alias CHR stats or skill tables are identical.',
            'Per current user requirement, passive targets do not initiate enemy AI.',
            'Per current user requirement, any party escape request ends this test session; original50E4B0 is individual withdrawal.',
            'The remake uses a private battle world while testing, then atomically commits changed actor resources and inventory on return, matching normal item consumption/effects. It commits no rewards, position or encounter RNG; unchanged values do not add a revision.',
            'Original source inventory/party writeback is not a full rollback sandbox. The private-world transaction boundary is a remake implementation adapter.'],
        original_game_execution_observed=False,
        limits=['Common implemented formal-battle skills/items/actions are reused; missing original combat behaviors are not created by this route.',
            'Original alias enemy stat and learned-command differences are retained for audit rather than silently substituted into numeric templates.'])
    rules_path=WEB/'data/skill_test.json';save(rules_path,rules);generated.append(rules_path)
    if before!={p:sha((ROOT/p).read_bytes()) for p in inputs}:raise ValueError('Original input changed')
    if frozen_hashes!={p.relative_to(ROOT).as_posix():sha(p.read_bytes()) for p in frozen}:raise ValueError('Old baseline changed')
    if native_hash!=sha(NATIVE.read_bytes()):raise ValueError('Native evidence changed while exporting')
    save(EVIDENCE/'export.json',dict(schema='seventh-seal-skill-test-export',version=1,passed=True,
        original_sources_unchanged=True,old_baselines_unchanged=True,source_hashes=before,frozen_old_hashes=frozen_hashes,
        native_bundle_sha256=native_hash,independent_source_pixel_checks=len(checks),frames=checks,
        default_composition=composition,output_hashes={p.relative_to(ROOT).as_posix():sha(p.read_bytes()) for p in generated},
        original_game_execution_observed=False))
    save(EVIDENCE/'findings.json',dict(schema='seventh-seal-skill-test-source-findings',version=1,
        scope='Static original test entry, flags, alias resources, default TestStage and persistence boundaries.',
        rules=rules,evidence=evidence,original_game_execution_observed=False,
        native_new_queries='Newfocused queries plus retained records imported from menu_technique snapshot; complete bundle preserves their original evidence IDs.',
        analysis_limit='Pseudo at internal41C186/41C38D failed input-varnode recovery; complete41BFB0 assembly is retained as the instruction-level source.'))
    print(json.dumps(dict(passed=True,stage_id='TestStage',enemy_resources=rules['enemy_resources'],pixel_checks=len(checks),
        source_literals=[a for a,_ in ALIASES],rules_sha256=sha(rules_path.read_bytes()),stage_sha256=sha(stage_path.read_bytes()))))


if __name__=='__main__': main()
