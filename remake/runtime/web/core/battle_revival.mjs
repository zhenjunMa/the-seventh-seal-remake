/** Source-backed mode3 revival: 508BB0 -> 41BFB0, then 41E950.
 * Availability never grants or learns a skill. The caller supplies the
 * character's actual learned state and commits an admitted command once.
 */
import {idiv} from './combat_rules.mjs';
const copy=structuredClone;
const need=(ok,message)=>{if(!ok)throw new TypeError(message);};
const int=(n,name)=>{need(Number.isInteger(n)&&n>=-2147483648&&n<=2147483647,`Invalid ${name}`);return n;};
const add=(a,b)=>(a+b)|0,sub=(a,b)=>(a-b)|0,mul=Math.imul;
const address=n=>`0x${n.toString(16).padStart(8,'0')}`;
const status=(actor,n)=>int(actor.status_by_address?.[address(n)],address(n));
function rawView(hex,length){need(typeof hex==='string'&&new RegExp(`^(?:[a-f0-9]{2}){${length}}$`,'i').test(hex),'Original revival bytes missing');const bytes=Uint8Array.from(hex.match(/../g),n=>parseInt(n,16));return {bytes,view:new DataView(bytes.buffer)};}
function skillView(skill){return rawView(skill?.fixed_raw_hex,0x41d);}
export const REVIVAL_EVIDENCE=Object.freeze({
  status:'ev_b60df993ec40db6a7f8b4b4488d483bd2320a75965aa221003ad34b6e42ba996',
  block:'ev_b490a029bb41b81885476717865d491d1c0847a945d94183e9c48524f92bf387',
  recovery:'ev_c34cba1552a0698eeb5b10a24e5b4e1232f8e25378162a3e7835b64545a900c8',
  mp:'ev_1f0e32e11e007c147993f592f3b3ac175e5c949ec2995a596658e2fca57df3e2',
  targeting:'ev_310d4df81cf6d91d5a39e68548d0649e7ecebc06a3b9467a69d117d3d86fea73',
});
export function isNativeRevivalSkill(skill){
  try{return skillView(skill).bytes[0x23c]===3;}catch{return false;}
}
export function nativeRevivalSkillSupported(skill){
  try{
    const {bytes,view}=skillView(skill);if(bytes[0x23c]!==3||bytes[0x24]!==0||bytes[0x25]!==1||bytes[0x16c]!==0)return false;
    const block=new DataView(bytes.slice(0x231,0x2f7).buffer);
    return block.getInt32(0x23,true)>=0&&block.getInt32(0x43,true)>=0&&
      view.getInt32(0xab,true)>=0&&view.getInt32(0xaf,true)>=view.getInt32(0xab,true)&&view.getInt32(0xbb,true)>=0&&view.getInt32(0xbf,true)>=view.getInt32(0xbb,true);
  }catch{return false;}
}
export function revivalTargetEligibility(target,skill){
  if(!nativeRevivalSkillSupported(skill))return {available:false,reason:'此复活技能的原始处理器尚未接入'};
  return target&&!target.immune_raw&&target.state_raw>=4&&target.state_raw<=7&&!target.escaped?
    {available:true,target_mode_raw:3}:{available:false,reason:'目标当前不能复活'};
}
export function revivalSkillAvailability({caster,target,skill,learned}){
  try{
    const {bytes,view}=skillView(skill);
    need(learned===true,'角色尚未学会此技能');need(nativeRevivalSkillSupported(skill),'此复活技能的原始处理器尚未接入');
    need(caster&&target&&caster.hp.current>0&&caster.state_raw<4&&!caster.immune_raw&&!caster.escaped,'施法者不能行动');
    need(!((caster.status_flags_raw??0)&2),'沉默状态下不能施放法术');
    need(bytes[0x25]===1&&caster.side_raw===target.side_raw,'复活目标不属于同一阵营');
    need(!target.immune_raw&&target.state_raw>=4&&target.state_raw<=7&&!target.escaped,'目标当前不能复活');
    const cost=Math.max(0,-view.getInt32(0x14f,true));need(caster.mp.current>=cost,'MP不足');
    need((caster.level??0)>=view.getInt32(0x143,true),'等级不足');
    return {available:true,mp_cost:cost,target_mode_raw:3};
  }catch(error){return {available:false,reason:error.message};}
}
function resources(actor){
  for(const [field,n]of [['raw_hp',0x524a701],['raw_hp_maximum',0x524a705],['raw_mp',0x524a709],['raw_mp_maximum',0x524a70d]]){
    int(actor[field],field);need(actor.raw_by_address?.[address(n)]===actor[field],'Revival resource representations differ');
  }
  need(actor.resource_bonuses&&actor.hp&&actor.mp,'Revival linked resource snapshot missing');
  for(const key of ['hp_current','hp_maximum','mp_current','mp_maximum'])int(actor.resource_bonuses[key],key);
  need(actor.hp.current===Math.max(0,add(actor.raw_hp,actor.resource_bonuses.hp_current)),'Revival HP display differs from raw HP');
}
function sync(actor){
  for(const[field,n]of [['raw_hp',0x524a701],['raw_hp_maximum',0x524a705],['raw_mp',0x524a709],['raw_mp_maximum',0x524a70d]])actor.raw_by_address[address(n)]=actor[field];
  actor.effective_hp_raw=add(actor.raw_hp,actor.resource_bonuses.hp_current);actor.effective_mp_raw=add(actor.raw_mp,actor.resource_bonuses.mp_current);
  actor.hp.current=Math.max(0,actor.effective_hp_raw);actor.mp.current=Math.max(0,actor.effective_mp_raw);
  actor.hp.maximum=add(actor.raw_hp_maximum,actor.resource_bonuses.hp_maximum);actor.mp.maximum=add(actor.raw_mp_maximum,actor.resource_bonuses.mp_maximum);
}
/** Positive recovery branch of 41BFB0, used by original revival blocks.
 * Negative block HP changes dispatch native death handlers and are rejected
 * here rather than silently replacing that separate lifecycle.
 */
