/** Bounded direct-damage port of GAME.exe 0x41D990 and its numeric callees.
 * Inputs are source-exported native fields; this module never substitutes CHR
 * attack for the four random/effective outputs of 0x41C610. It does not model
 * skill selection, action queue timing, ailments, counters, or animation.
 * Registered fresh-slot effect carriers use the original nonzero-token branch.
 * The runtime supplies a fresh, explicit battle status snapshot.
 * Static reconstruction only: no original battle execution was observed.
 */
export const COMBAT_RULES_EVIDENCE = Object.freeze({
  damage: 'ev_abb8ffa7bac45ac74b095aa37d3b44882a1545b791d4b19d917871e53bdbbb30',
  effective: 'ev_1303a62e3e254cd7e702384a9dc7969f724a5a21d0d057b071f3f42bfb371a68',
  elements: 'ev_f5bcd44561bffdadc0f43a2e73375f63705feb6f86519a1c3aeda83898e807f0',
  rng: 'ev_f945f3ecee307d16b21890133246943d7f42b507454779e95c6032d5a46951cc',
  reaction: 'ev_0c88fd90539d1a633ab604e67359c60f0a2796bfaf7d3040ed6d16906cdec781',
  hp: 'ev_e76dc0fc2a37ba715b7005825ea4ce93f1523440769a6aa6549a0ac77569df72',
  hp_getter: 'ev_635bf69f89b9158deec299cbb4f0e334664adeb56ef85dca7d95156113e301e8',
  linked_hp: 'ev_6ee54dc6fe565f173e91b950485b3f7ad09dc8ebbe91d714b32509786be353a8',
  selected_actor_reset: 'ev_42f120407753a49a48957bab6ad73688d821ee2256599705fc0190738c495af7',
  effect_skill_getter: 'ev_ac2a5c6852f0a605972ead58ee7311bffb585955cc9723af26cbb79e96e2ec05',
  effect_slot_allocation: 'ev_2c00f87a5a3b457786ca5e8e5c6f94374d1a24e2c8be051b913b1d6b012d8c17',
});
const REQUIRED_RAW = [0x524a701,0x524a705,0x524a711,0x524a715,0x524a719,0x524a71d,0x524a729,0x524a72d,0x524a74b,0x524a74f,0x524a753,0x524a757,0x524a75b,0x524a75f];
const REQUIRED_STATUS = [0x521f551,0x521f555,0x521f561,0x521f565,0x521f569,0x521f56d,0x521f571,0x521f575,0x521f581,0x521f585,0x521f589,0x521f58d,0x521f591,0x521f595,0x521f5a5,0x521f5b9,0x521f5bd,0x521f5c1,0x521f5c5,0x521f5c9,0x521f5cd];
const REQUIRED_LINK = [0x4f99088,0x4f9908c,0x4f99098,0x4f9909c,0x4f990a4,0x4f990d0,0x4f990d4,0x4f990d8,0x4f990e0,0x4f990e4,0x4f990e8,0x4f990ec,0x4f990f0,0x4f990f4];
function integer(v, name, min=-2147483648,max=2147483647) {
  if (!Number.isInteger(v)||v<min||v>max) throw new TypeError(`Invalid ${name}`);
  return v;
}
export function i32(v) { if(!Number.isSafeInteger(v)) throw new TypeError('Unsafe integer'); return v|0; }
const add=(a,b)=>(a+b)|0, sub=(a,b)=>(a-b)|0, mul=(a,b)=>Math.imul(a,b);
export function idiv(a,b) {
  integer(a,'dividend');integer(b,'divisor');
  if(b===0||(a===-2147483648&&b===-1)) throw new RangeError('x86 IDIV exception');
  return Math.trunc(a/b)||0;
}
function addr(n){return `0x${n.toString(16).padStart(8,'0')}`;}
function field(table,n){return integer(table?.[addr(n)],addr(n));}
export function createNativeRng(seed) {
  let state=integer(seed,'RNG seed',0,4294967295)>>>0;
  const next=()=>{state=(Math.imul(state,214013)+2531011)>>>0;return (state>>>16)&32767;};
  Object.defineProperty(next,'state',{get:()=>state});next.next=next;return next;
}
function skillView(skill) {
  const hex=skill?.fixed_raw_hex;
  // CHR stores 0x41D bytes; native 0x421 stride appends an action-array pointer.
  // Numeric fields reside in the source record and never require that pointer.
  if(typeof hex!=='string'||!/^([0-9a-f]{2}){1053}$/i.test(hex)) throw new TypeError('Skill requires the original 0x41D-byte source record');
  const data=Uint8Array.from(hex.match(/../g),v=>parseInt(v,16));const view=new DataView(data.buffer);
  return {i32:o=>view.getInt32(o,true),u32:o=>view.getUint32(o,true),byte:o=>data[o],signedByte:o=>view.getInt8(o),data};
}
function actorView(actor) {
  if(!actor||typeof actor!=='object')throw new TypeError('Missing native actor snapshot');
  for(const n of REQUIRED_RAW)field(actor.raw_by_address,n);
  for(const n of REQUIRED_STATUS)field(actor.status_by_address,n);
  for(const n of REQUIRED_LINK)field(actor.linked_by_address,n);
  const byte=(name)=>integer(actor[name],name,0,255);
  const state=byte('state_raw'),side=byte('side_raw'),repeated=byte('settled_raw'),immune=byte('immune_raw'),classRaw=byte('class_raw'),half=byte('defense_half_raw');
  const role=integer(actor.role_link_raw,'role_link_raw',0,2147483647),inhibit=integer(actor.reaction_inhibit_raw,'reaction_inhibit_raw');
  const stance=integer(actor.stance_raw,'stance_raw',0,3),actionMask=byte('action_mask_raw');
  return {raw:n=>field(actor.raw_by_address,n),status:n=>field(actor.status_by_address,n),link:n=>(side&&role)?field(actor.linked_by_address,n):0,
    sideLink:n=>side?field(actor.linked_by_address,n):0,state,side,repeated,immune,classRaw,half,role,inhibit,stance,actionMask};
}
function rollFactory(rng,trace) {
  const next=typeof rng==='function'?rng:rng?.next?.bind(rng);
  if(!next)throw new TypeError('Explicit native RNG provider required');
  return (mod,label)=>{integer(mod,'RNG modulus',1,2147483647);const raw=integer(next(),'native RNG output',0,32767);const result=raw%mod;trace.push({kind:'rng',label,raw,modulus:mod,result});return result;};
}
function effective(actor,skill,roll,label) {
  const a=actorView(actor),s=skillView(skill),range=(low,high,l)=>low<high?add(low,roll(sub(high,low),`${label}.${l}`)):low;
  let hp=add(add(a.raw(0x524a701),s.i32(0xab)),a.status(0x521f551));
  let hpMax=add(add(a.raw(0x524a705),s.i32(0xaf)),a.status(0x521f555));
  const hpDiv=a.status(0x521f571),hpMaxDiv=a.status(0x521f575);
  if(hpDiv)hp=add(hp,idiv(mul(hp,100),hpDiv));if(hpMaxDiv)hpMax=add(hpMax,idiv(mul(hpMax,100),hpMaxDiv));
  const adjust=(v,pct)=>add(v,idiv(mul(v,pct),100));
  let attack=adjust(add(range(a.raw(0x524a711),a.raw(0x524a715),'attack-range'),a.status(0x521f561)),a.status(0x521f581));
  const baseDefense=range(a.raw(0x524a719),a.raw(0x524a71d),'defense-range');
  let defense=add(add(baseDefense,range(s.i32(0xd3),s.i32(0xd7),'skill-defense-range')),a.status(0x521f565));
  // Native zero-extends the byte and compares ECX with -1; even 0xFF reaches
  // the ADD branch. Preserve that observed instruction behavior.
  if(a.half)defense=add(defense,baseDefense>>1);
  defense=adjust(defense,a.status(0x521f585));
  let term4=adjust(add(add(range(a.raw(0x524a729),a.raw(0x524a72d),'term4-range'),range(s.i32(0xe3),s.i32(0xe7),'skill-term4-range')),a.status(0x521f56d)),a.status(0x521f58d));
  hp=add(hp,a.link(0x4f99088));hpMax=add(hpMax,a.link(0x4f9908c));
  attack=add(attack,a.link(0x4f99098));defense=add(defense,a.link(0x4f9909c));term4=add(term4,a.link(0x4f990a4));
  if(a.side&&a.role){const p=[[10,-5,8],[0,0,0],[0,0,0],[-10,5,-8]][a.stance];attack=adjust(attack,p[0]);defense=adjust(defense,p[1]);term4=adjust(term4,p[2]);}
  let term3=idiv(add(mul(term4,70),mul(defense,20)),999);if(hpMax)term3=add(term3,idiv(hp,hpMax));
  term3=adjust(add(term3,a.status(0x521f569)),a.status(0x521f589));
  return {attack:Math.max(0,attack),defense:Math.max(0,defense),term3:Math.max(0,term3),term4:Math.max(0,term4),hp_term:hp,hp_max_term:hpMax};
}
export function buildEffectiveAttributes(actor,skill,rng) {const trace=[];const result=effective(actor,skill,rollFactory(rng,trace),'actor');return {...result,trace,evidence:COMBAT_RULES_EVIDENCE.effective};}
export function elementalTerms(attacker,target,skill) {
  const a=actorView(attacker),t=actorView(target),s=skillView(skill);
  let index=-1,power=0,resistance=0,relationship=0;
  const values=Array.from({length:6},(_,i)=>s.i32(0x105+i*4));
  index=values.findIndex(v=>v!==0);
  if(index>=0){power=Math.max(0,add(values[index],a.status(0x521f5b9+index*4)));resistance=Math.max(0,add(add(t.raw(0x524a74b+index*4),t.status(0x521f5b9+index*4)),t.link(0x4f990e0+index*4)));if(t.side)resistance=Math.min(999,resistance);}
  // 0x41CFE0 overwrites relation in slot order; it is neither a sum across
  // all elements nor a semantic fire/water chart inferred from their names.
  for(let i=0;i<6;i++)if(values[i]!==0){const opposite=i^1;
    if(t.raw(0x524a74b+i*4)!==0)relationship=1;
    if(t.raw(0x524a74b+opposite*4)!==0)relationship=add(add(add(values[i],a.status(0x521f5b9+i*4)),a.link(0x4f990e0+i*4)),add(add(t.raw(0x524a74b+opposite*4),t.status(0x521f5b9+opposite*4)),t.link(0x4f990e0+opposite*4)));
  }
  relationship=Math.max(0,relationship);
  return {index,power,resistance,relationship,evidence:COMBAT_RULES_EVIDENCE.elements};
}
/** 501930 uses the carrier's skill index in each actor's own 200-slot table.
 * Loaded slots retain their CHR record; only slots beyond skill_count are zero.
 * This source lookup is independent of the target's currently playing pose.
 */
