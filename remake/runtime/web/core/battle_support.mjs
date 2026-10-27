/** Source allied support contact: 50FA00 -> 508BB0(+231) -> 41E950.
 * This path has no damage roll, 508A90 contact-removal roll or carrier token.
 * Learning, caster MP submission and contact deduplication belong to callers.
 */
import {runtimeContent} from './content_registry.mjs';
import {applyNativeSupportStatus} from './battle_status.mjs';
import {recoverSkill,REVIVAL_EVIDENCE} from './battle_revival.mjs';
const need=(ok,message)=>{if(!ok)throw new TypeError(message);};
function source(skill){
  need(typeof skill?.fixed_raw_hex==='string'&&/^(?:[a-f0-9]{2}){1053}$/i.test(skill.fixed_raw_hex),'原辅助技能源记录缺失');
  const bytes=Uint8Array.from(skill.fixed_raw_hex.match(/../g),value=>parseInt(value,16));return {bytes,view:new DataView(bytes.buffer)};
}
export function nativeSupportSkillSupported(skill){
  try{
    const {bytes,view}=source(skill);
    // The +231 block uses the shared 508BB0 handler. A mode0 ID0 block
    // remains dormant even when it contains numerical modifier bytes.
    return bytes[0x25]===1&&[0,1].includes(bytes[0x24])&&[0,1,5].includes(bytes[0x23c])&&
      (bytes[0x23c]!==5||bytes[0x232]===0)&&
      (bytes[0x23c]!==0||bytes[0x232]===0||bytes[0x241]<=1)&&
      view.getInt32(0xab,true)>=0&&view.getInt32(0xaf,true)>=view.getInt32(0xab,true)&&
      view.getInt32(0xbb,true)>=0&&view.getInt32(0xbf,true)>=view.getInt32(0xbb,true);
  }catch{return false;}
}
export function supportTargetEligibility(target,skill){
  if(!nativeSupportSkillSupported(skill))return {available:false,reason:'此辅助技能的原始处理器尚未接入'};
  return target&&!target.immune_raw&&target.state_raw>=0&&target.state_raw<4&&!target.escaped?
    {available:true,target_mode_raw:source(skill).bytes[0x23c]}:{available:false,reason:'目标当前不能接受辅助技能'};
}
export function supportSkillAvailability({caster,target,skill,learned}){
  try{
    const {view}=source(skill);need(learned===true,'角色尚未学会此技能');need(nativeSupportSkillSupported(skill),'此辅助技能的原始处理器尚未接入');
    need(caster&&target&&caster.hp.current>0&&caster.state_raw<4&&!caster.immune_raw&&!caster.escaped,'施法者不能行动');
    need(!((caster.status_flags_raw??0)&2),'沉默状态下不能施放法术');
    need(caster.side_raw===target.side_raw,'辅助目标不属于同一阵营');
    const eligibility=supportTargetEligibility(target,skill);need(eligibility.available,eligibility.reason);
    const cost=Math.max(0,-view.getInt32(0x14f,true));need(caster.mp.current>=cost,'MP不足');
    need((caster.level??0)>=view.getInt32(0x143,true),'等级不足');
    return {...eligibility,mp_cost:cost};
  }catch(error){return {available:false,reason:error.message};}
}
export function applyNativeSupport({target,skill,rng,statusData,content=runtimeContent}){
  need(nativeSupportSkillSupported(skill),'此辅助技能的原始处理器尚未接入');
  const {bytes,view}=source(skill),mode=bytes[0x23c],before=target.hp.current,mpBefore=target.mp.current,trace=[];
  let out=structuredClone(target),cleared_statuses=0,cancel_command=false,status_native_return=null,status_reason=null;
  const result=(applied,native_return,reason)=>({actor:out,applied,native_return,reason,hp_delta:out.hp.current-before,
    mp_delta:out.mp.current-mpBefore,cleared_statuses,cancel_command,status_native_return,status_reason,trace,evidence:[REVIVAL_EVIDENCE.targeting,REVIVAL_EVIDENCE.status,REVIVAL_EVIDENCE.recovery,
      ...(mode===5?['ev_a303ad00fa4e4ea030fa74117e302c96af43ae22616bd36688ca532bb6b355bf']:[])]});
  if(!supportTargetEligibility(target,skill).available)return result(false,-1,'target-ineligible');
  const status=applyNativeSupportStatus({actor:out,skill,data:statusData,rng,content});out=status.actor;
  status_native_return=status.native_return;status_reason=status.reason;cancel_command=status.cancel_command;trace.push(...status.trace);
  if([1,5].includes(mode))cleared_statuses=target.native_status_slots.filter(row=>parseInt(row.raw_hex.slice(2,4),16)!==0).length
    -out.native_status_slots.filter(row=>parseInt(row.raw_hex.slice(2,4),16)!==0).length;
  const deltas=recoverSkill(out,view,rng,trace,'support');
  trace.push({kind:'support-contact',mode_raw:mode,flat_hp:deltas.hp,flat_mp:deltas.mp,hp_before:before,hp_after:out.hp.current,
    mp_before:mpBefore,mp_after:out.mp.current,cleared_statuses});
  return result(true,1,mode===5?'statuses-cleared':mode===1?'cured-and-recovered':bytes[0x232]?'status-and-recovered':'recovered');
}