export function applyNativeRevivalRecoveryBlock({actor,effect_raw_hex}){
  resources(actor);const out=copy(actor),{view}=rawView(effect_raw_hex,0xc6),get=n=>view.getInt32(n,true);
  need(get(0x23)>=0&&get(0x43)>=0,'Damaging revival recovery blocks require native death handling');
  if(out.state_raw>=4)return {actor:out,native_return:0};
  out.raw_mp=add(out.raw_mp,get(0x2b));out.raw_mp_maximum=add(out.raw_mp_maximum,get(0x2f));out.raw_hp_maximum=add(out.raw_hp_maximum,get(0x27));
  const hp=status(out,0x521f551),maximum=status(out,0x521f555),currentPercent=status(out,0x521f571),maximumPercent=status(out,0x521f575);
  if(get(0x23)>0){
    out.raw_hp=add(out.raw_hp,get(0x23));
    const base=add(out.raw_hp,hp),extra=currentPercent?idiv(mul(base,currentPercent),100):0;
    const maxBase=add(out.raw_hp_maximum,maximum),maxExtra=maximumPercent?idiv(mul(maxBase,maximumPercent),100):0,max=add(maxBase,maxExtra);
    if(add(base,extra)>max)out.raw_hp=sub(sub(max,extra),hp);
  }else if(get(0x43)>0){
    const maxBase=add(out.raw_hp_maximum,maximum),maxExtra=maximumPercent?idiv(mul(maxBase,100),maximumPercent):0,max=add(maxBase,maxExtra);
    const extra=currentPercent?idiv(mul(max,add(currentPercent,get(0x43))),100):0,current=add(add(out.raw_hp,hp),extra);
    out.raw_hp=add(out.raw_hp,idiv(mul(max,get(0x43)),100));
    if(current>max)out.raw_hp=sub(sub(max,extra),hp);
  }
  sync(out);return {actor:out,native_return:0};
}
/** Shared 41E950 recovery arithmetic. The caller owns this actor copy and
 * supplies the source fixed-record DataView; no damage or status roll occurs.
 */
