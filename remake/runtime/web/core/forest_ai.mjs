/** Pure selection port of GAME.exe 0x5029A0 / 0x5014C0.
 * No HP/MP strategy or skill execution is added. Raw status/target flags are
 * caller-owned native fields, separately initialized from reaction recovery.
 */
import {runtimeContent,requireRegisteredRoles} from './content_registry.mjs';
import {nativeLoadedSkillCodes} from './native_skill_loading.mjs';
const clone=value=>structuredClone(value);
function requireValue(ok,message){if(!ok)throw new TypeError(message);}
function integer(value,name,min=0,max=0xffffffff){requireValue(Number.isInteger(value)&&value>=min&&value<=max,`Invalid ${name}`);return value;}
function fixedView(skill){
  requireValue(typeof skill?.fixed_raw_hex==='string'&&/^([0-9a-f]{2}){1053}$/i.test(skill.fixed_raw_hex),'AI skill requires original fixed bytes');
  const bytes=Uint8Array.from(skill.fixed_raw_hex.match(/../g),h=>parseInt(h,16)),view=new DataView(bytes.buffer);
  return {index:integer(skill.index??skill.original_skill_index,'skill index',0,127),code:bytes[0x19],learned:bytes[0x23],target_side:bytes[0x25],weight:bytes[0x27],type:view.getUint32(0x32,true)&15};
}
function roleView(role,loadModeRaw=0){
  const count=integer(role?.skill_count,'skill count',0,127);
  requireValue(Array.isArray(role.skills)&&role.skills.length===count,'AI original skill table incomplete');
  const codes=nativeLoadedSkillCodes(role.skills,{modeRaw:loadModeRaw});
  const skills=role.skills.map((skill,index)=>({...fixedView(skill),code:codes[index]}));
  requireValue(skills.every((s,i)=>s.index===i),'AI source index ordering invalid');
  return skills;
}
function statusFlags(actor){
  const direct=actor?.status_flags_raw,address=actor?.status_by_address?.['0x0521f52a'];
  requireValue(direct!==undefined||address!==undefined,'AI status flags missing');
  if(direct!==undefined)integer(direct,'status_flags_raw');
  if(address!==undefined)integer(address,'status_by_address[0x0521f52a]');
  requireValue(direct===undefined||address===undefined||direct===address,'AI status flag representations differ');
  return direct??address;
}
function selectionActor(actor){return {side:integer(actor?.side_raw,'side_raw',0,255),flags:statusFlags(actor)};}
function targetActor(actor){
  requireValue(typeof actor?.id==='string'&&actor.id.length>0,'AI target actor id missing');
  return {id:actor.id,side:integer(actor.side_raw,'side_raw',0,255),category:integer(actor.state_raw,'state_raw',0,255),
    immune:integer(actor.immune_raw,'immune_raw',0,255),busy:integer(actor.reaction_busy_raw,'reaction_busy_raw',0,255)};
}
function targetRoster(actors){
  requireValue(Array.isArray(actors)&&actors.length<=20&&new Set(actors.map(a=>a.id)).size===actors.length,'AI target roster invalid');
  return actors.map(targetActor);
}
function draws(rng,trace){
  requireValue(typeof rng==='function','AI RNG missing');
  return(mod,label)=>{const raw=integer(rng(),'native RNG output',0,32767),value=raw%mod;trace.push({kind:'rng',label,raw,mod,value});return value;};
}
export function validateForestAIData(data,content=runtimeContent){
  requireValue(data?.schema==='seventh-seal-forest-ai'&&data.version===1&&data.source_hashes&&data.evidence?.['0x5029a0']&&data.evidence?.['0x5014c0'],'AI source metadata missing');
  requireRegisteredRoles(Object.keys(data.roles??{}),{side:'enemy',complete:true},content);
  for(const[id,role]of Object.entries(data.roles)){
    requireValue(role.id===id&&typeof role.header_raw_hex==='string'&&/^([0-9a-f]{2}){779}$/i.test(role.header_raw_hex),'AI source header missing');
    const skills=roleView(role),learned=skills.filter(s=>s.learned).map(s=>s.index);
    requireValue(learned.length>0&&Array.isArray(role.learned_indices)&&learned.join(',')===role.learned_indices.join(','),'AI learned source skills mismatch');
    if(role.ai_parameters){requireValue(Object.keys(role.ai_parameters).join(',')==='combination_chance_percent','AI parameter fields invalid');integer(role.ai_parameters.combination_chance_percent,'combination_chance_percent',0,100);}
  }
  requireValue(data.policy?.combination_parameter_skill_index===0,'AI combination parameter unsupported');
  return data;
}
export function selectNativeSkills({actor,role,rng,load_mode_raw=0}){
  const input=selectionActor(actor),skills=roleView(role,load_mode_raw),trace=[],draw=draws(rng,trace);
  const eligible=skill=>skill.learned&&(!(input.flags&2)||skill.type!==2);
  // This draw happens even when no skill can be selected.
  const combinationChance=role.ai_parameters?.combination_chance_percent??20;
  integer(combinationChance,'combination_chance_percent',0,100);
  if(draw(100,'combination-gate')<combinationChance){
    const candidates=skills.filter(skill=>eligible(skill)&&skill.code!==0);
    if(candidates.length>1){
      const count=draw(3,'combination-length')+3,codes=[];
      for(let i=0;i<count;i++)codes.push(candidates[draw(candidates.length,`combination-member-${i}`)].code);
      // 0x501E90 scans all source indices for each chosen code, retaining duplicates.
      const indices=codes.flatMap(code=>skills.filter(s=>s.code===code).map(s=>s.index));
      return {kind:'combination',native_return:1,skill_indices:indices,skill_codes:codes,
        parameter_skill_index:0,target_side_raw:skills[0].target_side,
        target_side_basis:'0x501E90 parameter skill index 0 +0x25',trace};
    }
  }
  const candidates=skills.filter(skill=>eligible(skill)&&skill.type!==0);
  if(!candidates.length)return {kind:'none',native_return:0,skill_indices:[],skill_codes:[],target_side_raw:null,trace};
  let selected;
  if(input.side!==0)selected=candidates[draw(candidates.length,'single-uniform')];
  else{
    const roll=draw(100,'single-weight'),intervals=[];let end=0;
    for(const skill of candidates){const start=end;end+=skill.weight;intervals.push({index:skill.index,start,end});if(selected===undefined&&roll>=start&&roll<end)selected=skill;}
    trace.push({kind:'weights',roll,intervals});
    if(!selected)selected=candidates[draw(candidates.length,'single-weight-fallback')];
  }
  return {kind:'single',native_return:1,skill_indices:[selected.index],skill_codes:[],
    parameter_skill_index:selected.index,target_side_raw:selected.target_side,
    target_side_basis:'0x501CC0 selected skill +0x25',trace};
}
export function selectNativeTarget({actors,actor_id,target_side_raw,rng}){
  const inputs=targetRoster(actors),index=inputs.findIndex(a=>a.id===actor_id);
  requireValue(index>=0,'AI acting actor missing');
  const flags=statusFlags(actors[index]),side=integer(target_side_raw,'target_side_raw',0,255),trace=[],draw=draws(rng,trace),acting=inputs[index];
  const candidates=inputs.map((a,i)=>({a,i})).filter(({a,i})=>a.category<4&&a.immune===0&&a.busy===0&&
    ((flags&16)?i!==index:(side===0?a.side!==acting.side:a.side===acting.side))).map(({a,i})=>({id:a.id,index:i}));
  if(!candidates.length)return {target_id:null,target_index:-1,candidates,trace};
  const chosen=candidates[draw(candidates.length,'target')];
  return {target_id:chosen.id,target_index:chosen.index,candidates,trace};
}
export function planForestEnemyAction({actors,actor_id,data,rng,load_mode_raw=0}){
  validateForestAIData(data);
  requireValue(Array.isArray(actors),'AI actor roster missing');
  const actor=actors.find(a=>a.id===actor_id),role=data.roles[actor?.resource_id??actor?.id];
  requireValue(role,'AI forest actor source missing');
  // Complete target snapshot is validated before the first selection RNG draw.
  targetRoster(actors);selectionActor(actor);draws(rng,[]);
  const selection=selectNativeSkills({actor,role,rng,load_mode_raw});
  if(selection.kind==='none')return {...selection,actor_id,target_id:null,target_index:-1,candidates:[]};
  const target=selectNativeTarget({actors,actor_id,target_side_raw:selection.target_side_raw,rng});
  return {...selection,...target,actor_id,trace:[...clone(selection.trace),...clone(target.trace)]};
}
