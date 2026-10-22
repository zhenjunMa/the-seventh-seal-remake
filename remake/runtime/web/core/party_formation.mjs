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
  need(world?.source?.kind==='native-new-game'&&Array.isArray(world.party),'当前队列缺少新游戏来源');
  if('formation_slots' in world)return validateFormationSlots(world.formation_slots,world.party);
  // CHR templates store both original actors at +2B3=0. They are not live
  // admission records. Verify the initial role's source position, then replay
  // the native initializer and first-empty admission for the current chapter.
  const initial=world.source.role_definitions?.['001']?.header_raw_hex;
  need(world.party.some(row=>row.id==='001')&&typeof initial==='string'&&/^(?:[0-9a-f]{2}){779}$/.test(initial),'初始队列角色来源缺失');
  const bytes=Uint8Array.from(initial.match(/../g),n=>parseInt(n,16));need(new DataView(bytes.buffer).getInt32(0x2b3,true)===0,'初始角色队列位置与原来源不同');
  let slots=['001',null,null,null];for(const role of world.party)if(role.id!=='001')slots=admitFormationMember(slots,world.party,role.id);
  return validateFormationSlots(slots,world.party);
}

export function exchangeFormationSlots(slots,party,first,second){
  position(first);position(second);const next=validateFormationSlots(slots,party);[next[first],next[second]]=[next[second],next[first]];return next;
}