export function recoverSkill(actor,view,rng,trace,label='revival'){
  resources(actor);need(view instanceof DataView&&view.byteLength===0x41d,'Original recovery skill bytes missing');
  const next=typeof rng==='function'?rng:rng?.next?.bind(rng);
  const range=(low,high,label)=>{if(low>=high)return low;need(next,'Explicit revival RNG required');const draw=int(next(),'native RNG');need(draw>=0&&draw<=32767,'Native RNG outside range');const result=draw%(high-low);trace.push({kind:'rng',label,raw:draw,modulus:high-low,result});return add(low,result);};
  const hpDelta=range(view.getInt32(0xab,true),view.getInt32(0xaf,true),`${label}-hp-range`);actor.raw_hp=add(actor.raw_hp,hpDelta);
  const hpStatus=status(actor,0x521f551),hpDiv=status(actor,0x521f571),hpBase=add(actor.raw_hp,hpStatus),hpExtra=hpDiv?idiv(mul(hpBase,100),hpDiv):0,hpTerm=add(hpBase,hpExtra);
  const hpMaxBase=add(actor.raw_hp_maximum,status(actor,0x521f555)),hpMaxDiv=status(actor,0x521f575),hpMaxExtra=hpMaxDiv?idiv(mul(hpMaxBase,100),hpMaxDiv):0,hpMax=add(hpMaxBase,hpMaxExtra);
  if(hpTerm>hpMax)actor.raw_hp=sub(sub(hpMax,hpExtra),hpStatus);
  const mpDelta=range(view.getInt32(0xbb,true),view.getInt32(0xbf,true),`${label}-mp-range`);actor.raw_mp=add(actor.raw_mp,mpDelta);
  const mpExtra=mul(hpTerm,status(actor,0x521f579)),mpStatus=status(actor,0x521f559),mpTerm=add(add(actor.raw_mp,mpStatus),mpExtra);
  const mpMaxBase=add(actor.raw_mp_maximum,status(actor,0x521f55d)),mpMaxDiv=status(actor,0x521f57d),mpMax=add(mpMaxBase,mpMaxDiv?idiv(mul(mpMaxBase,100),mpMaxDiv):0);
  if(mpTerm>mpMax)actor.raw_mp=sub(sub(mpMax,mpExtra),mpStatus);
  sync(actor);return {hp:hpDelta,mp:mpDelta};
}
/** Pure admitted mode3 contact. Learning, caster resources, command/gauge
 * dispatch and one-contact commitment belong to the calling transaction.
 * Charge, status slots and status flags are preserved by this native branch.
 */
export function applyNativeRevival({target,skill,rng,selectAnimation=null}){
  resources(target);const {bytes,view}=skillView(skill);need(bytes[0x23c]===3,'Only native revival mode3 supported');
  const effect=bytes.slice(0x231,0x2f7),effectHex=Array.from(effect,n=>n.toString(16).padStart(2,'0')).join('');
  const slots=target.native_status_slots;need(Array.isArray(slots)&&slots.length===100,'Revival requires the explicit native status slots');
  const out=copy(target),trace=[],evidence=Object.values(REVIVAL_EVIDENCE),result=(applied,native_return,reason,extra={})=>({actor:out,applied,native_return,reason,trace,evidence,...extra});
  if(slots.some(slot=>{const b=rawView(slot.raw_hex,0xc6).bytes;return effect[1]!==0&&b[1]===effect[1]&&b[0xb]===3;}))return result(false,0,'duplicate-effect-id-and-mode');
  if(target.immune_raw||target.state_raw<4||target.state_raw>7)return result(false,1,'target-ineligible');
  out.state_raw=0;const effective=add(out.raw_hp,out.resource_bonuses.hp_current);
  if(effective===0){out.raw_hp=sub(1,effective);sync(out);}
  // 508DB8 calls 50E3A0(type14) before recovery; its sourceLookup may draw
  // even with one candidate. The controller injects that established selector
  // here so its draws precede any 41E950 recovery-range draws.
  const animation=selectAnimation?selectAnimation(out,{animation_type_raw:14,rng}):null;
  const recovered=applyNativeRevivalRecoveryBlock({actor:out,effect_raw_hex:effectHex});Object.assign(out,recovered.actor);
  const before=target.hp.current,deltas=recoverSkill(out,view,rng,trace);
  trace.push({kind:'revival-contact',state_before:target.state_raw,state_after:0,hp_before:before,hp_after:out.hp.current,flat_hp:deltas.hp,flat_mp:deltas.mp});
  return result(true,1,'revived',{animation_type_raw:14,animation,hp_delta:out.hp.current-before,recovery_block_raw_hex:effectHex});
}
