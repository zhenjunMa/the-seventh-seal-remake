// Guild rule continuation from an earned main-story handoff. DAT routes,
// services, original encounter RNG and rewards earn all state and materials.
// Battle victory callbacks and instant presentation do not prove real fights.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WorldStore,encodeSave,decodeSave} from '../../web/core/world.mjs';
import {WorldMapController} from '../../web/core/world_map.mjs';
import {worldMapEntry} from '../../web/core/map_connections.mjs';
import {storyBindings} from '../../web/core/content_registry.mjs';
import {loadEncounterMap,previewMovement} from '../../web/core/encounters.mjs';
import {nativeEconomyCatalog,readNativeService,applyNativeServiceAction,nativeOwnedQuantity} from '../../web/core/native_economy.mjs';
import {createRewardLedger,collectEnemyDefeat,planVictoryRewards} from '../../web/core/battle_rewards.mjs';
import {createNativeRng} from '../../web/core/combat_rules.mjs';
import {createPartyActors} from '../../web/core/party_attributes.mjs';
import {questJournal} from '../../web/core/story_quests.mjs';
import {windRegionComplete} from './wind_region_world.mjs';
import {innerWhiteForestRunner,innerWhiteForestRoute} from './inner_white_forest_world.mjs';
import {innerWhiteForestSealComplete} from './inner_white_forest_seal_world.mjs';
import {floatingCityComplete} from './floating_city_world.mjs';
import {yc05Jl03Complete} from './yc05_jl03_world.mjs';
import {floatingCitySecondComplete} from './floating_city_pc02_world.mjs';
import {forestSealComplete,templeComplete} from './fairy_forest_temple_world.mjs';

const read=async name=>JSON.parse(await readFile(new URL(`../../web/data/${name}.json`,import.meta.url),'utf8'));

