// Earn the six tablets from the completed main/guild rule route. Source DAT
// travel, services, crafting and reward RNG supply every prerequisite. The
// battle callback certifies story rules only, not combat or rendered play.
import assert from 'node:assert/strict';
import {WorldStore} from '../../web/core/world.mjs';
import {chapterObjectState} from '../../web/core/chapter.mjs';
import {nativeEconomyCatalog,nativeOwnedQuantity,readNativeService,applyNativeServiceAction} from '../../web/core/native_economy.mjs';
import {insertCrystal,removeCrystal} from '../../web/core/crystal_sockets.mjs';
import {useWorldItem,changeEquipment} from '../../web/core/items.mjs';
import {createPartyActors} from '../../web/core/party_attributes.mjs';
import {guildComplete} from './guild_world.mjs';
import {innerWhiteForestRunner,innerWhiteForestRoute} from './inner_white_forest_world.mjs';

export async function sealTabletsComplete(source,{checkpoint=async()=>{},battle=async()=>({outcome:'victory'}),verifyFailures=true}={}){
  const actions=await guildComplete(source,{checkpoint,battle,verifyFailures:false});
  const {world,trace,runner,go,npc,object,service,prepareRecipe,farm,save,setChoices}=actions;
  const bit=(index,n)=>Boolean(world.value.flags[index]&2**(n-1));
  const quantity=id=>nativeOwnedQuantity(world.value,id),catalog=nativeEconomyCatalog(source.items);
  const root=(mapId,slot)=>source.story.maps[mapId].index_nonzero.find(row=>row.slot===slot).record;
  trace.seal={start:{location:world.location,money:world.value.money,tablets:[293,294].map(id=>[id,quantity(id)]),forest_gate_open:bit(97,1)},
    battle_start:trace.battles.length,animation_start:trace.animations.length,failures:[],cancellations:[],materials:[]};
  assert.ok(bit(97,1),'The earlier forest route must have earned its permanent opening');
  assert.equal(quantity(293)+quantity(294),0,'The earlier forest route consumed its original day/moon tablets');
  await save('seal_tablets_start');

  await go('M03050');
  if(verifyFailures){
    const failed=new WorldStore(world.snapshot(),source.mapIds),before=failed.snapshot();
    const attempt=innerWhiteForestRunner(source,failed,{say:async({mapId,record})=>{if(mapId==='M03050'&&record.id===3)throw Error('seal market interruption');}});
    await assert.rejects(attempt.runner.runTrigger({mapId:'M03050',triggerId:31}),/seal market interruption/);
    assert.deepEqual(failed.snapshot(),before);trace.seal.failures.push('earth-introduction-atomic');
  }
  setChoices({'M03050:4':1});await runner.runTrigger({mapId:'M03050',triggerId:31});setChoices({});
  assert.ok(bit(24,1));assert.equal(bit(24,2),false);trace.seal.cancellations.push('earth-request-declined');
  await npc('M03050',25);assert.ok(bit(24,2));await save('seal_earth_commissioned');
  await go('ELF-FOREST-P');
  if(verifyFailures){
    const failed=new WorldStore(world.snapshot(),source.mapIds);innerWhiteForestRoute(source,failed,'ELF-FOREST-Q');const before=failed.snapshot();
    const attempt=innerWhiteForestRunner(source,failed,{battle:async()=>{throw Error('seal earth guardian defeat');}});
    await assert.rejects(attempt.runner.runTlk({mapId:'ELF-FOREST-Q',recordId:source.story.maps['ELF-FOREST-Q'].header_entry_tlk_raw}),/seal earth guardian defeat/);
    assert.deepEqual(failed.snapshot(),before);trace.seal.failures.push('earth-arrival-battle-atomic');
  }
  await go('ELF-FOREST-Q');assert.ok(bit(596,1));
  await object('ELF-FOREST-Q',20);assert.equal(quantity(388),1);await save('seal_earth_ring');
  assert.equal((await object('ELF-FOREST-Q',20)).already_done,true);assert.equal(quantity(388),1);
  await go('M03050');await npc('M03050',25);assert.ok(bit(24,3));assert.equal(quantity(388),0);assert.equal(quantity(292),1);
  const earthInventory=structuredClone(world.value.inventory);await npc('M03050',25);assert.deepEqual(world.value.inventory,earthInventory);
  await go('M03032');await npc('M03032',18);assert.ok(bit(419,1));
  await go('M03044');await npc('M03044',12);assert.ok(bit(428,1));assert.equal(world.value.world_map.areas[1].statuses[3],0);
  await save('seal_location_known');

  // Guaranteed ordinary022 drops pay the source prices. This is a real STG /
  // reward-RNG rule path after a declared victory callback, not injected cash.
  const budget=50000,moneyBefore=world.value.money,pairPrice=(catalog[355].price>>1)+(catalog[356].price>>1);
  const pairs=Math.max(0,Math.ceil((budget-moneyBefore)/pairPrice));
  if(pairs){await farm('M71020',355,pairs);await farm('M71020',356,pairs);
    await service('M01033',10,[355,356].map(id=>({mode:'sell',category:'items',id:world.value.inventory.find(row=>row.id===id).instance_id,quantity:pairs})));}
  trace.seal.financing={money_before:moneyBefore,target:budget,sale_pairs:pairs,pair_sale_price:pairPrice,money_after:world.value.money};
  assert.equal((await object('M71020',4)).locked,true);assert.equal(quantity(337),0);
  await go('M03011');await save('seal_water_before');
  if(verifyFailures){
    const poor=new WorldStore(world.snapshot(),source.mapIds),attempt=innerWhiteForestRunner(source,poor,{
      choose:async({record})=>record.id===5?1:0,
      service:async({mapId,record,table,draft})=>{
        const shop=readNativeService(record,table);
        for(const id of shop.goods){
          const item=catalog[id],purchasable=item.type===3&&item.subtype===2||item.type===5&&[1,3,4].includes(item.subtype);
          if(!purchasable||item.price<=0)continue;
          const count=Math.min(99-nativeOwnedQuantity(draft,id),Math.floor(draft.money/item.price));
          if(count)assert.equal(applyNativeServiceAction(draft,shop,catalog,{mode:'buy',id,quantity:count,mapId,recordId:record.id}).changed,true);
        }
      }});
    innerWhiteForestRoute(source,poor,'M03010','M03040','M03050');
    await attempt.runner.runTlk({mapId:'M03050',recordId:root('M03050',24),context:{steps:0,explicitInteraction:true,npcMapId:'M03050',npcSlot:24}});
    innerWhiteForestRoute(source,poor,'M03040','M03010','M03011');
    assert.ok(poor.value.money<3000,'Spend earned money only through the admitted original market shop');const before=poor.snapshot();
    await attempt.runner.runTlk({mapId:'M03011',recordId:root('M03011',14),context:{steps:0,explicitInteraction:true,npcMapId:'M03011',npcSlot:14}});
    assert.equal(poor.value.money,before.money);assert.deepEqual(poor.value.inventory,before.inventory);assert.equal(poor.value.flags[407]&2,0);
    trace.seal.failures.push('water-insufficient-cash');
  }
  setChoices({'M03011:5':1,'M03011:8':1});const waterMoney=world.value.money;await npc('M03011',14);setChoices({});
  assert.ok(bit(407,1));assert.equal(bit(407,3),false);assert.equal(world.value.money,waterMoney);trace.seal.cancellations.push('water-price-declined');
  setChoices({'M03011:12':1});await npc('M03011',14);setChoices({});
  assert.ok(bit(407,2));assert.equal(world.value.money,waterMoney);trace.seal.cancellations.push('water-increased-price-declined');
  if(verifyFailures){
    const failed=new WorldStore(world.snapshot(),source.mapIds),before=failed.snapshot();
    const attempt=innerWhiteForestRunner(source,failed,{battle:async()=>{throw Error('seal water battle defeat');}});
    await assert.rejects(attempt.runner.runTlk({mapId:'M03011',recordId:root('M03011',14),context:{steps:0,explicitInteraction:true,npcMapId:'M03011',npcSlot:14}}),/seal water battle defeat/);
    assert.deepEqual(failed.snapshot(),before);trace.seal.failures.push('water-money-map-rewards-atomic');
  }
  const waterRewards=[291,337,275,29,30,33].map(id=>[id,quantity(id)]);
  await npc('M03011',14);assert.ok(bit(407,3));assert.equal(world.value.money,waterMoney-6000);assert.equal(world.location.map_id,'M03060');
  for(const [id,before]of waterRewards)assert.equal(quantity(id),before+1);
  trace.seal.reward_use=[];
  for(const [id,resource,limit]of [[29,'hp',9999],[30,'mp',999]]){
    const actor=createPartyActors(world.value,source.attributes,{},source.items).find(row=>row.id==='001'),before=quantity(id);
    const result=useWorldItem(world,source.attributes,source.items,{instanceId:world.value.inventory.find(row=>row.id===id).instance_id,targetId:'001'});
    assert.equal(result.applied,true);assert.equal(quantity(id),before-1);assert.equal(result.actor[resource].current,actor[resource].current);
    assert.equal(result.actor[`raw_${resource}_maximum`],Math.min(limit,actor[`raw_${resource}_maximum`]+Math.trunc(actor[`raw_${resource}_maximum`]*5/100)));
    trace.seal.reward_use.push({id,resource,before:actor[`raw_${resource}_maximum`],after:result.actor[`raw_${resource}_maximum`]});
  }
  await save('seal_water_complete');await go('M03011');const waterInventory=structuredClone(world.value.inventory);
  await npc('M03011',14);assert.deepEqual(world.value.inventory,waterInventory);
  const moonKey=quantity(337),fireSealBefore=quantity(392);await object('M71020',4);assert.equal(quantity(392),fireSealBefore+1);assert.equal(quantity(337),moonKey);
  assert.equal(chapterObjectState(world.value,'M71020',4,source.story),3);await save('seal_moon_key_used');
  assert.equal((await object('M71020',4)).already_done,true);assert.equal(quantity(392),fireSealBefore+1);

  await go('M03065');await npc('M03065',10);assert.ok(bit(432,1));
  await go('M03061');await npc('M03061',10);assert.ok(bit(446,1));
  if(quantity(169)===0){await go('M19040');await npc('M19040',12);}
  if(quantity(169)===0)await object('M71078-1-08',90);
  if(quantity(399)===0)await farm('M71076-1-06',399);
  if(quantity(237)===0)await object('M71076-2-12',12);
  if(quantity(343)===0)await service('M03050',24,[{mode:'buy',id:343,quantity:1}]);
  trace.seal.materials.push({product:177,ingredients:[169,399,237,343].map(id=>[id,quantity(id)])});
  await prepareRecipe(177);assert.equal(quantity(177),1);await save('seal_wind_crystal_crafted');
  const socket={worldStore:world,attributes:source.attributes,itemData:source.items,roleId:'001',socketIndex:5};
  insertCrystal({...socket,instanceId:world.value.inventory.find(row=>row.id===177).instance_id});await save('seal_wind_crystal_socketed');
  removeCrystal(socket);await save('seal_wind_crystal_removed');assert.equal(quantity(177),1);
  await go('M03061');await npc('M03061',10);assert.equal(quantity(177),0);assert.equal(quantity(390),1);assert.ok(bit(446,2));
  await npc('M03061',10);assert.equal(quantity(390),1);
  await go('M03065');await npc('M03065',10);assert.equal(quantity(390),0);assert.equal(quantity(290),1);assert.ok(bit(432,2));
  await npc('M03065',10);assert.equal(quantity(290),1);await save('seal_wind_complete');

  await go('M03043-4');await npc('M03043-4',10);assert.equal(quantity(389),1);assert.ok(bit(434,2));
  await go('M03044');await npc('M03044',12);assert.ok(bit(434,3));
  await go('M03043-4');await npc('M03043-4',10);assert.equal(quantity(389),0);assert.equal(quantity(293),1);
  await npc('M03043-4',10);assert.equal(quantity(293),1);await save('seal_day_complete');

  await go('M29011');await npc('M29011',22);assert.ok(bit(519,2));
  await go('M29014');await npc('M29014',19);assert.ok(bit(521,1));
  const moonIngredients=[353,356,358,321,25,26,325,315],missing=moonIngredients.filter(id=>quantity(id)===0),beforeMissing=world.snapshot();
  await npc('M29014',19);assert.equal(quantity(401),0);assert.equal(bit(521,5),false);assert.equal(world.value.money,beforeMissing.money);
  assert.ok(missing.length,'The earned route must exercise a genuinely missing ingredient branch');
  trace.seal.materials.push({product:401,initially_missing:missing});
  const forestGoods=[353,356,358].filter(id=>quantity(id)===0);if(forestGoods.length)await service('M03050',24,forestGoods.map(id=>({mode:'buy',id,quantity:1})));
  const medicineGoods=[321,25,26,325,315].filter(id=>quantity(id)===0);if(medicineGoods.length)await service('M29013',12,medicineGoods.map(id=>({mode:'buy',id,quantity:1})));
  await go('M29014');await save('seal_moon_antidote_before');
  if(verifyFailures){
    const failed=new WorldStore(world.snapshot(),source.mapIds),before=failed.snapshot();
    const attempt=innerWhiteForestRunner(source,failed,{say:async({mapId,record})=>{if(mapId==='M29014'&&record.id===31)throw Error('seal antidote interruption');}});
    await assert.rejects(attempt.runner.runTlk({mapId:'M29014',recordId:root('M29014',19),context:{steps:0,explicitInteraction:true,npcMapId:'M29014',npcSlot:19}}),/seal antidote interruption/);
    assert.deepEqual(failed.snapshot(),before);trace.seal.failures.push('moon-materials-money-antidote-atomic');
  }
  const materialsBefore=moonIngredients.map(id=>[id,quantity(id)]),medicineMoney=world.value.money;
  await npc('M29014',19);assert.ok(bit(521,5));assert.equal(quantity(401),1);assert.equal(world.value.money,medicineMoney-1000);
  for(const [id,before]of materialsBefore)assert.equal(quantity(id),before-1);
  await npc('M29014',19);assert.equal(quantity(401),1);
  await go('M29011');const moonRewards=[294,67,351].map(id=>[id,quantity(id)]);await npc('M29011',22);
  assert.ok(bit(519,3));assert.equal(quantity(401),0);for(const [id,before]of moonRewards)assert.equal(quantity(id),before+1);
  const moonInventory=structuredClone(world.value.inventory);await npc('M29011',22);assert.deepEqual(world.value.inventory,moonInventory);await save('seal_moon_complete');

  await go('M29015');await npc('M29015',15);assert.ok(bit(522,1));await npc('M29015',12);assert.ok(bit(522,2));
  await go('M29011');await npc('M29011',12);assert.ok(bit(519,4));
  await go('M29015');await npc('M29015',12);assert.ok(bit(522,3));await save('seal_fire_choice_before');
  if(verifyFailures){
    const branch=new WorldStore(world.snapshot(),source.mapIds),before=branch.snapshot();
    const threat=innerWhiteForestRunner(source,branch,{choose:async({record})=>record.id===16?1:0});
    await threat.runner.runTlk({mapId:'M29015',recordId:root('M29015',15),context:{steps:0,explicitInteraction:true,npcMapId:'M29015',npcSlot:15}});
    assert.ok(branch.value.flags[522]&16);assert.equal(branch.value.money,before.money);assert.equal(nativeOwnedQuantity(branch.value,9),nativeOwnedQuantity(before,9)+1);
    for(const id of [104,19])assert.equal(nativeOwnedQuantity(branch.value,id),nativeOwnedQuantity(before,id));
    const earned=structuredClone(branch.value.inventory);await threat.runner.runTlk({mapId:'M29015',recordId:root('M29015',15),context:{steps:0,explicitInteraction:true,npcMapId:'M29015',npcSlot:15}});
    assert.deepEqual(branch.value.inventory,earned);trace.seal.threat_branch={money_paid:0,fire_tablets:nativeOwnedQuantity(branch.value,9),flag522:branch.value.flags[522]};
    const failed=new WorldStore(world.snapshot(),source.mapIds),unpaid=failed.snapshot();
    const attempt=innerWhiteForestRunner(source,failed,{say:async({mapId,record})=>{if(mapId==='M29015'&&record.id===21)throw Error('seal mineral trade interruption');}});
    await assert.rejects(attempt.runner.runTlk({mapId:'M29015',recordId:root('M29015',15),context:{steps:0,explicitInteraction:true,npcMapId:'M29015',npcSlot:15}}),/seal mineral trade interruption/);
    assert.deepEqual(failed.snapshot(),unpaid);trace.seal.failures.push('fire-mineral-money-atomic');
  }
  const fireMoney=world.value.money;await npc('M29015',15);assert.ok(bit(522,4));assert.equal(world.value.money,fireMoney-10000);assert.equal(quantity(350),1);
  await go('M29011');await save('seal_fire_guard_before');
  if(verifyFailures){
    const failed=new WorldStore(world.snapshot(),source.mapIds),before=failed.snapshot();
    const attempt=innerWhiteForestRunner(source,failed,{animationHooks:{wait:async({command})=>{if(command.index===22)throw Error('seal fire reward interruption');}}});
    await assert.rejects(attempt.runner.runTlk({mapId:'M29011',recordId:root('M29011',12),context:{steps:0,explicitInteraction:true,npcMapId:'M29011',npcSlot:12}}),/seal fire reward interruption/);
    assert.deepEqual(failed.snapshot(),before);trace.seal.failures.push('fire-complete-animation-rewards-atomic');
  }
  const fireRewards=[9,104,19].map(id=>[id,quantity(id)]);await npc('M29011',12);assert.ok(bit(519,5));assert.equal(quantity(350),0);
  for(const [id,before]of fireRewards)assert.equal(quantity(id),before+1);
  const fireInventory=structuredClone(world.value.inventory);await npc('M29011',12);assert.deepEqual(world.value.inventory,fireInventory);await save('seal_fire_complete');
  const ring={roleId:'001',slotId:'ring'};
  changeEquipment(world,source.attributes,source.items,{...ring,instanceId:world.value.inventory.find(row=>row.id===104).instance_id});await save('seal_fire_ring_equipped');
  changeEquipment(world,source.attributes,source.items,ring);await save('seal_fire_ring_removed');
  changeEquipment(world,source.attributes,source.items,{...ring,instanceId:world.value.inventory.find(row=>row.id===104).instance_id});await save('seal_fire_ring_reequipped');
  assert.equal(world.value.equipment.roles['001'].find(row=>row.slot_id==='ring').id,104);
  for(const id of [9,290,291,292,293,294])assert.equal(quantity(id),1);
  assert.equal(quantity(387),0);trace.seal.tablets=[9,290,291,292,293,294].map(id=>({id,quantity:quantity(id)}));
  await save('seal_tablets_complete');return actions;
}