export function nativeEffectContextForTarget(skill,target,roles){
  const context=structuredClone(skill.effect_context??{});
  if(context.effect_lookup!=='same-index-source-table')return context;
  const id=target.resource_id??target.id,role=roles?.[id],index=skill.original_skill_index;
  if(!role||!Array.isArray(role.skills)||role.skills.length!==role.skill_count||index<0||index>=200||
      role.source?.path!==`Fight_Role/${id}.CHR`||role.source.sha256!==target.source?.sha256)
    throw new RangeError('Effect-token target original skill table is missing or differs from its actor');
  const source=role.skills[index];
  if(index<role.skill_count&&(!source||source.original_skill_index!==index||source.source?.path!==role.source.path||source.source.sha256!==role.source.sha256))
    throw new RangeError('Effect-token target original skill index differs');
  context.effect_target_skill={fixed_raw_hex:source?.fixed_raw_hex??'00'.repeat(0x41d),initialized_slots:200,
    source_skill_count_by_role:{[id]:role.skill_count},source:structuredClone(role.source),source_skill_index:index};
  return context;
}
export function validateNativeEffectBinding(skill,roles){
  const context=skill.effect_context,index=skill.original_skill_index;
  if(skill.battle_handler!=='effect-carrier'||context?.effect_token!==1||context.effect_source_skill_index!==index||index<0||index>=200)
    throw new RangeError('Effect-token source binding differs');
  if(context.effect_lookup==='same-index-source-table'){
    for(const [id,role]of Object.entries(roles))if(role.source?.path!==`Fight_Role/${id}.CHR`||!Array.isArray(role.skills)||role.skills.length!==role.skill_count||role.skills.some((s,i)=>s.original_skill_index!==i||s.source?.sha256!==role.source.sha256))
      throw new RangeError('Effect-token target source table is incomplete');
  }else for(const [id,role]of Object.entries(roles))if(role.skill_count>index||context.effect_target_skill?.source_skill_count_by_role?.[id]!==role.skill_count)
    throw new RangeError('Effect-token source is outside the fresh registered carrier scope');
  return true;
}
/** Pure result. Controller commits HP and mp_cost once, then may update
 * target.settled_raw with after_settled_raw. target.current_skill is mandatory.
 * Current scope admits direct token0 and registered fresh-slot carriers. The
 * remake token1 names a carrier bound to its source index; native queue indices
 * are ephemeral identities, not additional damage coefficients.
 * HP term701 / term705 are current / maximum HP; MP fields709 / 70D are
 * handled by the controller's separately source-backed resource submission.
 */
