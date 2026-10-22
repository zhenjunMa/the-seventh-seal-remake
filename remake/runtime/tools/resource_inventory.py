"""Read-only resource/PE inventory; does not decode custom asset formats."""
from pathlib import Path
from collections import defaultdict
import struct, hashlib, re, json

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parents[1] / 'evidence'
u16 = lambda b,p: struct.unpack_from('<H',b,p)[0]
u32 = lambda b,p: struct.unpack_from('<I',b,p)[0]

groups = defaultdict(list)
dirs = ['Map','ROLE','Animate','anilink','mapm','Fight_Role','Fight_Bk','picture','sound','SYSTEM','font','Driver']
files = [p for p in ROOT.iterdir() if p.is_file() and p.suffix.lower() == '.dgp']
for d in dirs:
    files += [p for p in (ROOT/d).rglob('*') if p.is_file()]
for p in files:
    groups[(str(p.relative_to(ROOT).parent),p.suffix.lower())].append(p)
inventory = []
for (d,e),ps in sorted(groups.items()):
    samples=[]
    for p in sorted(ps)[:2]:
        with p.open('rb') as f: h=f.read(128)
        samples.append(dict(path=str(p.relative_to(ROOT)), size=p.stat().st_size,
          header_hex=h[:64].hex(' '), header_ascii=''.join(chr(c) if 32<=c<127 else '.' for c in h[:64]),
          first_16_u32=[u32(h,i) for i in range(0,min(64,len(h)//4*4),4)]))
    inventory.append(dict(directory=d,extension=e,count=len(ps),bytes=sum(p.stat().st_size for p in ps),samples=samples))

b=(ROOT/'GAME.exe').read_bytes()
pe=u32(b,0x3c); coff=pe+4; opt=coff+20; magic=u16(b,opt)
assert b[pe:pe+4]==b'PE\0\0' and magic==0x10b
nsects=u16(b,coff+2); base=u32(b,opt+28); sections=[]
for i in range(nsects):
    off=opt+u16(b,coff+16)+i*40
    sections.append(dict(name=b[off:off+8].split(b'\0')[0].decode('ascii','replace'),
      virtual_size=u32(b,off+8),rva=u32(b,off+12),raw_size=u32(b,off+16),raw_offset=u32(b,off+20)))
def fileoff(rva):
    for s in sections:
        if s['rva']<=rva<s['rva']+s['raw_size']:
            return s['raw_offset']+rva-s['rva']
    if rva<u32(b,opt+60): return rva
    raise ValueError(hex(rva))
def zstr(off): return b[off:b.index(0,off)].decode('ascii','replace')
imports=[]
ip=fileoff(u32(b,opt+104)); i=0
while any(b[ip+i*20:ip+(i+1)*20]):
    off=ip+i*20; orig=u32(b,off); name=zstr(fileoff(u32(b,off+12))); thunk=fileoff(orig or u32(b,off+16)); symbols=[]; j=0
    while (v:=u32(b,thunk+j*4)):
        symbols.append(dict(ordinal=v&0xffff) if v&0x80000000 else dict(name=zstr(fileoff(v)+2)))
        j+=1
    imports.append(dict(dll=name,symbols=symbols)); i+=1
strings=[]
for m in re.finditer(rb'[\x20-\x7e]{5,}',b):
    s=m.group().decode('ascii')
    if re.search(r'\.(dgp|ecp|stg|tlk|chr|rec|cap|mag|itm|anm|bik|pak|dat)\b|directdraw|directsound|directinput|script|opcode|command',s,re.I):
        strings.append(dict(file_offset=hex(m.start()),text=s[:500]))
evidence=[]
for p in sorted((ROOT/'save_analysis_20261010').glob('rea_*evidence.json')):
    j=json.loads(p.read_text('utf-8-sig'))
    evidence.append(dict(path=str(p.relative_to(ROOT)),sha256=hashlib.sha256(p.read_bytes()).hexdigest(),keys=list(j)))
result=dict(boundary='Filesystem metadata, raw headers, PE import descriptors, raw ASCII strings and prior evidence index only. No custom asset decoding or runtime observation.',
  binary=dict(path='GAME.exe',sha256=hashlib.sha256(b).hexdigest(),machine=hex(u16(b,coff)),image_base=hex(base),sections=sections,imports=imports,filtered_ascii_strings=strings),
  resource_groups=inventory, prior_evidence=evidence)
OUT.mkdir(parents=True, exist_ok=True)
(OUT/'resource_inventory.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),'utf-8')
print(json.dumps(dict(groups=[{k:v for k,v in g.items() if k!='samples'} for g in inventory],
  dlls=[dict(dll=i['dll'],count=len(i['symbols']),symbols=[s.get('name','ordinal '+str(s.get('ordinal'))) for s in i['symbols']]) if i['dll'].lower() not in ['kernel32.dll','user32.dll','gdi32.dll'] else dict(dll=i['dll'],count=len(i['symbols'])) for i in imports],
  strings=strings),ensure_ascii=False,indent=2))
