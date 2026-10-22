/** Source-backed contact reactions from 0x50FA00 and its native callees.
 * Pure descriptors are produced after HP submission. The controller applies
 * the returned fields and plays every source action record independently.
 */
import {buildEffectiveAttributes,idiv} from './combat_rules.mjs';
import {runtimeContent,requireRegisteredRoles} from './content_registry.mjs';
const clone=structuredClone;
// Native source strings are immutable values. Bounded decoding reuse avoids
// parsing all 113 skill/action byte arrays again at every animation contact.
const decodedSourceBytes=new Map();
function requireValue(ok,message){if(!ok)throw new TypeError(message);}
function integer(n,name,min=-2147483648,max=2147483647){requireValue(Number.isInteger(n)&&n>=min&&n<=max,`Invalid ${name}`);return n;}
function bytes(raw,size,label){
  const saved=decodedSourceBytes.get(raw);if(saved?.length===size)return saved;
  requireValue(typeof raw==='string'&&new RegExp(`^([0-9a-f]{2}){${size}}$`,'i').test(raw),`Missing native ${label} bytes`);
  const value=Uint8Array.from(raw.match(/../g),h=>parseInt(h,16));if(decodedSourceBytes.size>=4096)decodedSourceBytes.clear();decodedSourceBytes.set(raw,value);return value;
}
function fixed(skill){return bytes(skill?.fixed_raw_hex,0x41d,'reaction skill');}
function roleFor(data,actor){const r=data.roles[actor?.resource_id??actor?.id];requireValue(r,'Reaction actor source missing');return r;}
function actorFlags(actor){
  const a=actor.status_flags_raw,b=actor.status_by_address?.['0x0521f52a'];
  requireValue(a!==undefined||b!==undefined,'Reaction status flags missing');
  if(a!==undefined)integer(a,'status_flags_raw',0,0xffffffff);if(b!==undefined)integer(b,'native status flags',0,0xffffffff);
  requireValue(a===undefined||b===undefined||a===b,'Reaction flag representations differ');return a??b;
}
function inputActor(actor){
  requireValue(typeof actor?.id==='string'&&actor.id.length>0,'Reaction actor id missing');
  requireValue(typeof actor.native_active==='boolean','Reaction native_active missing');
  requireValue(actor.current_target_id===null||typeof actor.current_target_id==='string','Reaction current_target_id missing');
  return {id:actor.id,current:fixed(actor.current_skill)[0],state:integer(actor.state_raw,'state_raw',0,255),
    immune:integer(actor.immune_raw,'immune_raw',0,255),flags:actorFlags(actor),
    special:integer(actor.reaction_special_gate_raw,'reaction_special_gate_raw'),z:integer(actor.native_z_raw,'native_z_raw')};
}
export function validateForestReactionsData(data,content=runtimeContent){
  requireValue(data?.schema==='seventh-seal-forest-reactions'&&data.version===1&&data.timing?.source_tick_ms===20,'Reaction source metadata missing');
  requireRegisteredRoles(Object.keys(data.roles??{}),{roster:data.party_native_bundle?'party-source-group':'forest-source-group'},content);
  for(const[id,r]of Object.entries(data.roles)){
    requireValue(r.id===id&&Array.isArray(r.skills)&&r.skills.length===r.skill_count,'Reaction skill table incomplete');
    for(const[sidx,s]of r.skills.entries()){
      const f=fixed(s);requireValue(s.original_skill_index===sidx&&s.original_id_raw===f[0]&&Array.isArray(s.actions)&&s.actions.length,'Reaction original skill ordering invalid');
      s.actions.forEach(a=>bytes(a.raw_hex,0xb0,'reaction action'));
    }
    for(const ident of [0,1,2,3,9,18,19])requireValue(r.skills.some(s=>s.original_id_raw===ident),'Required reaction id missing');
  }
  for(const address of ['0x50b520','0x41ef00','0x50b770','0x5016b0','0x51c640','0x50b3e0'])requireValue(data.evidence?.[address],'Reaction procedure evidence missing');
  requireValue(Object.values(data.roles).filter(r=>content.roles[r.id].side==='player').every(r=>r.skills.some(s=>s.original_id_raw===12))&&data.evidence?.['0x4ffe90'],'Death source evidence missing');
  return data;
}
function drawFactory(rng,trace){
  requireValue(typeof rng==='function','Reaction RNG missing');
  return(mod,label)=>{const raw=integer(rng(),'native RNG output',0,32767),value=raw%mod;trace.push({kind:'rng',label,raw,mod,value});return value;};
}
function sourceLookup(role,ident,draw){
  const candidates=role.skills.filter(s=>fixed(s)[0]===ident);
  // 0x5016B0 draws even for one cached/source candidate. The forest reaction
  // ids are singletons; the original source order remains explicit here.
  return candidates.length?candidates[draw(candidates.length,`reaction-id-${ident}`)]:null;
}
function resetAfter(target){return {reaction_busy_raw:0,native_after_raw:{'0x0521f5f7':0,'0x0521f5f6':0,'0x0521f5f8':0}};}
function descriptor(target,skill,policy,targetId,trace,data,reason,after=resetAfter(target)){
  const selected=skill?clone(skill):null;
  if(selected){after={...after,native_active:true,current_target_id:targetId,reaction_special_gate_raw:0,
    current_skill:clone(selected),class_raw:selected.actions[0].class_raw,action_mask_raw:selected.actions[0].action_mask_raw,
    native_after_raw:{...after.native_after_raw,'0x0521a778':1,'0x0524a656':selected.original_skill_index,
      '0x0524a657':0,'0x0521a7a1':0,'0x0521a7a5':0,'0x0521f692':0}};}
  return {kind:selected?(selected.original_id_raw===19?'counter':'response'):'none',actor_id:target.id,
    skill:selected,source_skill_index:selected?.original_skill_index??null,target_id:targetId,target_policy:policy,
    reason,after,trace,evidence:Object.values(data.evidence)};
}
function requireGrounded(t){if(t.special!==0||t.z!==0)throw new RangeError('Native 0x51CC00 airborne/special reaction dispatch is outside the grounded forest slice');}
/** 4FE300 is called in roster order by 50AC80. Lookup id11 once in the
 * controller, including the native draw for a singleton source candidate.
 * The actor's entry immunity/category block charging until its source ends.
 */