export function resolveAction({attacker,target,skill,rng,context={}}) {
  const a=actorView(attacker),t=actorView(target),s=skillView(skill),ts=skillView(target.current_skill);
  const token=integer(context.effect_token??0,'effect_token',0,200),effect=token!==0;
  const effectIndex=context.effect_source_skill_index,targetSkillCount=context.effect_target_skill?.source_skill_count_by_role?.[target.resource_id??target.id];
  const sameIndex=context.effect_lookup==='same-index-source-table',targetId=target.resource_id??target.id;
  if(effect&&(token!==1||skill.battle_handler!=='effect-carrier'||!Number.isInteger(effectIndex)||effectIndex<0||effectIndex>=200||effectIndex!==skill.original_skill_index||
      (sameIndex?skill.source?.path!==`Fight_Role/${attacker.resource_id??attacker.id}.CHR`:(attacker.resource_id??attacker.id)!==skill.actor_id)||
      (sameIndex?![2,3].includes(s.u32(0x32)&15):s.u32(0x32)!==0x1102)||context.effect_target_skill?.initialized_slots!==200||
      !Number.isInteger(targetSkillCount)||targetSkillCount<0||targetSkillCount>200||
      (sameIndex?(context.effect_target_skill.source?.path!==`Fight_Role/${targetId}.CHR`||context.effect_target_skill.source.sha256!==target.source?.sha256||context.effect_target_skill.source_skill_index!==effectIndex):
        targetSkillCount>effectIndex||context.effect_target_skill?.fixed_raw_hex!=='00'.repeat(0x41d))))throw new RangeError('Effect-token source is outside the fresh registered carrier scope');
  const globalGate=integer(context.global_055ee004??0,'global_055ee004');
  const mp_cost=integer(skill.mp_cost,'source-backed MP cost',0,2147483647),trace=[];
  const evidence=Object.values(COMBAT_RULES_EVIDENCE),finish=(x)=>({mp_cost,trace,evidence,...(skill.configuration?{configuration:structuredClone(skill.configuration)}:{}),...x});
  const rejected=(reason)=>finish({damage:0,hit:false,reason,reaction:0,native_return:-1,after_settled_raw:t.repeated});
  if(t.state===7||t.immune)return rejected('target-unavailable');
  // Native 41D990 applies these gates only for token0. A command4 carrier
  // carries its source skill index into 501930 for both effective snapshots.
  if(!effect&&(ts.byte(0x3a)||({1:1,2:2,3:4}[t.classRaw]&a.actionMask)))return rejected('action-class-rejected');
  if(globalGate&&t.side)return rejected('native-global-gate');
  const roll=rollFactory(rng,trace),ae=effective(attacker,skill,roll,'attacker'),te=effective(target,effect?context.effect_target_skill:target.current_skill,roll,'target');
  const hitTerm=add(add(add(idiv(mul(add(mul(ae.term4,80),mul(ae.attack,20)),10),99900),90),a.sideLink(0x4f990d0)),a.status(0x521f591));
  const avoidTerm=add(add(idiv(mul(add(mul(te.term3,70),mul(te.term4,30)),40),99900),t.sideLink(0x4f990d8)),t.status(0x521f595));
  const guardTerm=add(add(idiv(mul(add(mul(te.term3,80),mul(te.defense,20)),30),99900),t.sideLink(0x4f990d4)),t.status(0x521f5a5));
  const threshold=avoidTerm>=100?0:Math.max(20,Math.min(100,sub(hitTerm,avoidTerm))),hitRoll=roll(100,'hit');
  const reactive=t.state<4&&t.inhibit===0&&t.repeated===0,suppressReaction=[2,3,4,5,8].includes(ts.signedByte(0));
  const bypass=((s.u32(0x32)>>>12)&1)!==0;
  trace.push({kind:'effective',attacker:ae,target:te,hitTerm,avoidTerm,guardTerm,threshold,bypass});
  if(reactive&&s.signedByte(0)!==19&&hitRoll>threshold&&!bypass)return finish({damage:0,hit:false,reason:'miss',reaction:effect||suppressReaction?0:2,native_return:0,after_settled_raw:t.repeated});
  let multiplier=s.i32(0xcb);if(multiplier<s.i32(0xcf))multiplier=add(multiplier,roll(sub(s.i32(0xcf),multiplier),'physical-multiplier'));
  const physicalBase=idiv(sub(mul(ae.attack,5000),mul(te.defense||1,4500)),999);
  const physical=Math.max(0,idiv(mul(physicalBase,multiplier),100));const terms=elementalTerms(attacker,target,skill);
  let elemental=0;if(terms.power>terms.resistance){const product=mul(mul(terms.power,sub(terms.power,terms.resistance)),add(terms.power,terms.relationship))>>>0;elemental=Math.floor(product/66600)|0;if(elemental>0)elemental=add(elemental,roll(20,'elemental-jitter'));}
  let damage=Math.min(9999,add(physical,elemental)),reaction=0;
  trace.push({kind:'damage',physicalBase,multiplier,physical,elemental,terms,preGuardDamage:damage});
  if(damage<=0&&reactive&&!bypass&&!suppressReaction&&!effect)return finish({damage:0,hit:true,reason:'deflected',reaction:2,native_return:0,after_settled_raw:t.repeated});
  if(damage<=0)damage=1;
  const guardRoll=roll(100,'guard');let guarded=false;
  if(guardRoll<=guardTerm&&!bypass){guarded=true;if(reactive&&!suppressReaction&&!effect)reaction=1;damage=sub(damage,idiv(mul(damage,20),100));}
  const after_settled_raw=reaction?0:1;
  trace.push({kind:'guard',roll:guardRoll,threshold:guardTerm,guarded,reaction});
  return finish({damage,hit:true,reason:guarded?'guarded':'hit',reaction,native_return:damage,after_settled_raw,physical,elemental});
}

