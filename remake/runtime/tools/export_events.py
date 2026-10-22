"""Export one bounded native TLK event. Original inputs are read-only.

The full NPC entry is retained; branches outside the recovered sample fail
explicitly. This is neither a TLK VM for every command nor a new-game seed.
"""
from pathlib import Path
import hashlib
import json
import struct
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
RUNTIME = ROOT / 'remake/runtime'
sys.path.insert(0, str(ROOT / 'remake/prototype/tools'))
from dgp import DGP
from map_objects import MapObjects
from PIL import Image

E = {
    'loader': 'ev_5e8b2970ad7fd9a51d0b4085cf684c21860c22ae04bec8712cdaf84c11e56eea',
    'record': 'ev_63a239118d571c40e001f04d25eb6688e64ee7466487a1626d48fdab812a257b',
    'index': 'ev_cc6cf47e0e22152bcfa459b8b4a92a419ffd25fc7897e151c1bced7e2c36a385',
    'interaction': 'ev_46b49ffe18c24e84d0114934087a847605f367e5188c6f40c6e55da3e90a3576',
    'resolve': 'ev_e14d28c11ec31e5eebdf4c08a994a900102658650d8e5364d58b848cbd114ea7',
    'all_conditions': 'ev_32db520615254c07ca1b1f5be84def5bd3946a60f19bb52b183994a544640759',
    'test_bit': 'ev_355033370cd2b94e5b494b774d1ed2a2a16245dbaf89d4c942e5c40b37f448d0',
    'set_bit': 'ev_060c9d4bcba5e8bc11e3444fa21c68df929f22ac70f38e6fe9cd7269d8c04d0f',
    'entry_mutation_bytes': 'ev_bf9af000fbc18c6f6eac561f0f48cc7069f26b2dea7441564896eb1ba836a96f',
    'entry_mutation_table': 'ev_7b9ea86472664085b6d45fcd9728e222140632969c2551ba92b4fb40d5f31e0a',
    'deferred_mutation': 'ev_7e97ec6e97d27593180e152a74f6b8e150c4eb65bac1b0375c3b4964174c4764',
    'text': 'ev_208aa985aa8dfd71196424202a3ce88f20eb321a18b0c86bf8b19bc445aaa066',
    'role_read': 'ev_2888b25485bd9e11fe0810b0a7a279f9c4ab59a54405fc65518a2f4ae5fd659a',
    'role_init': 'ev_cc8392615a7d78e2d6d4cc2dbfbc632ed4e69ade06250acba27d0a0c5a951b2b',
    'role_resource': 'ev_2e8ee10d305ee8113511d6ac354fad72c58c62e7d613e3d6f28da6a78a0c904c',
}

def u32(data, offset): return struct.unpack_from('<I', data, offset)[0]
def sha(data): return hashlib.sha256(data).hexdigest()
def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