export function initializeNativeEntry({actor,data,rng}){
  validateForestReactionsData(data);inputActor(actor);const role=roleFor(data,actor),trace=[],draw=drawFactory(rng,trace),skill=sourceLookup(role,11,draw);
  if(!skill)return null;
  const after={state_raw:10,immune_raw:1,native_active:true,current_skill:clone(skill),class_raw:skill.actions[0].class_raw,action_mask_raw:skill.actions[0].action_mask_raw,
    native_after_raw:{'0x0521a77b':10,'0x0521f5f5':1,'0x0521a778':1,'0x0521f5f6':0,'0x0524a656':skill.original_skill_index,'0x0524a657':0,'0x0521a7a1':0,'0x0521a7a5':0,'0x0521f6b2':0,'0x0524a64b':0}};
  return {kind:'entry',actor_id:actor.id,skill:clone(skill),source_skill_index:skill.original_skill_index,target_id:actor.id,after,trace,
    evidence:['ev_058f6553bdbe4702f6c550168a98b6dc64a09c8af9b303cee8aa51e1f55f7695']};
}
/** 508BB0 mode3 requests 50E3A0(type14) before its recovery block / ranges.
 * The admitted revival transaction calls this at that exact point so its
 * source-animation lookup draw cannot trade places with recovery RNG.
 */
export function selectNativeRevivalAnimation({actor,data,rng}){
  validateForestReactionsData(data);const input=inputActor(actor),role=roleFor(data,actor),trace=[],draw=drawFactory(rng,trace);
  const skill=input.current===14?actor.current_skill:sourceLookup(role,14,draw);
  requireValue(skill,'Native revival animation id14 is missing');
  return {...descriptor(actor,skill,'preserve',actor.current_target_id,trace,data,'native-mode3-revival',{native_after_raw:{}}),kind:'revive'};
}
/** Caller commits returned after fields. Guard retains F68E including null;
 * dodge sets it to attacker even if its random counter check fails. No HP,
 * MP, gauge, target identity or caller-owned source record is mutated here.
 */
