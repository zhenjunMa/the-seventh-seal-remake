// The same admission transaction is used by story programs and development
// fixtures. Callers own the draft and commit only after preparation succeeds.
import {runtimeContent} from './content_registry.mjs';
import {admitFormationMember,partyFormationSlots} from './party_formation.mjs';
import {applyPendingNativeSkillUnlocks} from './native_story_mutations.mjs';
const copy=structuredClone;
const need=(ok,message)=>{if(!ok)throw new Error(message);};
export function chapterRoleFromDefinition(definition){
  need(definition&&/^(?:[0-9a-f]{2}){779}$/.test(definition.header_raw_hex)&&definition.stored&&/^[0-9]{3}$/.test(definition.id),'入队角色缺少原始 CHR 来源');
  const stored=definition.stored;
  return {id:definition.id,name:definition.name,level:stored.level,hp:copy(stored.hp),mp:copy(stored.mp),
    attributes_stored:{attack:copy(stored.attack),defense:copy(stored.defense)},combat_progress:{header_raw_hex:definition.header_raw_hex}};
}
export function admitPartyMember(draft,id,{definitions={},content=runtimeContent}={}){
  const role=content.roles[id];need(role?.side==='player'&&draft,'剧情入队角色尚未接入');
  const existing=draft.party.find(row=>row.id===id);
  if(existing){applyPendingNativeSkillUnlocks(draft,existing,{roleDefinitions:definitions});return {id,added:false};}
  // 45E400 scans four formation slots and returns without writes if full.
  // Registration/source validation remains strict even for that no-effect path.
  const reserve=draft.reserve_party?.find(entry=>entry.role.id===id);
  const definition=definitions[id]??draft.source.role_definitions?.[id],source=definition?.source??definition;
  need(definition?.id===id&&source?.path===role.source.path&&source.sha256===role.source.sha256,'入队角色缺少已登记的初始来源');
  if(draft.party.length>=content.party_limit)return {id,added:false,reason:'formation-full'};
  draft.party.push(reserve?reserve.role:chapterRoleFromDefinition(definition));
  if(reserve)draft.reserve_party.splice(draft.reserve_party.indexOf(reserve),1);
  applyPendingNativeSkillUnlocks(draft,draft.party.at(-1),{roleDefinitions:definitions});
  if(draft.formation_slots)draft.formation_slots=admitFormationMember(draft.formation_slots,draft.party,id);
  if(draft.encounters){draft.encounters.counters[id]=reserve?.encounter_progress?.counter??0;draft.encounters.remainders[id]=reserve?.encounter_progress?.remainder??0;}
  return {id,added:true,...(reserve?{reactivated:true}:{}),source:source.path};
}

export function deactivatePartyMember(draft,id,{content=runtimeContent}={}){
  need(content.roles[id]?.side==='player'&&draft,'剧情离队角色尚未接入');
  const index=draft.party.findIndex(role=>role.id===id);
  if(index<0)return {id,removed:false};
  // 4B6660 changes active/formation metadata, leaving the character record
  // intact. 45E560 clears the matching slot only, without compacting holes.
  // reserve_party is the remake's persistence envelope for that owned record.
  const slots=partyFormationSlots(draft),entry={role:draft.party[index]};
  if(draft.encounters)entry.encounter_progress={counter:draft.encounters.counters[id],remainder:draft.encounters.remainders[id]};
  (draft.reserve_party??=[]).push(entry);draft.party.splice(index,1);
  draft.formation_slots=slots.map(roleId=>roleId===id?null:roleId);
  if(draft.encounters){delete draft.encounters.counters[id];delete draft.encounters.remainders[id];}
  return {id,removed:true};
}

export function controlPartyActor(draft,id,{content=runtimeContent}={}){
  need(content.roles[id]?.side==='player'&&draft.party.some(role=>role.id===id),'剧情控制角色不在当前队伍中');
  // 4B6720 mode3 changes controlled map actor; it does not call 45E400.
  // Position/visibility changes remain in the presentation's actor table.
  const previous_id=draft.leader_id;draft.leader_id=id;
  return {id,previous_id,controlled:true,added:false};
}
