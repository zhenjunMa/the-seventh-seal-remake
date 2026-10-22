/** Fixed battle commands, bounded to the scalar native forest scheduler.
 * These are command effects, separate from attack / item preparation debt.
 * Callers validate readiness and clear the selected command transaction.
 */
import {buildEffectiveAttributes,idiv} from './combat_rules.mjs';
const copy=structuredClone;
const need=(ok,message)=>{if(!ok)throw new TypeError(message);};
function integer(value,name,min=-2147483648,max=2147483647){need(Number.isInteger(value)&&value>=min&&value<=max,`Invalid ${name}`);return value;}
function charge(actor){
  need(actor?.charge&&typeof actor.charge==='object','Battle command charge missing');
  for(const field of ['gauge','delay','recovery','recovery_ticks'])integer(actor.charge[field],`charge.${field}`);
  return actor.charge;
}
export const FIXED_COMMAND_EVIDENCE=Object.freeze({
  dispatch:'ev_cc2a61bc12664a3028466acad29330e69f7d036955f7d95117e84388aa0af6c1',
  clear:'ev_e274abe3b5f53047293bebcce00c1c74659178d135e0769124bdf5c841966687',
  ready_scan:'ev_37da5e2128b89290062c1089c707e11731d164ae824a307465b9555f2918bb31',
  animation:'ev_7f0e950f52985ccd6d44703919de97adf510ab92c2fd268514c8bf63f7a130fa',
  escape:'ev_b3e8f00fd1100fe39140f97ba388e7a69ca7055155bf538796149bbc4330e5e9',
  escape_exit:'ev_f59b62a177316aa7c44b5cc8f2240c49c1bef71a562cfcb9477f3204b2175b82',
});
/** Native 42FC80 clears F684 whenever a player command is consumed/cancelled.
 * Mode0 5036D0 also clears it when an eligible player reaches the threshold,
 * BEFORE checking whether that player has entered another command. The
 * scheduler owns that eligibility test and calls this at the same point.
 */
export function clearCommandDefense(actor){
  const before=integer(actor.defense_half_raw??0,'defense_half_raw',0,255);
  actor.defense_half_raw=0;
  return {before,after:0,evidence:FIXED_COMMAND_EVIDENCE.clear};
}
/** 42FE40 raw command4: retain gauge overshoot, clear command, request the
 * type9 animation, then enable F684. Type9 is an animation/skill selector;
 * it is not actor.state_raw=9, and this path adds no skill preparation debt.
 * 41C610 applies F684 as + (base defense >> 1), already used by combat_rules.
 */
export function dispatchDefend(actor,scheduler){
  const current=charge(actor),threshold=integer(scheduler?.threshold,'threshold',1);
  const before=copy(current),defenseBefore=integer(actor.defense_half_raw??0,'defense_half_raw',0,255);
  current.gauge=(current.gauge-threshold)|0;
  actor.defense_half_raw=1;
  return {before,after:copy(current),command_kind:'defend',animation_type_raw:9,
    defense_half_before:defenseBefore,defense_half_after:1,
    evidence:[FIXED_COMMAND_EVIDENCE.dispatch,FIXED_COMMAND_EVIDENCE.animation]};
}
/** 42FE40 raw command5 failure: F684 is written FF, then 42FC80 clears it.
 * The final scalar state therefore has gauge0 and F684=0, with no skill debt.
 * The escape probability and success removal are supplied separately; this
 * function does not turn an individual escape into a party-wide victory.
 */
export function dispatchEscapeFailure(actor){
  const current=charge(actor),before=copy(current),defenseBefore=integer(actor.defense_half_raw??0,'defense_half_raw',0,255);
  current.gauge=0;clearCommandDefense(actor);
  return {before,after:copy(current),command_kind:'escape',success:false,
    defense_half_before:defenseBefore,defense_half_after:0,
    evidence:[FIXED_COMMAND_EVIDENCE.dispatch,FIXED_COMMAND_EVIDENCE.clear]};
}
function escapeEligible(actor){
  // FUN_00503600; action-slot readiness / gauge are not part of this gate.
  const state=integer(actor.state_raw,'state_raw',0,255),flags=integer(actor.status_flags_raw??0,'status_flags_raw',0,0xffffffff);
  const immune=integer(actor.immune_raw,'immune_raw',0,255),inhibit=integer(actor.reaction_inhibit_raw,'reaction_inhibit_raw');
  const recovery=integer(actor.charge?.recovery??0,'charge.recovery');
  return state<4&&!(flags&0xe1)&&!immune&&!inhibit&&!recovery;
}
/** Exact scalar 41F070 decision, including its unusual instructions:
 * - global055EE004 !=0 returns success without a draw;
 * - the running opponent term4 sum is divided after EVERY actor iteration;
 * - success is roll > threshold, not roll <= threshold.
 * Effective attributes retain all original RNG draws, even for attack and
 * defense outputs unused by the final ratio. Zero denominator raises the
 * same explicit IDIV exception as combat_rules; no substitute is invented.
 */
export function resolveNativeEscape({actor,actors,rng,global_055ee004=0}){
  integer(global_055ee004,'global_055ee004');
  need(actor&&Array.isArray(actors)&&actors.includes(actor),'Escape actor is not in this battle');
  const trace=[],evidence=[FIXED_COMMAND_EVIDENCE.escape];
  if(global_055ee004)return {success:true,native_return:1,threshold:null,roll:null,trace,evidence,reason:'native-global-gate'};
  const next=typeof rng==='function'?rng:rng?.next?.bind(rng);need(next,'Explicit native RNG provider required');
  const term4=member=>{
    const attributes=buildEffectiveAttributes(member,member.current_skill,next);
    trace.push(...attributes.trace.map(row=>({...row,actor_id:member.id})));
    trace.push({kind:'escape-effective',actor_id:member.id,term4:attributes.term4});
    return attributes.term4;
  };
  const side=integer(actor.side_raw,'side_raw',0,255),ownTerm=term4(actor);let opponentTerm=0,count=0;
  for(const member of actors){
    if(escapeEligible(member)&&integer(member.side_raw,'side_raw',0,255)!==side){count++;opponentTerm=(opponentTerm+term4(member))|0;}
    if(count)opponentTerm=idiv(opponentTerm,count);
    trace.push({kind:'escape-opponent-scan',actor_id:member.id,count,term4:opponentTerm});
  }
  const threshold=Math.min(90,(idiv(Math.imul(ownTerm,70),Math.imul(opponentTerm,100))+70)|0);
  const raw=integer(next(),'native RNG output',0,32767),roll=raw%100,success=roll>threshold;
  trace.push({kind:'rng',label:'escape-result',raw,modulus:100,result:roll});
  trace.push({kind:'escape-result',threshold,roll,success});
  return {success,native_return:success?1:0,threshold,roll,trace,evidence};
}
/** Native 50E4B0 exits only this actor. Its movement / type10 animation is a
 * presentation request; caller removes the actor from subsequent targeting
 * and ends the encounter once no living, unescaped party member remains.
 */
export function dispatchEscapeSuccess(actor){
  const current=charge(actor),before=copy(current);integer(actor.state_raw,'state_raw',0,255);
  current.gauge=0;actor.state_raw=11;actor.escaped=true;actor.native_active=false;
  return {before,after:copy(current),command_kind:'escape',success:true,animation_type_raw:10,
    evidence:[FIXED_COMMAND_EVIDENCE.dispatch,FIXED_COMMAND_EVIDENCE.escape_exit]};
}