export function applyContactReaction({attacker,target,result,record,data,rng}){
  validateForestReactionsData(data);
  const a=inputActor(attacker),t=inputActor(target),role=roleFor(data,target),raw=bytes(record?.raw_hex,0xb0,'contact action'),trace=[],draw=drawFactory(rng,trace);
  integer(result?.damage,'resolved damage',0,2147483647);
  if(result.skipped||result.native_return===-1)return null;
  const reaction=integer(result.reaction,'outReaction',0,2),specialBranch=reaction!==0&&t.state<4;
  if(!specialBranch){
    if(result.damage===0||t.immune||t.state>4)return null;
    // Current forest contacts have +0x62=1; other source ids retain the same
    // normal selector, with original source index reads for the id5/id11 test.
    const ident=raw[0x62];requireValue(ident<role.skill_count,'Normal reaction source index invalid');
    if(ident===5&&(t.flags&0xe0))return null;
    requireGrounded({...t,special:0});
    const argumentId=fixed(role.skills[ident])[0];let wanted=ident;
    if([3,8,4].includes(t.current))wanted=argumentId===5?ident:3;
    else if([2,6,5].includes(t.current))wanted=argumentId===5?5:(argumentId===11||t.current===11?11:2);
    let selected=sourceLookup(role,wanted,draw);
    if(!selected&&[2,6,5].includes(t.current))selected=sourceLookup(role,5,draw);
    if(!selected)selected=sourceLookup(role,1,draw);
    requireValue(selected,'Normal native idle fallback is not implemented');
    const after=resetAfter(target);after.current_target_id=null;after.native_after_raw['0x0521f68e']=-1;
    return descriptor(target,selected,'clear',null,trace,data,'normal-contact',after);
  }
  if(reaction===1){
    const after=resetAfter(target),ident=raw[0x77];
    if(ident===0||t.current===19)return descriptor(target,null,'preserve',target.current_target_id,trace,data,'guard-current-skill-preserved',after);
    requireGrounded(t);
    const wanted=draw(10,'guard-response-choice')<7?ident:19,selected=sourceLookup(role,wanted,draw);
    requireValue(selected,'Guard native idle fallback is not implemented');
    return descriptor(target,selected,'preserve',target.current_target_id,trace,data,'guard-contact',after);
  }
  // 41EF00 evaluates the current target skill before 50B770 dispatch. The
  // source call is suppressed by action +0x48, without its probability draw.
  requireGrounded(t);let counter=0;
  if(raw[0x48]===0){
    const status=integer(target.status_by_address?.['0x0521f5a9'],'native counter status 0x0521f5a9');
    const side=integer(target.side_raw,'side_raw',0,255),link=integer(target.role_link_raw,'role_link_raw',0,2147483647);
    const bonus=side&&link?integer(target.linked_by_address?.['0x04f990dc'],'native counter equipment 0x04f990dc'):0;
    const effective=buildEffectiveAttributes(target,target.current_skill,rng);
    trace.push(...effective.trace.map(e=>({...clone(e),label:`dodge.${e.label}`})));
    const threshold=(idiv(Math.imul(effective.term3,1350),99900)+bonus+status)|0;
    const roll=draw(100,'dodge-counter'),blocked=[2,3,4,5,8].includes(t.current);
    counter=Number(roll<=threshold&&!blocked);trace.push({kind:'counter',term3:effective.term3,threshold,roll,blocked,counter});
  }
  if(t.immune)return descriptor(target,null,'attacker',attacker.id,trace,data,'dodge-immune-gate',{current_target_id:attacker.id,native_after_raw:{}});
  let wanted=counter?19:18;
  if(counter&&attacker.native_active&&a.current===19)wanted=18;
  const selected=sourceLookup(role,wanted,draw);requireValue(selected,'Dodge native idle fallback is not implemented');
  return descriptor(target,selected,'attacker',attacker.id,trace,data,wanted===19?'dodge-counter':'dodge-response');
}
/** 0x4FFE90 finalization, after the source-backed category4 HP submission and
 * its normal contact reaction. Status / death-skill and fade fields are returned
 * for the controller; resources, loot and victory dispatch belong elsewhere.
 * The caller controls preview timing of the independent death sequence.
 */
export function finalizeNativeDeath({actor,data,rng}){
  validateForestReactionsData(data);const a=inputActor(actor),role=roleFor(data,actor),trace=[],draw=drawFactory(rng,trace);
  if(a.state===5)return null;
  requireValue(a.state===4,'Death finalization requires native state4');
  if(a.z!==0)throw new RangeError('Native 0x5002B0 waits for grounded death finalization');
  const side=integer(actor.side_raw,'side_raw',0,255),status=clone(actor.status_by_address??{});
  // 0x507E20 zeros F52A(4 bytes), F52E..F5F3 and the native 100 status slots.
  for(const key of Object.keys(status)){const address=Number(key);if(address>=0x521f52a&&address<0x521f5f4)status[key]=0;}
  const after={state_raw:5,settled_raw:0,reaction_special_gate_raw:0,reaction_inhibit_raw:0,status_flags_raw:0,status_by_address:status,
    native_status_slots_cleared:true,native_after_raw:{'0x0521f52a':0,'0x0521f69d':0,'0x0521a7b9':0,'0x0521a7c7':0,
      '0x0521a7c6':6,'0x0521a7c8':0,'0x0521f692':0,'0x0521f69e':0,'0x0521a7bd':0,'0x0521a77b':5}};
  let skill=sourceLookup(role,12,draw),fade=null;
  if(!skill){
    if(![4,2,12].includes(a.current))skill=sourceLookup(role,2,draw);
    if(!skill&&side===0){
      fade=draw(7,'death-fade-increment')+1;
      after.death_fade_mode_raw=fade;after.death_fade_increment_raw=fade;after.death_fade_clock_raw=220;after.death_fade_elapsed_raw=0;
      Object.assign(after.native_after_raw,{'0x0521a7b1':220,'0x0521f66a':fade,'0x0521f66e':0});
    }
  }
  if(skill)after.native_after_raw['0x0521f6b2']=0;
  const output=descriptor(actor,skill,'preserve',actor.current_target_id,trace,data,skill?'death-skill':'death-fade',after);
  return {...output,kind:'death',fade_mode_raw:fade,fade_increment_raw:fade,status_slots_policy:'Clear the actor native status slots exactly once with death finalization.'};
}