export async function guildComplete(source,{world,checkpoint=async()=>{},battle=async()=>({outcome:'victory'}),verifyFailures=true,peaceful=true}={}){
  const mainPrerequisites=[];let earlyClues=null;
  if(world)assert.ok(world.value.flags[3]&8,'工会下水道缺少炎城早期侦探线索3:4；107:1或426:1之后原NPC已改走后期分支，须使用早期完整链交接，不能补旗标或跳内部根');
  else{
    world=(await innerWhiteForestSealComplete(source,{beforeCity:async current=>{
      const {runner,trace}=innerWhiteForestRunner(source,current);
      const talk=(mapId,slot)=>runner.runTlk({mapId,recordId:source.story.maps[mapId].index_nonzero.find(row=>row.slot===slot).record,
        context:{steps:0,explicitInteraction:true,npcMapId:mapId,npcSlot:slot}});
      assert.equal(current.value.flags[107]&1,0);assert.equal(current.value.flags[426]&1,0);
      innerWhiteForestRoute(source,current,'M01050');
      while(!(current.value.flags[5]&2**30))await talk('M01050',12);
      innerWhiteForestRoute(source,current,'M01040','M01030');
      await talk('M01030',19);assert.ok(current.value.flags[3]&4);
      await talk('M01030',19);assert.ok(current.value.flags[3]&8);
      innerWhiteForestRoute(source,current,'M01040','M01050','M01051');
      earlyClues={dialogues:trace.dialogues,flags:{3:current.value.flags[3],5:current.value.flags[5]},location:current.location,
        scope:'原51/48前置之后、107/426主线切换之前，经蒂娜完整NPC根和侦探完整NPC根赚取5:31、3:3及3:4；无旗标注入。'};
    }})).world;
    mainPrerequisites.push({stage:'inner-white-forest-seal',location:world.location});
    for(const [stage,complete]of [['floating-city',floatingCityComplete],['yc05-jl03',yc05Jl03Complete],
      ['floating-city-second',floatingCitySecondComplete],['forest-seal',forestSealComplete],['temple',templeComplete],['wind-region',windRegionComplete]]){
      world=(await complete(source,{world})).world;mainPrerequisites.push({stage,location:world.location});
    }
  }
  if(world.location.map_id==='M72061'&&(world.value.flags[465]&1)&&!(world.value.flags[12]&1))
    world=(await windRegionComplete(source,{world,verifyFailures:false})).world;
  const catalog=nativeEconomyCatalog(source.items),[rewards,skills,{quests}]=await Promise.all(['party_rewards','party_skills','story/shared'].map(read));
  const bit=(index,n)=>Boolean(world.value.flags[index]&2**(n-1));
  const quantity=id=>nativeOwnedQuantity(world.value,id);
  const journal=()=>questJournal(quests,world.value).find(row=>row.id==='guild-progression');
  let choices={},serviceActions=[];
  const {runner,trace}=innerWhiteForestRunner(source,world,{battle,
    choose:async({mapId,record,choices:rows})=>choices[`${mapId}:${record.id}`]??rows[0].index,
    sound:({token})=>trace.sounds.push({token,after_dialogue:trace.dialogues.at(-1)}),
    service:async({mapId,record,table,draft})=>{
      const service=readNativeService(record,table);
      for(const action of serviceActions){
        const result=applyNativeServiceAction(draft,service,catalog,{...action,mapId,recordId:record.id});
        assert.equal(result.changed,true,`${mapId}:${record.id} ${JSON.stringify(action)}: ${result.message}`);
        trace.services.push({map_id:mapId,record_id:record.id,action,result});
      }
      serviceActions=[];
    }});
  trace.services=[];trace.routes=[];trace.farming=[];trace.checkpoints=[];trace.sounds=[];
  trace.early_clues=earlyClues;trace.main_prerequisites=mainPrerequisites;
  const transfer=runner.transfer;
  runner.transfer=async payload=>{
    const result=await transfer(payload),mapId=payload.destination.map_id,binding=storyBindings(mapId,source.content);
    payload.draft.location=structuredClone(result.location);
    if(binding.setup_record)await runner.runTlk({mapId,recordId:binding.setup_record,draft:payload.draft});
    return {...result,location:structuredClone(payload.draft.location)};
  };
  const save=async name=>{const before=world.snapshot();world.replace(await decodeSave(await encodeSave(before),source.mapIds));assert.deepEqual(world.snapshot(),before);
    trace.checkpoints.push({name,location:world.location,rank_flags:[world.value.flags[386],world.value.flags[419]]});await checkpoint(name,world,trace);};
  const npc=(mapId,slot)=>runner.runTlk({mapId,recordId:source.story.maps[mapId].index_nonzero.find(row=>row.slot===slot).record,
    context:{steps:0,explicitInteraction:true,npcMapId:mapId,npcSlot:slot}});
  const path=(from,to)=>{
    const queue=[[from]],seen=new Set([from]);
    while(queue.length){const row=queue.shift(),last=row.at(-1);if(last===to)return row;
      for(const exit of source.maps[last].exits)if(exit.state==='ready'&&exit.target_map&&!seen.has(exit.target_map)){
        seen.add(exit.target_map);queue.push([...row,exit.target_map]);}}
    return null;
  };
  const route=async ids=>{for(const id of ids){trace.routes.push([world.location.map_id,id]);innerWhiteForestRoute(source,world,id);
    const binding=storyBindings(id,source.content);
    if(binding.setup_record)await runner.runTlk({mapId:id,recordId:binding.setup_record});
    if(binding.entry_record)await runner.runTlk({mapId:id,recordId:binding.entry_record});}};
  const gateways=[['M01060',0,6],['M03060',1,9],['M29010',1,1],['M70010',0,4],['M71071',0,2],['M71014',0,1],['ELF-FOREST-A',1,2],['M17010',0,null],['REBIRTH-B04',1,2]];
  const depart=async()=>{
    const available=gateways.map(row=>({row,path:path(world.location.map_id,row[0])})).filter(row=>row.path).sort((a,b)=>a.path.length-b.path.length);
    if(!available.length){
      const portals=Object.values(source.story.maps).flatMap(table=>table.descriptors.filter(descriptor=>{
        const record=table.records.find(row=>row.id===descriptor.field_26_raw);
        return storyBindings(table.id,source.content).triggers.includes(descriptor.id)&&record?.mutation_type===0&&record.mutation_index===126&&record.mutation_bit>=1&&record.mutation_bit<=10;
      }).map(descriptor=>({mapId:table.id,descriptor,path:path(world.location.map_id,table.id)}))).filter(row=>row.path).sort((a,b)=>a.path.length-b.path.length);
      assert.ok(portals.length,`No earned research return route from ${world.location.map_id}`);
      const portal=portals[0];await route(portal.path.slice(1));await runner.runTrigger({mapId:portal.mapId,triggerId:portal.descriptor.id});
      assert.equal(world.location.map_id,'M71071');return depart();
    }
    const {row:[mapId,area,triggerId],path:steps}=available[0];await route(steps.slice(1));
    const result=triggerId===null?await runner.runTlk({mapId,recordId:48}):await runner.runTrigger({mapId,triggerId});
    assert.equal(result.world_map_requested.area,area);return area;
  };
  const select=async(area,index)=>{
    const controller=new WorldMapController({world,data:source.worldMap,load(){},
      prepare:async destination=>({location:worldMapEntry({},destination,source.story)}),
      enter:async(prepared,draft)=>{const mapId=prepared.location.map_id;loadEncounterMap(draft,mapId,source.encounterData);
        const binding=storyBindings(mapId,source.content);
        if(binding.setup_record)await runner.runTlk({mapId,recordId:binding.setup_record,draft});
        if(binding.entry_record){await runner.runTlk({mapId,recordId:binding.entry_record,draft});return true;}return false;}});
    controller.open(area);await controller.select(index);
  };
  const cityAirship=async toPower=>{
    if(toPower){
      await route(path(world.location.map_id,'M03023').slice(1));choices={'M03023:12':1};await npc('M03023',11);choices={};
      await route(path(world.location.map_id,'M03021-4').slice(1));await npc('M03021-4',11);assert.equal(world.location.map_id,'M29012');
    }else{
      await route(path(world.location.map_id,'M29011').slice(1));await npc('M29011',11);
      await route(path(world.location.map_id,'M29012').slice(1));await npc('M29012',11);assert.equal(world.location.map_id,'M03021-4');
    }
  };
  const travel=async(area,index)=>{
    const current=await depart();
    if(current!==area){
      if(current===0){await select(0,0);await route(path(world.location.map_id,'M01021').slice(1));await npc('M01021',12);
        await route(path(world.location.map_id,'M01022').slice(1));await npc('M01022',10);}
      else{const hub=world.value.world_map.areas[1].statuses[4]===0?4:0;await select(1,hub);if(hub===0)await cityAirship(false);
        await route(path(world.location.map_id,'M03023').slice(1));await npc('M03023',11);
        await route(path(world.location.map_id,'M03021-4').slice(1));await npc('M03021-4',11);}
      assert.equal(await depart(),area);
    }
    if(area===1&&world.value.world_map.areas[1].statuses[index]!==0){
      const toPower=[0,1,2,3].includes(index);await select(1,toPower?4:0);await cityAirship(toPower);assert.equal(await depart(),1);
    }
    await select(area,index);
  };
  const go=async target=>{
    let steps=path(world.location.map_id,target);
    // The thawed lake entrance is a conditional TLK transfer, not a DAT edge.
    if(!steps&&path('M71011-1',target)){
      await travel(0,2);await runner.runTrigger({mapId:'M71014',triggerId:2});steps=path(world.location.map_id,target);
    }
    if(!steps){const destination=source.worldMap.areas.flatMap(area=>area.destinations.map(row=>({...row,area:area.id})))
      .find(row=>source.maps[row.map_id]&&path(row.map_id,target));
      assert.ok(destination,`No admitted travel route to ${target}`);await travel(destination.area,destination.index);steps=path(world.location.map_id,target);}
    await route(steps.slice(1));assert.equal(world.location.map_id,target);
  };
  const object=async(mapId,objectIndex)=>{await go(mapId);return runner.runObject({mapId,objectIndex});};
  const service=async(mapId,slot,actions)=>{await go(mapId);serviceActions=actions;await npc(mapId,slot);assert.equal(serviceActions.length,0,'Original NPC root must actually open its service');};
  const buy=async(id,count=1)=>service('M01051',11,[{mode:'buy',id,quantity:count}]);
  const synthesize=async id=>service('M01062',10,[{mode:'synthesize',category:catalog[id].type===3&&catalog[id].subtype===1?'crystal':'material',id}]);
  const prepareRecipe=async id=>{
    if(quantity(id)>0)return;
    if([210,211,212,213,214,215,229].includes(id)){await buy(id);return;}
    if([273,274,278].includes(id)){await service('M01030',10,[{mode:'buy',id,quantity:1}]);return;}
    assert.ok(world.value.recipe_unlock_indices.includes(id-1),`Recipe ${id} must be earned before crafting`);
    for(const component of catalog[id].ingredients)await prepareRecipe(component);
    await synthesize(id);assert.ok(quantity(id)>0);
  };
  const farm=async(mapId,id,count=1)=>{
    await go(mapId);
    while(quantity(id)<count){
      let movement,encounterState=world.value.encounters,movementSteps=0;
      do{movement=previewMovement(encounterState,{party:world.value.party,leader_id:world.value.leader_id,map_id:mapId,dx:16,dy:0},source.encounterData);
        encounterState=movement.state;movementSteps+=movement.steps;}while(!movement.encounter);
      world.setEncounterState(encounterState);
      const encounter=movement.encounter,battleId=`guild-material:${trace.farming.length}`,players=createPartyActors(world.value,source.attributes,{},source.items);
      assert.equal((await battle({draft:world.snapshot(),group:encounter,scope:'guild material rule callback'})).outcome,'victory');
      const enemies=encounter.members.map((row,index)=>({id:`${row.id}:${index}`,resource_id:row.id,side:'enemy',hp:{current:0,maximum:1}}));
      const ledger=createRewardLedger(battleId,[...players,...enemies]);for(const enemy of enemies)collectEnemyDefeat(ledger,enemy,{data:rewards});
      const rng=createNativeRng(world.value.encounters.rng_state),plan=planVictoryRewards({world:world.value,ledger,data:rewards,rng,actors:[...players,...enemies],skill_data:skills});
      assert.equal(plan.applied,true);world.transact(draft=>{Object.assign(draft,plan.world_patch);draft.reward_records.push(plan.reward_record);draft.encounters.rng_state=rng.state;});
      trace.farming.push({map_id:mapId,movement_steps:movementSteps,encounter,summary:plan.summary,trace:plan.trace,scope:'Actual admitted STG selection and original reward RNG after a rule-only victory callback; no rendered fight or damage simulation.'});
    }
  };

  await save('guild_start');
  // Ordinary022 yields355/356 at the source's guaranteed rate0. These sale
  // materials fund the errands while retaining331/399 and existing equipment.
  const moneyBefore=world.value.money,pairPrice=(catalog[355].price>>1)+(catalog[356].price>>1),salePairs=Math.max(0,Math.ceil((5000-moneyBefore)/pairPrice));
  if(salePairs){await farm('M71020',355,salePairs);
    await service('M01033',10,[355,356].map(id=>({mode:'sell',category:'items',id:world.value.inventory.find(row=>row.id===id).instance_id,quantity:salePairs})));}
  trace.financing={money_before:moneyBefore,cash_needed_for_observed_errands:5000,sale_pairs:salePairs,pair_sale_price:pairPrice,money_after:world.value.money};
  await go('M01042');await save('tongs_before');
  if(verifyFailures){const failed=new WorldStore(world.snapshot(),source.mapIds),before=failed.snapshot();
    const attempt=innerWhiteForestRunner(source,failed,{say:async({record})=>{if(record.id===29)throw Error('guild admission interrupted');}});
    await assert.rejects(attempt.runner.runTlk({mapId:'M01042',recordId:31,context:{steps:0,explicitInteraction:true,npcMapId:'M01042',npcSlot:12}}),/guild admission interrupted/);
    assert.deepEqual(failed.snapshot(),before);}
  await npc('M01042',12);
  assert.ok(bit(386,2));assert.equal(journal().stage,'tongs');await save('tongs_complete');
  await npc('M01042',12);assert.ok(quantity(226)>0);await save('iron_delivery_before');
  await go('M01063');await npc('M01063',13);assert.ok(bit(29,2));await go('M01042');await npc('M01042',12);assert.ok(bit(386,5));
  await go('M01031');await npc('M01031',11);assert.ok(bit(7,1));await go('M70030');await npc('M70030',10);assert.ok(quantity(170)>0);
  await go('M01042');await save('iron_drill_before');await npc('M01042',12);assert.ok(bit(386,6));assert.equal(journal().stage,'iron-drill');await save('iron_drill_complete');
  choices={'M01042:44':1};await npc('M01042',12);choices={};assert.ok(quantity(335)>0);await save('sealed_house_before');
  await go('M01060');await runner.runTrigger({mapId:'M01060',triggerId:28});assert.equal(world.location.map_id,'M01066');
  if(verifyFailures){const failed=new WorldStore(world.snapshot(),source.mapIds),before=failed.snapshot();
    const attempt=innerWhiteForestRunner(source,failed,{battle:async()=>{throw Error('guild forbidden-caster defeat');}});
    await assert.rejects(attempt.runner.runTrigger({mapId:'M01066',triggerId:30}),/guild forbidden-caster defeat/);assert.deepEqual(failed.snapshot(),before);}
  await runner.runTrigger({mapId:'M01066',triggerId:30});assert.ok(bit(616,1));
  await go('M01042');await npc('M01042',12);assert.ok(bit(386,8));
  await go('M01060');await runner.runTrigger({mapId:'M01060',triggerId:29});
  assert.deepEqual(world.location,{map_id:'M01066',x:592,y:400,direction:6});trace.house_reentry=structuredClone(world.location);await save('house_reentry_complete');
  await save('house_gift_before');await npc('M01066',11);
  await go('M01050');await npc('M01050',11);assert.ok(bit(5,4));await runner.runTrigger({mapId:'M01050',triggerId:30});assert.equal(world.location.map_id,'M01053');
  await runner.runTrigger({mapId:'M01053',triggerId:2});
  while(!bit(396,2))await runner.runTrigger({mapId:'M01053',triggerId:2});
  await go('M01042');await save('ember_flame_before');await npc('M01042',12);assert.ok(bit(386,9));assert.equal(journal().stage,'ember-flame');await save('ember_flame_complete');
  await go('M01062');await npc('M01062',10);assert.ok([230,231,236].every(id=>world.value.recipe_unlock_indices.includes(id-1)));

  // Fixed, already admitted forest chests supply the first two crystal bases.
  await object('M70010',8);assert.ok(quantity(159)>0);await object('M70020',4);assert.ok(quantity(156)>0);
  await farm('M70010',331);
  await go('M03032');await npc('M03032',19);assert.ok(bit(419,2));await go('M03043-3');await npc('M03043-3',13);
  await prepareRecipe(231);await prepareRecipe(278);await prepareRecipe(274);
  await go('M03051');await save('moss_synthesis_before');await npc('M03051',15);assert.ok(quantity(165)>0);await save('moss_synthesis_complete');
  await go('M03032');await save('giant_hammer_before');await npc('M03032',19);assert.ok(bit(419,3));assert.equal(journal().stage,'giant-hammer');await save('giant_hammer_complete');
  await npc('M03032',19);assert.ok(bit(419,4));await go('M03051');await npc('M03051',15);assert.ok(bit(429,2));
  await go('M03043-3');await npc('M03043-3',13);await npc('M03043-3',13);
  await service('M01033',10,[{mode:'buy',id:25,quantity:1}]);
  await go('M03066');while(!bit(433,1))await npc('M03066',10);
  await farm('M70010',331);
  // The discovered ruins also have a real, keyless 21F green-ore chest.
  await go('M01030');await npc('M01030',19);await object('M71078-3-21',99);assert.ok(quantity(252)>0);
  await prepareRecipe(230);
  await go('M03051');await save('tea_synthesis_before');await npc('M03051',15);assert.ok(quantity(176)>0);await save('tea_synthesis_complete');
  await go('M03032');await save('god_drill_before');await npc('M03032',19);assert.ok(bit(419,5));assert.equal(journal().stage,'god-drill');await save('god_drill_complete');
  await object('M70050',12);await farm('M70010',331);await farm('M71020',399);await prepareRecipe(173);await prepareRecipe(224);
  await go('M01042');await save('first_weapon_forge_before');await service('M01042',10,[{mode:'forge',category:'weapon',id:253}]);
  assert.ok(Object.values(world.value.equipment.roles).some(rows=>rows.some(row=>row.id===253)));await save('first_weapon_forge_complete');
  await go('M03032');
  await npc('M03032',19);assert.ok(bit(419,6));await go('M29014');await npc('M29014',20);assert.ok(bit(521,3));await save('wolf_commissioned');
  if(peaceful){
    await go('M01050');while(!bit(5,31))await npc('M01050',12);await save('ocean_heart_before');await npc('M01050',12);assert.ok(quantity(85)>0);
    await save('ocean_heart_complete');const before=quantity(85);await npc('M01050',12);assert.equal(quantity(85),before);
  }
  await go('ELF-FOREST-E');await save('wolf_first_before');
  for(const [mapId,triggerId,flag]of [['ELF-FOREST-E',32,584],['ELF-FOREST-I',31,588],['ELF-FOREST-V',32,601]]){
    if(bit(521,4))break;await go(mapId);await save(`wolf_${mapId.at(-1).toLowerCase()}_before`);
    while(!bit(flag,1))await runner.runTrigger({mapId,triggerId});await save(`wolf_${mapId.at(-1).toLowerCase()}_complete`);
  }
  assert.ok(bit(521,4));if(peaceful)assert.ok(bit(474,2));await save('wolf_resolved');
  await go('M29014');await npc('M29014',20);assert.ok(bit(521,2));await go('M03032');await save('god_flame_before');await npc('M03032',19);
  assert.ok(bit(419,7));assert.equal(journal().stage,'god-flame');await save('god_flame_complete');
  await npc('M03032',19);assert.ok(bit(419,8));await save('research_commissioned');
  await go('M01030');await npc('M01030',19);await go('M71071');await save('research_entry');
  const floorMaps=Object.values(source.story.maps).filter(row=>/^M7107[678]-/.test(row.id)&&/地下第[0-9]+层/.test(row.name))
    .sort((a,b)=>Number(a.name.match(/[0-9]+/)[0])-Number(b.name.match(/[0-9]+/)[0]));
  await go('M71077');
  for(const floor of floorMaps){
    await go(floor.id);
    if(floor.id==='M71078-3-24'){await save('research_six_enemy_before');await runner.runObject({mapId:floor.id,objectIndex:95});}
    if(floor.id==='M71078-3-29'){await object(floor.id,98);assert.ok(quantity(391)>0);}
    const gate=source.story.maps[floor.id].descriptors.find(row=>row.state_raw===2&&row.cells.length&&row.id===3);
    if(gate){await runner.runTrigger({mapId:floor.id,triggerId:gate.id});assert.equal(world.location.map_id,'M71071');
      const n=Number(floor.name.match(/[0-9]+/)[0])/5;assert.ok(bit(126,n));await save(`research_${floor.name.match(/[0-9]+/)[0]}_gate`);
      choices={'M71071:18':0};for(let page=0;page<Math.floor((n-1)/2);page++)choices[`M71071:${19+page}`]=2;
      choices[`M71071:${19+Math.floor((n-1)/2)}`]=(n-1)%2;await runner.runTrigger({mapId:'M71071',triggerId:3});choices={};assert.equal(world.location.map_id,floor.id);}
  }
  await go('M71079');await runner.runTrigger({mapId:'M71079',triggerId:3});assert.equal(world.location.map_id,'M71071');assert.ok(bit(126,10));
  choices={'M71071:18':0,'M71071:19':2,'M71071:20':2,'M71071:21':2,'M71071:22':2,'M71071:23':1};
  await runner.runTrigger({mapId:'M71071',triggerId:3});choices={};assert.equal(world.location.map_id,'M71079');
  await go('M71080');await save('research_final_before');
  if(verifyFailures){const failed=new WorldStore(world.snapshot(),source.mapIds),before=failed.snapshot();let count=0;
    const attempt=innerWhiteForestRunner(source,failed,{battle:async()=>{if(++count===2)throw Error('guild second guardian defeat');return {outcome:'victory'};}});
    await assert.rejects(attempt.runner.runTrigger({mapId:'M71080',triggerId:2}),/guild second guardian defeat/);assert.equal(count,2);assert.deepEqual(failed.snapshot(),before);}
  await runner.runTrigger({mapId:'M71080',triggerId:2});
  assert.ok(bit(614,2));await save('research_final_complete');
  await go('M03032');await save('god_hammer_before');await npc('M03032',19);assert.ok(bit(419,9));assert.equal(journal().status,'completed');await save('god_hammer_complete');
  await prepareRecipe(205);await prepareRecipe(236);
  await go('M01042');await save('god_hammer_forge_before');await service('M01042',10,[{mode:'forge',category:'weapon',id:259}]);
  assert.ok(Object.values(world.value.equipment.roles).some(rows=>rows.some(row=>row.id===259)));await save('god_hammer_forge_complete');
  await go('M03032');
  const earned=world.snapshot();await npc('M03032',19);assert.deepEqual(world.value.inventory,earned.inventory);assert.deepEqual(world.value.recipe_unlock_indices,earned.recipe_unlock_indices);
  assert.deepEqual(world.value.flags,earned.flags);await save('guild_complete');
  // Subsequent side chains continue this earned world with the same original
  // travel, economy and reward operations, rather than injecting their inputs.
  return {world,trace,runner,go,npc,object,service,prepareRecipe,farm,save,route,travel,
    setChoices:value=>{choices=value;}};
}
