// TLK kind8 -> 462600/43A050. Prices are ITM+14C; recipes are +392/+393.
import {initializeChapterItem} from './chapter.mjs';
import {withItemQuantity} from './equipment.mjs';
import {removeNativeStoryItem} from './native_story_inventory.mjs';
import {allPartyRoles} from './party_roster.mjs';

export function readNativeService(record,table){
  if(record.native_service)return record.native_service;
  if(record.kind!==8||typeof record.raw_hex!=='string')throw new Error('城镇服务缺少原TLK记录');
  const bytes=Uint8Array.from(record.raw_hex.match(/../g),v=>parseInt(v,16)),raw=new DataView(bytes.buffer);
  const goods=Array.from({length:32},(_,i)=>raw.getUint16(0x37+i*2,true)).filter(Boolean);
  if(goods.some(id=>id>416))throw new Error('商店商品编号超出原ITM表');
  const npc=table.npc_records.find(npc=>npc.slot_zero_based===record.speaker-1);
  const actorType=npc?parseInt(npc.raw_hex.slice(0x2c*2,0x2d*2),16):0;
  const kind=actorType===5?4:actorType===6?2:actorType===7?3:actorType?1:0;
  return {kind,goods,title:npc?.name_cp950??npc?.name??'',
    allowedModes:kind===2?['forge']:kind===3?['synthesize']:kind===4?['buy','sell','forge','synthesize']:['buy','sell']};
}

export function nativeEconomyCatalog(data){
  return Object.fromEntries(Object.entries(data.definitions).map(([key,definition])=>{
    const bytes=Uint8Array.from(definition.raw_hex.match(/../g),v=>parseInt(v,16)),raw=new DataView(bytes.buffer);
    const count=bytes[0x392];
    return [key,{...definition,price:raw.getInt32(0x14c,true),type:bytes[0x24],subtype:bytes[0x25],
      ingredients:Array.from({length:count},(_,i)=>raw.getUint32(0x393+i*4,true)).filter(Boolean)}];
  }));
}

export function nativeOwnedQuantity(world,id){
  let total=world.inventory.filter(row=>row.id===id).reduce((n,row)=>n+row.quantity,0);
  for(const role of allPartyRoles(world)){
    const worn=world.equipment?.roles?.[role.id];
    total+=(worn??world.source.initial_equipment?.filter(row=>row.role_id===role.id)??[])
      .filter(row=>(row.id??row.item_id)===id).length;
    total+=(world.crystal_sockets?.roles?.[role.id]??[]).filter(row=>row?.id===id).length;
  }
  return total;
}

export function nativeServiceRows(service,world,catalog,{mode,category='items'}){
  const equipment=category==='equipment';
  const categoryMatches=item=>equipment?item.type===2:
    item.type===5&&[1,3,4].includes(item.subtype)||item.type===3&&item.subtype===2;
  if(mode==='sell')return world.inventory.filter(row=>catalog[row.id].price!==0&&categoryMatches(catalog[row.id]))
    .map(row=>({id:row.instance_id,item_id:row.id,name:row.name,quantity:row.quantity,
      price:catalog[row.id].price>>1,enabled:true}));
  const recipeCategory=category==='items'?(mode==='forge'?'weapon':'material'):category;
  const ids=mode==='buy'?service.goods:(world.recipe_unlock_indices??[]).map(index=>index+1)
    .filter(id=>recipeCategory==='all'||recipeCategory==='weapon'&&catalog[id].type===1||
      recipeCategory==='crystal'&&catalog[id].type===3&&catalog[id].subtype===1||
      recipeCategory==='material'&&catalog[id].type===3&&catalog[id].subtype===2);
  return ids.filter(id=>mode!=='buy'||categoryMatches(catalog[id])).map(id=>{
    const item=catalog[id],owned=nativeOwnedQuantity(world,id);
    return {id,item_id:id,name:item.name,quantity:owned,price:mode==='buy'?item.price:0,
      enabled:mode==='buy'?item.price<=world.money&&owned<99:recipeCategory==='all'?false:
        item.ingredients.every(component=>nativeOwnedQuantity(world,component)>0)};
  });
}

