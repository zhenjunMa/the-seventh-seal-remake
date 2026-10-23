"""Read-only export of the bounded 001/012 development battle.

Player values and equipped item instances come from the verified level-12 save,
not the level-11 CHR defaults. Enemy values and its one fixed action come from
012.CHR. Equipment aggregation follows GAME.exe 0x47CC30; numeric damage is
implemented separately. No original executable or save is run or modified.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / 'remake/runtime'
sys.path.insert(0, str(ROOT / "remake/runtime/tools"))
sys.path.insert(0, str(ROOT / 'save_analysis_20261010'))
from source.combat_resources import CHR
from save_format import complete_layout
from inspect_equipment import describe_equipment

EXPECTED = {
    'GAME.exe': 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18',
    'Fight_Role/001.CHR': '37ce92ab57622d2cce022b4a9b8add9b29789f89d82bc369ea7352f38ca75c0a',
    'Fight_Role/012.CHR': '4c9d1ef867222a8ffbdfea2e231f7500f30e0d7fec4fbfa1ab18b2dc874061a0',
    'save_analysis_20261010/verified_level12_SaveGame0.Dat': 'f720fdd2eb0353f67b3acdb598bb3e2cbf24be438bca96a13967da71bec70706',
}
EVIDENCE = {
    'equipment': 'ev_de220f43e821b9a576ed59300a6a814ea6219a2ab046f366e26934036aa2b048',
    'mp_cost': 'ev_8a85a0d009147cedbd93b454218a07cd79ccade3753a417ee024faea165d212f',
    'skill_start': 'ev_9814c00d3dfa36aabf515b6de7928ab6bce59b490b8d67a71738ec2112b51486',
    'hp_getter': 'ev_635bf69f89b9158deec299cbb4f0e334664adeb56ef85dca7d95156113e301e8',
    'hp_commit': 'ev_e76dc0fc2a37ba715b7005825ea4ce93f1523440769a6aa6549a0ac77569df72',
    'mp_getter': 'ev_3bc6b674861459288a7cedf9c7a29da24ef86237e8bca46f7781197d882b5f04',
    'display': 'ev_8500af603311e2535307b3b463bae7d0f6f6f913b064a1a19962a81c58fba85d',
    'class': 'ev_e684765a5b552708f4e35b7fa0516950d8ef5d9e5acc0b9e4ddb0f7e3ff1a5cf',
    'selector': 'ev_8144fc16b1d9d5d07db75171c36c29c2b6364a5da0cc8346cb2c68498a27ff4c',
    'gauge': 'ev_b9249144097bafc39bed2bdda8d8d027914e6da73ddb969c2a24e003709caa6a',
    'enemy_ai': 'ev_69be33ae87efda451bb53fb85478cbd1e2a61e953a7d1d0367449723504d5be8',
    'effective': 'ev_1303a62e3e254cd7e702384a9dc7969f724a5a21d0d057b071f3f42bfb371a68',
}
HEADER_BASE = 0x0524A6D1
HEADER_FIELDS = [0x30,0x34,0x38,0x3c,0x40,0x44,0x48,0x4c,0x50,0x54,0x58,0x5c,
                 0x7a,0x7e,0x82,0x86,0x8a,0x8e]
STATUS_FIELDS = list(range(0x0521f551, 0x0521f5d1, 4))
LINK_FIELDS = list(range(0x04f99088, 0x04f990ac, 4)) + list(range(0x04f990d0, 0x04f990f8, 4))

def address(n): return f'0x{n:08x}'
def i32(raw, offset): return struct.unpack_from('<i', raw, offset)[0]
def u32(raw, offset): return struct.unpack_from('<I', raw, offset)[0]
def idiv(a, b): return (-1 if (a < 0) != (b < 0) else 1) * (abs(a) // abs(b))
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def source(path, **fields):
    relative = Path(path).resolve().relative_to(ROOT.resolve()).as_posix()
    return dict(path=relative, sha256=EXPECTED[relative], **fields)

def equipment_table(header, equipment):
    """Native group[0]-gated sum; item offsets verified against full assembly.

    Equipment records are 0xE5 bytes, groups 0x8F2, roles 0x5974. Percentage
    bonuses use the *maximum* stored HP/MP, for both current and max additions.
    Native divisions truncate toward zero; subtractive element values remain.
    """
    totals = {offset: 0 for offset in range(0x0d, 0x7d, 4)}
    used = []
    for group in equipment['groups']:
        if not any(entry['entry_index'] == 0 for entry in group['entries']):
            continue
        for entry in group['entries']:
            record = bytes.fromhex(entry['raw_instance_hex'])
            assert len(record) == 0xe5 and u32(record, 0) == entry['item_id']
            for offset in totals:
                totals[offset] += i32(record, offset)
            used.append(dict(group_index=group['group_index'], **entry))
    t = totals
    hp_pct = idiv((i32(header, 0x34) + t[0x11]) * t[0x35], 100)
    mp_pct = idiv((i32(header, 0x3c) + t[0x19]) * t[0x3d], 100)
    link = {address(n): 0 for n in LINK_FIELDS}
    for n, value in ((0x04f99088,t[0x0d]+hp_pct),(0x04f9908c,t[0x11]+hp_pct),
                     (0x04f99090,t[0x15]+mp_pct),(0x04f99094,t[0x19]+mp_pct)):
        link[address(n)] = value
    for n, base, additive, pct in ((0x04f99098,0x40,0x1d,0x41),(0x04f9909c,0x48,0x21,0x45),
                                 (0x04f990a0,0x50,0x25,0x49),(0x04f990a4,0x58,0x29,0x4d)):
        link[address(n)] = t[additive] + idiv((i32(header,base)+t[additive])*t[pct],100)
    # Native other-stat percentage unusually uses attack additive, preserved.
    link[address(0x04f990a8)] = t[0x2d] + idiv((i32(header,0xb8)+t[0x1d])*t[0x51],100)
    for n, offset in ((0x04f990d0,0x55),(0x04f990d4,0x59),(0x04f990d8,0x5d),(0x04f990dc,0x61)):
        link[address(n)] = t[offset]
    for index in range(6): link[address(0x04f990e0+index*4)] = t[0x65+index*4]
    return link, dict(source='verified saved equipped instances',procedure='0x47CC30',
                      evidence=[EVIDENCE['equipment']],used_entries=used,
                      item_sums_by_offset={hex(k):v for k,v in totals.items()},
                      current_and_max_hp_percent_term=hp_pct,current_and_max_mp_percent_term=mp_pct)

def skill_record(alias, actor_id, raw, offset, index, path, actions, impact_index):
    assert len(raw) == 0x41d
    impact = bytes.fromhex(actions[impact_index]['raw_hex'])
    mp_delta = i32(raw, 0x14f)
    return dict(id=alias,actor_id=actor_id,name=raw[1:0x15].split(b'\0')[0].decode('cp936'),
                original_id_raw=raw[0],original_skill_index=index,fixed_raw_hex=raw.hex(),fixed_bytes=0x41d,
                memory_stride_bytes=0x421,memory_stride_limit='Extra 4-byte action pointer is not serialized and is not fabricated.',
                mp_cost=max(0,-mp_delta),mp_delta_raw=mp_delta,
                mp_cost_source=dict(skill_relative_offset=0x14f,file_offset=offset+0x14f,
                    procedure='0x501AA0',rule='For player-side skill start and global gate 0, a negative signed delta is added to raw MP at 0x0524A709. These two deltas are zero.',
                    evidence=[EVIDENCE['mp_cost'],EVIDENCE['skill_start']]),
                eligibility=dict(learned_flag_raw=raw[0x23],type_flags_raw=u32(raw,0x32),
                    menu_type_raw=u32(raw,0x32)&0xf,required_role_level_raw=u32(raw,0x143),
                    scope='Bounded learned direct action; the complete player menu and equipment-specific command tree are not reconstructed.'),
                action_mask_raw=impact[0x78],class_raw=impact[0x24],impact_action_index=impact_index,
                actions=actions,source=source(path,fixed_record_offset=offset,fixed_bytes=0x41d),
                evidence=[EVIDENCE['skill_start'],EVIDENCE['mp_cost'],EVIDENCE['class'],EVIDENCE['effective']])

def actor_record(id_, side, header, path, offset, link, selected_skill, equipment=None):
    role = 1 if side == 'player' else 12
    values = {address(HEADER_BASE+o):i32(header,o) for o in HEADER_FIELDS}
    hp_bonus, hp_max_bonus = link[address(0x04f99088)], link[address(0x04f9908c)]
    mp_bonus, mp_max_bonus = link[address(0x04f99090)], link[address(0x04f99094)]
    raw_hp,raw_mp = i32(header,0x30),i32(header,0x38)
    return dict(id=id_,side=side,name=header[4:24].split(b'\0')[0].decode('cp936'),level=u32(header,0x24),
        hp=dict(current=max(0,raw_hp+hp_bonus),maximum=i32(header,0x34)+hp_max_bonus),
        mp=dict(current=max(0,raw_mp+mp_bonus),maximum=i32(header,0x3c)+mp_max_bonus),
        raw_hp=raw_hp,raw_mp=raw_mp,raw_hp_maximum=i32(header,0x34),raw_mp_maximum=i32(header,0x3c),
        resource_bonuses=dict(hp_current=hp_bonus,hp_maximum=hp_max_bonus,mp_current=mp_bonus,mp_maximum=mp_max_bonus),
        raw_by_address=values,status_by_address={address(n):0 for n in STATUS_FIELDS},linked_by_address=link,
        state_raw=0,side_raw=header[0x19],role_link_raw=role,stance_raw=1,
        class_raw=selected_skill['class_raw'],action_mask_raw=selected_skill['action_mask_raw'],
        settled_raw=0,immune_raw=0,reaction_inhibit_raw=0,defense_half_raw=0,
        current_skill=selected_skill,header_raw_hex=header.hex(),equipment=equipment,
        initialization=dict(authority='controlled development fixture with recovered source fields',
            native_header_base=address(HEADER_BASE),side_source_header_offset=0x19,
            conditions={'battle_state':'alive / 0','status_table':'fresh all-zero controlled table',
                        'stance':'neutral stance 1 (0x41C610 native multiplier row is all zero)',
                        'reaction_and_immunity_gates':'zero controlled fresh-action gates',
                        'class':'selected action +0x24, written by 0x50E980',
                        'role_link':'player saved slot 1; enemy controlled battle array slot 1 + 11'},
            limit='This is assembled battle input, not a captured running original battle.'),
        source=source(path,header_offset=offset,header_bytes=0x30b),evidence=[EVIDENCE['effective'],EVIDENCE['display'],EVIDENCE['class']])

def export():
    before = {path:digest(ROOT/path) for path in EXPECTED}
    assert before == EXPECTED, 'Combat source fingerprints changed'
    data = (ROOT/'save_analysis_20261010/verified_level12_SaveGame0.Dat').read_bytes()
    layout = complete_layout(data)
    assert layout['reaches_eof'] and layout['parsed_end'] == len(data)
    saved = layout['characters'][0]
    player_header = data[saved['header_offset']:saved['header_offset']+0x30b]
    player_chr,enemy_chr = CHR(ROOT/'Fight_Role/001.CHR'),CHR(ROOT/'Fight_Role/012.CHR')
    assert saved['level'] == 12 and saved['name'] == '英格妮' and enemy_chr.name == '雪泥怪'
    selected = saved['skills'][22]; offset=selected['record_offset']
    actions = []
    for index in range(selected['action_record_count']):
        start = offset + 0x41d + index * 0xb0
        raw = data[start:start+0xb0]
        actions.append(dict(index=index,offset=start,bytes=0xb0,type_raw=raw[0],
                            u32_at_0x01_raw=u32(raw,1),raw_hex=raw.hex()))
    assert [item['raw_hex'] for item in actions] == [item['raw_hex'] for item in player_chr.skills[22]['actions']], 'Saved and CHR animation action records differ'
    yantu = skill_record('yantu','001',data[offset:offset+0x41d],offset,22,
                         ROOT/'save_analysis_20261010/verified_level12_SaveGame0.Dat',actions,3)
    es=enemy_chr.skills[14]
    snow = skill_record('snow_attack','012',bytes.fromhex(es['fixed_raw_hex']),es['offset'],14,
                        enemy_chr.path,es['actions'],1)
    assert yantu['mp_cost'] == snow['mp_cost'] == 0
    assert yantu['eligibility']['learned_flag_raw'] == snow['eligibility']['learned_flag_raw'] == 1
    link,equipment = equipment_table(player_header,describe_equipment(ROOT/'save_analysis_20261010/verified_level12_SaveGame0.Dat')['roles'][0])
    assert [link[address(n)] for n in (0x4f99088,0x4f9908c,0x4f99090,0x4f99094,0x4f99098,0x4f9909c,0x4f990a4,0x4f990d0,0x4f990e0,0x4f990e4)] == [96,96,7,7,3,0,23,10,190,30]
    actors=[actor_record('001','player',player_header,ROOT/'save_analysis_20261010/verified_level12_SaveGame0.Dat',saved['header_offset'],link,yantu,equipment),
            actor_record('012','enemy',enemy_chr.header,enemy_chr.path,8,{address(n):0 for n in LINK_FIELDS},snow)]
    result=dict(schema='seventh-seal-combat-sample',version=1,id='controlled-ingni-snow-turn',
        actors=actors,skills=dict(yantu=yantu,snow_attack=snow),order=['001','012'],enemy_skill_id='snow_attack',
        source=dict(game=source(ROOT/'GAME.exe'),required_world_source=source(ROOT/'save_analysis_20261010/verified_level12_SaveGame0.Dat'),
            authority='static reconstruction and explicitly controlled development initialization',
            scope='One saved level-12 player versus CHR-defined snow monster with one fixed learned action; this is not the actual forest encounter group.',
            original_game_executed=False,
            order=dict(policy='controlled alternating dual-action test loop',actors=['001','012'],
                selector_reachable_conditions='0x5036D0 allows loaded, alive, enabled, delay-zero actors whose gauges reach the threshold; with both sides ready and initial side preference 0 a queued player can precede an enemy.',
                original_scheduler='0x502F30 updates gauges and delay; 0x5036D0 chooses highest eligible gauge and alternates preferred side when multiple actors are ready. The complete live gauge scheduler is not integrated.',
                evidence=[EVIDENCE['selector'],EVIDENCE['gauge']]),
            enemy_selection=dict(policy='fixed skill index 14 for this controlled test',
                raw_learned_flag=1,raw_type=1,raw_weight=bytes.fromhex(es['fixed_raw_hex'])[0x27],
                original_policy='0x5029A0 includes weighted skills and a random combo branch; no claim that native AI always chooses this skill.',evidence=[EVIDENCE['enemy_ai']]),
            world_mapping=dict(policy='World current HP/MP are stored raw uint32 bit patterns; battle resources add recovered linked equipment bonuses. Signed raw HP is represented as uint32 on world commit and decoded with |0 on re-entry.',
                hp_raw_address='0x0524a701',hp_maximum_address='0x0524a705',mp_raw_address='0x0524a709',mp_maximum_address='0x0524a70d',
                hp_current_bonus=96,mp_current_bonus=7,death_raw_hp=-96,death_world_hp_uint32=4294967200,
                limits='Fixture only accepts the verified player level, attribute ranges, stored maxima and historical source fingerprint; fresh battle statuses and stance are controlled.',
                evidence=[EVIDENCE['hp_getter'],EVIDENCE['hp_commit'],EVIDENCE['display'],EVIDENCE['mp_getter'],EVIDENCE['equipment']]),
            evidence_bundle='remake/runtime/evidence/turn_actor_native_20261011.json',
            limitations=['Native gauge timing, complete AI, combo selection, encounter loading, rewards and new-game initialization remain outside this slice.',
                         'Source CHR 001 defaults are level 11; player battle values instead follow the level-12 saved header and equipped item instances.',
                         'No original battle was executed; all tests are reconstruction tests.']))
    assert {path:digest(ROOT/path) for path in EXPECTED} == before
    output=RUNTIME/'web/data/combat_sample.json'; output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    report=dict(source_fingerprints=before,source_unchanged=True,save_parser_reaches_eof=True,
        chr_parser_reaches_eof={r.path.name:r.parsed_end==len(r.data) for r in (player_chr,enemy_chr)},
        equipment_linked_table=link,player_effective_hp=actors[0]['hp'],player_effective_mp=actors[0]['mp'],
        enemy_hp=actors[1]['hp'],enemy_mp=actors[1]['mp'],mp_costs={k:v['mp_cost'] for k,v in result['skills'].items()},
        player_stored_header_offset=saved['header_offset'],player_skill_offset=offset,enemy_skill_offset=es['offset'],
        scheduler_scope=result['source']['order'],evidence=EVIDENCE)
    report_path=RUNTIME/'evidence/combat_sample_export_20261011.json'
    report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:report[k] for k in ('source_unchanged','save_parser_reaches_eof','player_effective_hp','player_effective_mp','enemy_hp','enemy_mp','mp_costs')},ensure_ascii=False))

if __name__ == '__main__': export()