def export():
    exe = (ROOT/'GAME.exe').read_bytes()
    assert sha(exe) == 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18'
    tlk_path = ROOT/'Map/m01030.TLK'
    dat_path = ROOT/'Map/m01030.dat'
    tlk = tlk_path.read_bytes()
    objects = MapObjects(dat_path)
    dat = objects.data
    assert u32(tlk, 2) == 500 and u32(tlk, 6) == 98
    assert dat[0x86] == 28 and dat[0x142] == 3 and dat[0x145] == 1
    map_index = u32(dat, 0x92)
    assert map_index == 3
    npc_slot = 19  # Runtime role indexes are zero-based; TLK speakers are +1.
    npc_offset = objects.object_end + (npc_slot-10)*0x4c5
    raw_npc = dat[npc_offset:npc_offset+0x4c5]
    assert u32(raw_npc, 0x28) == 70
    assert u32(tlk, 0x1a+npc_slot*4) == 80
    base = 0x1a + 500*4
    load_end = base+98*0x66f
    records = {}
    for rid in [19,20,21,22,23,24,25,26,27,80,81]:
        offset = base+(rid-1)*0x66f
        b = tlk[offset:offset+0x66f]
        assert u32(b, 0x13) == rid
        record = dict(id=rid, offset=offset, kind=b[0],style=b[1],speaker=u32(b,0x0f),
                      condition_type=u32(b,0x17),condition_index=u32(b,0x1b),condition_bit=u32(b,0x1f),
                      mutation_type=u32(b,0x23),mutation_index=u32(b,0x27),mutation_bit=u32(b,0x2b),
                      if_true=u32(b,0x2f),next=u32(b,0x33),raw_hex=b.hex())
        if b[0] == 4:
            record['conditions'] = []
            for n in range(6):
                k=0x37+n*0xb
                assert b[k] == 0
                record['conditions'].append(dict(index=u32(b,k+2) or map_index,bit=u32(b,k+7),
                                                source_offset=offset+k,raw_hex=b[k:k+0xb].hex()))
            record['text']=''
        else:
            assert b[0] == 0
            record['text']=b[0x37:0x137].split(b'\0')[0].decode('gbk','strict')
        assert record['condition_type']==0 and record['mutation_type']==0
        records[rid]=record

    # Label assembly keeps native record IDs distinct from zero-based VM PCs.
    program=[]
    labels={}
    fixups=[]
    def append(op, rid, fields=None, offset=0, evidence=None):
        record=records[rid]
        program.append(dict(op=op,**(fields or {}),
                            source=dict(path='Map/m01030.TLK',offset=record['offset']+offset,
                                        record_id=rid,record_offset=record['offset']),
                            evidence=evidence or [E['resolve'],E['record']]))
        return len(program)-1
    def jump(op,rid,fields,targets,evidence=None,offset=0):
        pc=append(op,rid,fields,offset,evidence)
        for field,target in targets.items(): fixups.append((pc,field,target))
        return pc
    for rid in [80,81,27,19,20,21,22,23,24,25,26]:
        labels[rid]=len(program)
        r=records[rid]
        if r['mutation_bit']:
            assert rid == 25 and r['mutation_index'] == 0 and r['mutation_bit'] == 3
            append('set_flag_bit',rid,dict(index=map_index,bit=r['mutation_bit']),0x23,
                   [E['resolve'],E['entry_mutation_bytes'],E['entry_mutation_table'],E['set_bit']])
        if r['kind']==4:
            conditions=[dict(index=x['index'],bit=x['bit']) for x in r['conditions'] if x['bit']]
            jump('test_all_flag_bits',rid,dict(conditions=conditions),
                 dict(if_true=r['if_true'],if_false=r['next']),
                 [E['resolve'],E['all_conditions'],E['test_bit']],0x37)
            continue
        if r['condition_bit']:
            # Native condition true jumps before text. A false condition with
            # text returns that same record; +0x33 follows after its dialogue.
            false_target=('text',rid) if r['text'] else r['next']
            jump('test_flag_bit',rid,dict(index=r['condition_index'] or map_index,bit=r['condition_bit']),
                 dict(if_true=r['if_true'],if_false=false_target),[E['resolve'],E['test_bit']],0x17)
        labels[('text',rid)]=len(program)
        if r['text']:
            speaker={1:'英格妮',2:'凯',20:'侦探'}.get(r['speaker'],f"角色槽 {r['speaker']}")
            append('say',rid,dict(speaker=speaker,speaker_slot=r['speaker'],text=r['text'],style_raw=r['style']),
                   0x37,[E['resolve'],E['text']])
        if r['next']:
            jump('jump',rid,{},dict(target=r['next']),offset=0x33)
        else: append('end',rid,offset=0x33)
    for rid in [83,65,28]:
        labels[rid]=len(program)
        # Preserve target bytes as evidence while refusing its unknown program.
        offset=base+(rid-1)*0x66f
        program.append(dict(op='unsupported',reason=f'原作记录 {rid} 超出本次恢复的侦探初次／重复交互样本',
                            source=dict(path='Map/m01030.TLK',offset=offset,record_id=rid),
                            raw_hex=tlk[offset:offset+0x66f].hex(),evidence=[E['resolve'],E['record']]))
    for pc,field,target in fixups:
        assert target in labels
        program[pc][field]=labels[target]

    dgp=DGP(ROOT/'ROLE/070.DGP')
    a=dgp.actions[0]
    assert a['directions']==8 and a['frames_per_direction']==10 and a['first_frame']==0
    assets=RUNTIME/'web/assets/npcs/ROLE_070'
    assets.mkdir(parents=True,exist_ok=True)
    sheet=Image.new('RGBA',(dgp.width*a['frames_per_direction'],dgp.height*a['directions']))
    for direction in range(8):
        for frame in range(10):
            sheet.paste(dgp.decode(direction*10+frame),(frame*dgp.width,direction*dgp.height))
    sheet.save(assets/'action_00.png')
    x,y=struct.unpack_from('<ii',raw_npc,0x6f)
    npc=dict(id='M01030-role-19',name='侦探',slot_zero_based=npc_slot,speaker_slot_one_based=npc_slot+1,
             x=x*2,y=y*2,x_native=x,y_native=y,direction=raw_npc[0x45],
             source=dict(path='Map/m01030.dat',offset=npc_offset,bytes=0x4c5,sha256=sha(dat)),
             resource=dict(source='ROLE/070.DGP',sha256=dgp.sha256,
                           name_resource=dgp.metadata()['name_cp950'],sheet='assets/npcs/ROLE_070/action_00.png',
                           frame_width=dgp.width,frame_height=dgp.height,directions=8,frames_per_direction=10,
                           first_frame=0,anchor_x=dgp.anchor_raw[0],anchor_y=dgp.anchor_raw[1],interval_ms=180),
             evidence=[E['role_read'],E['role_init'],E['role_resource'],E['interaction'],E['index']],
             limits=['Idle atlas is rendered from action 0; native NPC turning, idle timing and dynamic role occupancy need runtime comparison.'])
    event=dict(schema='seventh-seal-event',version=1,id='M01030-detective-first-contact',map_id='M01030',
               map_flag_index=map_index,npc=npc,entry_record_id=80,commit_policy='native-entry',program=program,
               sample_initial_flags=[dict(index=i,bit=b,value=False) for i,b in [(426,1),(107,1),(3,3),(5,31)]],
               sample_initial_flags_scope='受控首次＋重复事件样本：仅清除所列位，其余世界状态保持；不是原作新游戏初值。',
               source=dict(path='Map/m01030.TLK',sha256=sha(tlk),bytes=len(tlk),
                           index_offset=0x1a+npc_slot*4,index_slot=npc_slot,record_bytes=0x66f,
                           record_base=base,native_loader_end=load_end,unexplained_tail_bytes=len(tlk)-load_end),
               records=records,labels={str(k):v for k,v in labels.items() if isinstance(k,int)},
               expected=dict(first_dialogue_records=list(range(19,26)),repeat_dialogue_records=[26],
                             changed_flag=dict(index=3,bit=3,mask=4)),
               evidence=list(E.values()),
               limitations=['Static resource/code reconstruction; original gameplay/video comparison remains pending.',
                            'TLK trailing payload remains unexplained and is not executed.',
                            'Record branches 28, 65 and 83 are source-preserved but not implemented.',
                            'GBK decodes the shipped simplified-Chinese text; DGP metadata uses CP950.',
                            'The +0x23 dispatcher decompilation fails; case 0 is derived from retained exact native bytes and its resolved flag setter.',
                            'No portrait, audio, conversation camera, native walking-to-NPC or exact bubble placement is restored.'])
    out=RUNTIME/'web/data/events/detective.json'
    write(out,event)
    report=dict(schema='npc-event-export-evidence',version=1,event_path=out.relative_to(RUNTIME).as_posix(),
                source_hashes={p:sha((ROOT/p).read_bytes()) for p in ['GAME.exe','Map/m01030.dat','Map/m01030.TLK','ROLE/070.DGP']},
                source_unchanged=dat_path.read_bytes()==dat and tlk_path.read_bytes()==tlk and (ROOT/'GAME.exe').read_bytes()==exe,
                native_bundle='evidence/npc_native_20261011.json',conclusions={
                    'npc_index_binding':dict(observed='0x482990 passes zero-based role slot to 0x460E50; TLK index19 is record80',evidence=[E['interaction'],E['index']]),
                    'flag_layout':dict(observed='DWORD array indexed by numeric map ID; bit number is one-based; signed setter supports clear',evidence=[E['test_bit'],E['set_bit']]),
                    'repeat_branch':dict(observed='19 tests map3 bit3 before dialogue;25 sets it;26 is repeat text',evidence=[E['resolve'],E['set_bit'],E['all_conditions']]),
                    'mutation_entry_order':dict(derived='0x462600 copies record then calls0x461780; case0 reads by-value record+27/+2B and calls0x401EB5→0x4437B0',evidence=[E['resolve'],E['entry_mutation_bytes'],E['entry_mutation_table'],E['set_bit']])},
                unknowns=event['limitations'])
    write(RUNTIME/'evidence/npc_export_20261011.json',report)
    print(json.dumps(dict(event=event['id'],npc=[npc['x'],npc['y']],commands=len(program),source_unchanged=report['source_unchanged'])))

if __name__=='__main__': export()