/** 0x5005C0/0x500350/0x5003F0 HP submission; world raw HP excludes
 * active linked equipment bonus, while the battle HUD shows effective HP.
 * The controller passes the same battle-owned actor returned by the exporter.
 */
export function applyNativeDamage(target,result,context={}) {
  // 0x5005C0 skips the entire HP/death submission when the source skill-test
  // global is nonzero. Hits and their visible damage still settle upstream.
  if(integer(context.global_055ee004??0,'global_055ee004'))return {...target};
  const t=actorView(target),damage=integer(result.damage,'resolved damage',0,2147483647);
  const hp=integer(target.raw_hp,'raw_hp'),bonus=t.link(0x4f99088),effectiveHP=add(hp,bonus);
  if(hp!==t.raw(0x524a701))throw new RangeError('raw HP and native current HP field differ');
  if(t.state>=4)return {...target};
  const raw_hp=effectiveHP<damage?(-bonus)|0:sub(hp,damage),effectiveAfter=add(raw_hp,bonus),dead=effectiveAfter<=0;
  const status={...target.status_by_address};if(effectiveHP<damage)status[addr(0x521f551)]=0;
  return {...target,raw_hp,...(Object.hasOwn(target,'effective_hp_raw')?{effective_hp_raw:effectiveAfter}:{}),raw_by_address:{...target.raw_by_address,[addr(0x524a701)]:raw_hp},state_raw:dead?4:t.state,settled_raw:integer(result.after_settled_raw,'after_settled_raw',0,255),
    status_by_address:status,hp:{...target.hp,current:Math.max(0,effectiveAfter)}};
}
