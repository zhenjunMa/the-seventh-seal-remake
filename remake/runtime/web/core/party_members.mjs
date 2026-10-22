// The same admission transaction is used by story programs and development
// fixtures. Callers own the draft and commit only after preparation succeeds.
import {runtimeContent} from './content_registry.mjs';
import {admitFormationMember} from './party_formation.mjs';
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
  if(draft.party.some(row=>row.id===id))return {id,added:false};
  need(draft.party.length<content.party_limit,'队伍已满，不能加入新成员');
  const definition=definitions[id]??draft.source.role_definitions?.[id],source=definition?.source??definition;
  need(definition?.id===id&&source?.path===role.source.path&&source.sha256===role.source.sha256,'入队角色缺少已登记的初始来源');
  draft.party.push(chapterRoleFromDefinition(definition));
  if(draft.formation_slots)draft.formation_slots=admitFormationMember(draft.formation_slots,draft.party,id);
  if(draft.encounters){draft.encounters.counters[id]=0;draft.encounters.remainders[id]=0;}
  return {id,added:true,source:source.path};
}