export function applyNativeServiceAction(draft,service,catalog,{mode,id,quantity=1,category='items',mapId,recordId}){
  const row=nativeServiceRows(service,draft,catalog,{mode,category}).find(row=>row.id===id);
  if(!row||!service.allowedModes.includes(mode)||!Number.isInteger(quantity)||quantity<1||quantity>99)
    return {changed:false,message:'请选择有效的物品及数量。'};
  const item=catalog[row.item_id];
  if(mode==='sell'){
    if(quantity>row.quantity)return {changed:false,message:'持有数量不足。'};
    for(let i=0;i<quantity;i++)removeNativeStoryItem(draft,row.item_id);
    draft.money=(draft.money+row.price*quantity)>>>0;
    return {changed:true,message:`卖出${item.name} ×${quantity}。`};
  }
  if(mode==='buy'){
    if(row.price*quantity>draft.money)return {changed:false,message:'金钱不足。'};
    if(nativeOwnedQuantity(draft,item.id)+quantity>99)return {changed:false,message:'同种物品最多持有99件。'};
  }else{
    if(!row.enabled)return {changed:false,message:'合成材料不足。'};
    quantity=1;
  }
  const stack=draft.inventory.find(row=>row.id===item.id&&parseInt(row.source_raw_hex.slice(24,26),16)===0);
  if(item.type!==1&&!stack&&draft.inventory.length>=1000)return {changed:false,message:'背包已满。'};
  const sourceRaw=initializeChapterItem(item,{allowWeapon:true});
  new DataView(sourceRaw.buffer).setUint32(4,quantity,true);
  const created={instance_id:`service:${mapId}:${recordId}:${crypto.randomUUID()}`,id:item.id,name:item.name,quantity,
    source_raw_hex:Array.from(sourceRaw,v=>v.toString(16).padStart(2,'0')).join(''),
    source_definition:item.source,initialization_source:'native-service-47B3C0-47BFF0'};
  if(mode==='buy')draft.money=(draft.money-row.price*quantity)>>>0;
  else for(const component of item.ingredients){
    if(!removeNativeStoryItem(draft,component).changed)return {changed:true,message:'材料已不足，本次未能合成。'};
  }
  if(item.type===1){
    const roles=allPartyRoles(draft),mask=item.allowed_role_mask_raw_13e;
    const candidates=[roles.find(role=>role.id===draft.leader_id),...roles.slice().sort((a,b)=>Number(a.id)-Number(b.id))].filter(Boolean);
    const role=candidates.find(role=>mask===0||(mask&(1<<(Number(role.id)-1)))!==0);
    if(!role)throw new Error('锻造武器的原角色尚未拥有');
    draft.equipment??={version:1,roles:{}};
    const worn=draft.equipment.roles[role.id]??(draft.source.initial_equipment??[]).filter(row=>row.role_id===role.id).map(row=>({
      instance_id:`initial:${role.id}:${row.group_index}:${row.entry_index}`,id:row.item_id,name:catalog[row.item_id].name,
      quantity:1,slot_id:catalog[row.item_id].slot_id,source_raw_hex:row.source_raw_hex}));
    draft.equipment.roles[role.id]=[...worn.filter(row=>row.slot_id!=='weapon'),{...created,slot_id:'weapon'}];
  }else if(stack){
    draft.inventory[draft.inventory.indexOf(stack)]=withItemQuantity(stack,Math.min(99,stack.quantity+quantity));
  }else draft.inventory.push(created);
  return {changed:true,item_id:item.id,message:`${mode==='buy'?'购得':'制成'}${item.name} ×${quantity}。`};
}
