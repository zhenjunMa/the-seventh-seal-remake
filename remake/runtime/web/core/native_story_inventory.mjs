// 4618FF case5: index0 grants; any nonzero index calls 47C8E0(-1,id).
// 47C8E0 consumes the first inventory record, then the first owned native
// role/category/entry match. Linked attributes are derived from retained rows;
// removing gear never refills or rewrites a character's raw HP/MP.
import {allPartyRoles} from './party_roster.mjs';
import {withItemQuantity} from './equipment.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(`原剧情道具：${message}`);};
const slots=['weapon','head','necklace','ring','badge','special'];
export function removeNativeStoryItem(draft,id){
  need(Number.isInteger(id)&&id>=0&&id<=416,'移除编号无效');
  if(id===0)return {changed:false};
  const index=draft.inventory.findIndex(row=>row.id===id);
  if(index>=0){
    const row=draft.inventory[index],raw=rawView(row.source_raw_hex);
    need(raw.getUint32(0,true)===id&&raw.getUint32(4,true)===row.quantity&&row.quantity>=1&&row.quantity<=99,'背包数量与原实例不同');
    if(row.quantity===1)draft.inventory.splice(index,1);
    else draft.inventory[index]=withItemQuantity(row,row.quantity-1);
    return {changed:true,storage:'inventory',instance_id:row.instance_id};
  }
  // A remake owns instantiated native roles in active+reserve. Source initial
  // rows for roles never instantiated are provenance, not new owned actors.
  for(const role of [...allPartyRoles(draft)].sort((a,b)=>Number(a.id)-Number(b.id))){
    const retained=draft.equipment?.roles?.[role.id];
    const initial=draft.source.initial_equipment?.filter(row=>row.role_id===role.id)??[];
    const rows=retained??initial.map(row=>({instance_id:`initial:${role.id}:${row.group_index}:${row.entry_index}`,
      id:row.item_id,name:'',quantity:1,source_raw_hex:row.source_raw_hex,
      slot_id:slots[row.group_index],group_index:row.group_index,entry_index:row.entry_index}));
    const candidates=rows.map((row,index)=>({row,index,group:row.group_index??slots.indexOf(row.slot_id),entry:row.entry_index??0}));
    for(const [index,row] of (draft.crystal_sockets?.roles?.[role.id]??[]).entries())if(row)candidates.push({row,index,group:0,entry:index+1,socket:true});
    const found=candidates.sort((a,b)=>a.group-b.group||a.entry-b.entry).find(candidate=>candidate.row.id===id);
    if(!found)continue;
    if(found.socket)draft.crystal_sockets.roles[role.id][found.index]=null;
    else if(retained)retained.splice(found.index,1);
    else{
      // Current source seeds hold one initial weapon per role. Preserve any
      // other initial entry rather than inventing a name/slot for a future form.
      need(rows.length===1,'多件初装物品的实体化来源缺失');
      draft.equipment??={version:1,roles:{}};draft.equipment.roles[role.id]=[];
    }
    return {changed:true,storage:found.socket?'crystal':'equipment',role_id:role.id,instance_id:found.row.instance_id};
  }
  return {changed:false};
}
function rawView(raw){
  need(typeof raw==='string'&&/^(?:[0-9a-f]{2}){229}$/.test(raw),'物品原实例无效');
  return new DataView(Uint8Array.from(raw.match(/../g),part=>parseInt(part,16)).buffer);
}
