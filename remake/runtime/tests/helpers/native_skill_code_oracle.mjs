import {readFile} from 'node:fs/promises';
import {NativeAssemblyOracle} from '../native_assembly_oracle.mjs';
export const nativeSkillCodeSource=JSON.parse(await readFile(new URL('../fixtures/native_skill_code_source.json',import.meta.url),'utf8'));
export function loadedSkillCodeOracle(skills,{modeRaw=0}={}){
  const oracle=new NativeAssemblyOracle({loader:[...nativeSkillCodeSource.instructions,'0x4ff0bb: RET']},[],()=>{throw Error('CHR code loading does not draw RNG');});
  const frame=0x23000000,header=0x24000000,table=0x25000000;
  oracle.reg.EBP=frame;oracle.write(frame+0xc,header);oracle.write(header+0x30b,table);oracle.write(0x679c6c,modeRaw);
  // Original initialization at4FED7E. Each run isolates the complete body
  //4FF029..4FF0B6; counter and memory persist across source skill records.
  oracle.write(frame-0x10,0x61,1);
  skills.forEach((skill,index)=>{const bytes=Buffer.from(skill.fixed_raw_hex,'hex');for(let n=0;n<bytes.length;n++)oracle.write(table+index*0x421+n,bytes[n],1);});
  for(let index=0;index<skills.length;index++){oracle.write(frame-0x14,index);oracle.run(0x4ff029,[]);}
  return {codes:skills.map((_,index)=>oracle.read(table+index*0x421+0x19,1)),rng_calls:oracle.rng_calls};
}
