"""Compare the exported program against its bounded native TLK record flow."""
from pathlib import Path
import json
import struct

ROOT=Path(__file__).resolve().parents[3]
RUNTIME=ROOT/'remake/runtime'
EVENT=json.loads((RUNTIME/'web/data/events/detective.json').read_text(encoding='utf-8'))
TLK=(ROOT/'Map/m01030.TLK').read_bytes()
BASE=EVENT['source']['record_base']
SUPPORTED={19,20,21,22,23,24,25,26,27,80,81}
u32=lambda b,o:struct.unpack_from('<I',b,o)[0]
def bit(flags,index,number): return bool(flags[index] & (1 << ((number-1)&31)))

def raw_flow(flags):
    flags=list(flags);rid=80;spoken=[]
    for _ in range(100):
        if rid not in SUPPORTED: return spoken,flags,rid
        b=TLK[BASE+(rid-1)*0x66f:BASE+rid*0x66f]
        assert u32(b,0x23)==0
        if u32(b,0x2b): flags[u32(b,0x27) or 3] |= 1 << ((u32(b,0x2b)-1)&31)
        if b[0]==4:
            tests=[]
            for i in range(6):
                k=0x37+i*11
                assert b[k]==0
                number=u32(b,k+7)
                if number: tests.append(bit(flags,u32(b,k+2) or 3,number))
            rid=u32(b,0x2f) if all(tests) else u32(b,0x33)
            continue
        assert b[0]==0 and u32(b,0x17)==0
        number=u32(b,0x1f)
        if number and bit(flags,u32(b,0x1b) or 3,number):
            rid=u32(b,0x2f)
            if not rid: return spoken,flags,None
            continue
        if b[0x37]: spoken.append((rid,b[0x37:0x137].split(b'\0')[0].decode('gbk')))
        rid=u32(b,0x33)
        if not rid: return spoken,flags,None
    raise AssertionError('Raw sample does not terminate')

def vm_flow(flags):
    flags=list(flags);pc=0;spoken=[]
    for _ in range(100):
        c=EVENT['program'][pc];op=c['op']
        if op=='set_flag_bit': flags[c['index']] |= 1 << ((c['bit']-1)&31)
        elif op=='say': spoken.append((c['source']['record_id'],c['text']))
        elif op=='test_flag_bit':
            pc=c['if_true'] if bit(flags,c['index'],c['bit']) else c['if_false'];continue
        elif op=='test_all_flag_bits':
            pc=c['if_true'] if all(bit(flags,x['index'],x['bit']) for x in c['conditions']) else c['if_false'];continue
        elif op=='jump': pc=c['target'];continue
        elif op=='end': return spoken,flags,None
        elif op=='unsupported': return spoken,flags,c['source']['record_id']
        else: raise AssertionError(op)
        pc+=1
    raise AssertionError('Compiled sample does not terminate')

def main():
    # Preserve unrelated bits while setting explicit controlled preconditions.
    seed=json.loads((RUNTIME/'web/data/world_seed.json').read_text(encoding='utf-8'))['flags']
    flags=list(seed)
    for condition in EVENT['sample_initial_flags']:
        flags[condition['index']] &= ~(1 << (condition['bit']-1)) & 0xffffffff
    first=raw_flow(flags)
    assert first==vm_flow(flags)
    assert [x[0] for x in first[0]]==list(range(19,26)) and first[2] is None
    assert [(i,x,y) for i,(x,y) in enumerate(zip(flags,first[1])) if x!=y]==[(3,flags[3],flags[3]|4)]
    repeat=raw_flow(first[1])
    assert repeat==vm_flow(first[1])
    assert [x[0] for x in repeat[0]]==[26] and repeat[1]==first[1] and repeat[2] is None
    branches=[]
    for index,number,target in [(426,1,83),(107,1,65),(5,31,28)]:
        scenario=list(first[1]);scenario[index] |= 1 << (number-1)
        raw=raw_flow(scenario);assert raw==vm_flow(scenario) and raw[2]==target
        branches.append(dict(index=index,bit=number,rejected_record=target))
    assert u32(TLK,0x1a+19*4)==EVENT['entry_record_id']==80
    report=dict(first_dialogue_records=[x[0] for x in first[0]],repeat_dialogue_records=[x[0] for x in repeat[0]],
                changed_flags=[dict(index=3,before=flags[3],after=first[1][3])],repeat_changes=[],
                unsupported_branch_checks=branches,native_record_vs_program_match=True,
                scope='Differential raw-record/compiled-program control-flow check; not original-game execution comparison.')
    (RUNTIME/'evidence/npc_verification_20261011.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report))

if __name__=='__main__': main()
