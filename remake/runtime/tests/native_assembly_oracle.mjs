/** Bounded interpreter for the REA-produced x86 instruction text of the
 * numeric functions under test. It consumes the retained instruction list,
 * not the reimplementation's formulas. External record-copy/display/clock
 * calls are explicit hooks; original gameplay, graphics and OS are not run.
 */
export class NativeAssemblyOracle {
  constructor(functions,actors,rng){
    this.code=new Map();for(const lines of Object.values(functions))for(const line of lines){if(!line.trim())continue;const m=line.match(/^(0x[0-9a-f]+): (\S+)(?: (.*))?$/);if(!m)throw Error(line);this.code.set(parseInt(m[1],16),{op:m[2],args:m[3]??''});}
    this.addresses=[...this.code.keys()].sort((a,b)=>a-b);this.next=new Map(this.addresses.slice(0,-1).map((a,i)=>[a,this.addresses[i+1]]));this.mem=new Map();this.reg={EAX:0,EBX:0,ECX:0,EDX:0,ESI:0,EDI:0,ESP:0x10000000,EBP:0};this.actors=actors;this.rng=rng;this.rng_calls=[];this.flags=0;this.zero=true;this.trace=[];
    actors.forEach((a,i)=>{for(const table of [a.raw_by_address,a.status_by_address])for(const [addr,value]of Object.entries(table))this.write(Number(addr)+i*0x30274,value);const bytes={0x521a77b:a.state_raw,0x521a77c:a.side_raw,0x521f5f5:a.immune_raw,0x521f69d:a.settled_raw,0x524a633:a.class_raw,0x521f684:a.defense_half_raw};for(const [addr,value]of Object.entries(bytes))this.write(Number(addr)+i*0x30274,value,1);this.write(0x521f69e+i*0x30274,a.reaction_inhibit_raw);this.write(0x524a9d0+i*0x30274,a.role_link_raw);this.write(0x524a9d4+i*0x30274,a.stance_raw);for(const [addr,value]of Object.entries(a.linked_by_address))this.write(Number(addr)+Math.max(0,a.role_link_raw-1)*0xd0,value);});
    for(const n of [0x055ee004,0x02b421e0])this.write(n,0);
  }
  read(a,n=4){let v=0;for(let i=0;i<n;i++)v=(v+(this.mem.get((a+i)>>>0)??0)*2**(i*8))>>>0;return n===4?v|0:v;}
  write(a,v,n=4){v>>>=0;for(let i=0;i<n;i++)this.mem.set((a+i)>>>0,(v>>>(i*8))&255);}
  regRead(s){if(s in this.reg)return this.reg[s];const r={AL:['EAX',0],AH:['EAX',8],CL:['ECX',0],DL:['EDX',0]}[s];if(!r)throw Error(`Unknown register ${s}`);return(this.reg[r[0]]>>>r[1])&255;}
  regWrite(s,v){if(s in this.reg){this.reg[s]=v|0;return;}const r={AL:['EAX',0],AH:['EAX',8],CL:['ECX',0],DL:['EDX',0]}[s];if(!r)throw Error(s);this.reg[r[0]]=(this.reg[r[0]]&~(255<<r[1]))|((v&255)<<r[1]);}
  address(expr){return expr.replace(/\s+/g,'').split('+').reduce((sum,part)=>{const terms=part.split('*');const get=v=>/^[A-Z]+$/.test(v)?this.regRead(v):v.startsWith('-0x')?-parseInt(v.slice(3),16):Number(v);return(sum+get(terms[0])*(terms.length>1?get(terms[1]):1))>>>0;},0);}
  value(s){s=s.trim();const mem=s.match(/^(?:(byte|dword) ptr )?\[(.*)\]$/);if(mem)return this.read(this.address(mem[2]),mem[1]==='byte'?1:4);if(/^[A-Z]+$/.test(s))return this.regRead(s);if(s.startsWith('-0x'))return-parseInt(s.slice(3),16);const n=Number(s);if(!Number.isFinite(n))throw Error(`Bad operand ${s}`);return n|0;}
  assign(s,v){s=s.trim();const mem=s.match(/^(?:(byte|dword) ptr )?\[(.*)\]$/);if(mem)this.write(this.address(mem[2]),v,mem[1]==='byte'?1:4);else this.regWrite(s,v);}
  push(v){this.reg.ESP=(this.reg.ESP-4)|0;this.write(this.reg.ESP,v);}
  pop(){const v=this.read(this.reg.ESP);this.reg.ESP=(this.reg.ESP+4)|0;return v;}
  external(target){const arg=i=>this.read(this.reg.ESP+i*4);
    if(target===0x571590){this.reg.ESP=(this.reg.ESP-this.reg.EAX)|0;return;}
    if(target===0x570520||target===0x5042f0||target===0x504b80)return;
    if(target===0x53245d){this.reg.EAX=0;return;}
    if(target===0x500350){const a=this.actors[arg(0)],offset=arg(0)*0x30274;this.reg.EAX=(this.read(0x524a701+offset)+((a.side_raw&&a.role_link_raw)?a.linked_by_address['0x04f99088']:0))|0;return;}
    if(target===0x5003f0){const a=this.actors[arg(0)];this.reg.EAX=(a.side_raw&&a.role_link_raw)?a.linked_by_address['0x04f99088']:0;return;}
    if(target===0x500700)return; // Exact retained assembly jumps directly to epilogue.
    if(target===0x4ffd40){this.write(0x521a77b+arg(0)*0x30274,4,1);return;} // Observe death dispatch/state only.
    if(target===0x571060){this.reg.EAX=this.rng();this.rng_calls.push(this.reg.EAX);return;}
    if(target===0x501930||target===0x501870){const actor=this.actors[arg(1)],hex=actor.current_skill.fixed_raw_hex;for(let i=0;i<hex.length/2;i++)this.write(arg(0)+i,parseInt(hex.slice(i*2,i*2+2),16),1);this.reg.EAX=arg(0);return;}
    if(target===0x5017b0){for(let i=0;i<0xb0;i++)this.write(arg(0)+i,0,1);this.write(arg(0)+0x78,this.actors[arg(1)].action_mask_raw,1);this.reg.EAX=arg(0);return;}
    throw Error(`Unhooked external ${target.toString(16)}`);
  }
  run(entry,args){this.reg.ESP=0x10000000;for(const arg of [...args].reverse())this.push(arg);this.push(0x7fffffff);let pc=entry;let steps=0;
    while(pc!==0x7fffffff){if(++steps>250000)throw Error('Oracle step bound exceeded');const inst=this.code.get(pc);if(!inst)throw Error(`Missing ${pc.toString(16)}`);let next=this.next.get(pc);const [d,s,t]=inst.args.split(',').map(x=>x.trim());const v=()=>this.value(s);const left=()=>this.value(d);switch(inst.op){
      case'PUSH':this.push(left());break;case'POP':this.assign(d,this.pop());break;case'MOV':this.assign(d,v());break;
      case'LEA':this.assign(d,this.address(s.slice(1,-1)));break;case'MOVSX':{let x=v();if(s.startsWith('byte ptr')&&x&128)x-=256;this.assign(d,x);break;}
      case'ADD':this.assign(d,(left()+v())|0);break;case'SUB':this.assign(d,(left()-v())|0);break;case'AND':this.assign(d,left()&v());break;case'OR':this.assign(d,left()|v());break;case'XOR':this.assign(d,left()^v());break;
      case'NEG':this.assign(d,(-left())|0);break;
      case'IMUL':this.assign(d,Math.imul(t?this.value(s):left(),this.value(t??s)));break;
      case'SAR':this.assign(d,left()>>v());break;case'SHR':this.assign(d,left()>>>v());break;
      case'CDQ':this.reg.EDX=this.reg.EAX<0?-1:0;break;
      case'IDIV':{const n=(BigInt(this.reg.EDX)<<32n)+BigInt(this.reg.EAX>>>0),den=BigInt(left());if(den===0n)throw Error('IDIV zero');const q=n/den,r=n%den;if(q< -2147483648n||q>2147483647n)throw Error('IDIV overflow');this.reg.EAX=Number(q);this.reg.EDX=Number(r);break;}
      case'DIV':{const n=(BigInt(this.reg.EDX>>>0)<<32n)+BigInt(this.reg.EAX>>>0),den=BigInt(left()>>>0);const q=n/den,r=n%den;if(q>4294967295n)throw Error('DIV overflow');this.reg.EAX=Number(q)|0;this.reg.EDX=Number(r)|0;break;}
      case'CMP':this.flags=BigInt(left())-BigInt(v());this.unsignedFlags=BigInt(left()>>>0)-BigInt(v()>>>0);this.zero=this.flags===0n;break;case'TEST':this.flags=BigInt(left()&v());this.unsignedFlags=this.flags;this.zero=this.flags===0n;break;
      case'JC':if(this.unsignedFlags<0n)next=left()>>>0;break;case'JBE':if(this.unsignedFlags<=0n)next=left()>>>0;break;case'JA':if(this.unsignedFlags>0n)next=left()>>>0;break;case'JNC':case'JAE':if(this.unsignedFlags>=0n)next=left()>>>0;break;case'SETZ':this.assign(d,this.zero?1:0);break;case'SETNZ':this.assign(d,this.zero?0:1);break;
      case'JMP':next=left()>>>0;break;case'JZ':if(this.zero)next=left()>>>0;break;case'JNZ':if(!this.zero)next=left()>>>0;break;case'JG':if(this.flags>0n)next=left()>>>0;break;case'JGE':if(this.flags>=0n)next=left()>>>0;break;case'JL':if(this.flags<0n)next=left()>>>0;break;case'JLE':if(this.flags<=0n)next=left()>>>0;break;
      case'STOSD.REP':while(this.reg.ECX){this.write(this.reg.EDI,this.reg.EAX);this.reg.EDI=(this.reg.EDI+4)|0;this.reg.ECX--;}break;
      case'MOVSD.REP':while(this.reg.ECX){this.write(this.reg.EDI,this.read(this.reg.ESI));this.reg.EDI=(this.reg.EDI+4)|0;this.reg.ESI=(this.reg.ESI+4)|0;this.reg.ECX--;}break;
      case'MOVSB':this.write(this.reg.EDI,this.read(this.reg.ESI,1),1);this.reg.EDI++;this.reg.ESI++;break;
      case'CALL':{let target=left()>>>0;target=({0x401ef1:0x41c610,0x4011db:0x41cfe0})[target]??target;if(target!==0x571060&&this.code.has(target)){this.push(next);next=target;}else this.external(target);break;}
      case'RET':next=this.pop()>>>0;break;default:throw Error(`Unsupported ${inst.op}`);
    }pc=next;}
    return {eax:this.reg.EAX,steps,rng_calls:this.rng_calls};
  }
}
