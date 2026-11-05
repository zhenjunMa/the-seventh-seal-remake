// Original formation records are independent of roster identity and map leader.
// 45E040 starts role 001 in slot 0; 45E400 admits each new member to the first
// empty of four slots. 45EB90 swaps any two records, including empty records.
const need=(ok,message)=>{if(!ok)throw new Error(message);};
const position=index=>need(Number.isInteger(index)&&index>=0&&index<4,'队列位置无效');

export function validateFormationSlots(slots,party){
  need(Array.isArray(slots)&&slots.length===4&&Array.isArray(party)&&party.length<=4,'队列数据无效');
  const ids=new Set(party.map(row=>row.id)),placed=slots.filter(id=>id!==null);
  need(ids.size===party.length,'队伍角色重复');
  need(placed.every(id=>typeof id==='string'&&ids.has(id))&&new Set(placed).size===placed.length,'队列角色重复或不在队伍中');
  need(placed.length===ids.size,'队列缺少队伍角色');return [...slots];
}

export function admitFormationMember(slots,party,roleId){
  need(Array.isArray(slots)&&slots.length===4&&slots.every(id=>id===null||party.some(row=>row.id===id)),'队列数据无效');
  need(new Set(slots.filter(id=>id!==null)).size===slots.filter(id=>id!==null).length,'队列角色重复');
  need(party.some(row=>row.id===roleId),'加入队列的角色不在队伍中');const next=[...slots];if(next.includes(roleId))return next;
  const index=next.indexOf(null);need(index>=0,'队列已满');next[index]=roleId;return next;
}

export function partyFormationSlots(world){
  if('formation_slots' in world)return validateFormationSlots(world.formation_slots,world.party);
  // Initialization defaults are stable under roster enumeration changes.
  // Loaded games carry their actual native positions in formation_slots.
  let slots=[null,null,null,null];for(const role of [...world.party].sort((a,b)=>a.id.localeCompare(b.id)))slots=admitFormationMember(slots,world.party,role.id);
  return validateFormationSlots(slots,world.party);
}

export function exchangeFormationSlots(slots,party,first,second){
  position(first);position(second);const next=validateFormationSlots(slots,party);[next[first],next[second]]=[next[second],next[first]];return next;
}
