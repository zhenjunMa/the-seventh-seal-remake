// YC-03 rules fixture. DAT exits select exact source entry coordinates; this
// does not simulate walking, render poses, or claim a prior campaign playthrough.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {WorldStore,encodeSave,decodeSave} from '../../web/core/world.mjs';
import {ChapterRunner,chapterObjectState} from '../../web/core/chapter.mjs';
import {ChapterAnimationRunner} from '../../web/core/chapter_animation.mjs';
import {admitPartyMember} from '../../web/core/party_members.mjs';
import {runtimeContent} from '../../web/core/content_registry.mjs';
import {worldMapEntry,chapterRouteExits} from '../../web/core/map_connections.mjs';
import {WorldMapController} from '../../web/core/world_map.mjs';
import {loadEncounterMap} from '../../web/core/encounters.mjs';

globalThis.crypto??=webcrypto;
export const innerWhiteForestMapIds=['M70071','M70072','M70073','M70075','M70076','M70074_1','M70074_2'];
const read=async name=>JSON.parse(await readFile(new URL(`../../web/data/${name}.json`,import.meta.url),'utf8'));
export const innerWhiteForestOriginal=path=>readFile(new URL(path,new URL('../../../../',import.meta.url)));

export async function innerWhiteForestSource(content=runtimeContent){
  const [story,seed,worldMap,resources,items,attributes,itemConfiguration,configuration,encounterData]=await Promise.all(['chapter_story','opening_seed','world_map','chapter_map_resources','items','party_combat','config/items','config/index','encounters'].map(read));
  const ids=Object.keys(content.maps);
  const maps=Object.fromEntries(await Promise.all(ids.map(async id=>{
    const map=await read(`maps/${id.toLowerCase()}`);
    const extra=[...(resources.exits_by_map[id]??[]),...chapterRouteExits(id,story,resources,content)];
    map.exits=[...(map.exits??[]).filter(exit=>!extra.some(row=>row.id===exit.id)),...extra];
    return [id,map];
  })));
  return {story,seed,worldMap,resources,items,attributes,itemConfiguration,configuration,encounterData,maps,content,mapIds:ids};
}

export function innerWhiteForestWorld(source){
  const value=structuredClone(source.seed);value.opening.status='complete';
  admitPartyMember(value,'002',{definitions:source.story.role_definitions,content:source.content});
  // Explicit source handoff to the existing city NPC, with the original party,
  // money and source provenance retained. No quest flag or quest item is injected.
  value.location={map_id:'M01051',x:424,y:334,direction:3};
  return new WorldStore(value,source.mapIds);
}

export function innerWhiteForestRunner(source,world,extra={}){
  const {battle=async()=>({outcome:'victory'}),animationHooks={},...runnerExtra}=extra;
  const trace={animations:[],battles:[],objects:[],transfers:[],actors:[],dialogues:[]};
  const runner=new ChapterRunner({world,data:source.story,content:source.content,wait:async()=>{},
    say:async({mapId,record})=>trace.dialogues.push([mapId,record.id]),choose:async({choices})=>choices[0].index,
    objectAnimation:async({mapId,objectIndex})=>trace.objects.push([mapId,objectIndex]),
    battle:async payload=>{trace.battles.push(payload.group);return battle(payload);},
    worldMapState:()=>({areas:source.worldMap.areas.map(({id,selected_index,statuses})=>({id,selected_index,statuses:[...statuses]}))}),
    transfer:async({destination,draft})=>{loadEncounterMap(draft,destination.map_id,source.encounterData);trace.transfers.push(destination);return {location:worldMapEntry({},destination,source.story)};},
    animate:async({program,runTlk,joinActor,leaveActor,flagCommand,draft,playback})=>{
      const hooks=Object.fromEntries(['map','actor','move','camera','wait','fade','sound','media'].map(name=>[name,async()=>{}]));
      hooks.map=async({mapId,bootstrap})=>{if(!bootstrap)loadEncounterMap(draft,mapId,source.encounterData);};
      hooks.actor=async row=>trace.actors.push({program:program.id,command:row.command.index,kind:row.kind,actor:row.actor,x:row.x,y:row.y,poseRaw:row.poseRaw});
      for(const [name,hook]of Object.entries(animationHooks)){
        const base=hooks[name];hooks[name]=async row=>{await base(row);return hook(row);};
      }
      const result=await new ChapterAnimationRunner({program,content:source.content,runTlk,joinActor,leaveActor,flagCommand,playback,
        initialLocation:draft.location,initialActor:Number(draft.leader_id)-1,hooks}).run();
      // Facing is a presentation responsibility. Keep the incoming facing here
      // and make assertions only about source XY, actor commands and world rules.
      draft.location={...result.location,direction:draft.location.direction};
      trace.animations.push({id:program.id,commands:result.commands});
    },...runnerExtra});
  return {runner,trace};
}

export function innerWhiteForestRoute(source,world,...ids){
  for(const id of ids){
    const mapId=world.location.map_id,exit=source.maps[mapId].exits.find(row=>row.state==='ready'&&row.target_map===id);
    assert.ok(exit,`Missing admitted DAT exit ${mapId} -> ${id}`);assert.deepEqual(exit.conditions,[]);
    world.transact(draft=>{draft.location={map_id:id,x:exit.entry.x,y:exit.entry.y,direction:exit.entry.direction};
      draft.native_map_sort_code=exit.source.entry_sort_code;delete draft.map_npc_state;
      loadEncounterMap(draft,id,source.encounterData);});
  }
}

export async function innerWhiteForestSelect(source,world,index){
  const controller=new WorldMapController({world,data:source.worldMap,
    prepare:async destination=>({location:worldMapEntry({},destination,source.story)}),load(){},
    enter:async(prepared,draft)=>{loadEncounterMap(draft,prepared.location.map_id,source.encounterData);}});
  controller.open(0);await controller.select(index);
}

// Replay the shared YC-03 source chain once; later phases reuse its naturally
// earned quest flags, items and admitted party instead of injecting a handoff.
export async function innerWhiteForestComplete(source,{world=innerWhiteForestWorld(source)}={}){
  const copy=structuredClone;
  const quantity=(world,id)=>world.value.inventory.filter(row=>row.id===id).reduce((n,row)=>n+row.quantity,0);
  const bit=(world,index,number)=>Boolean(world.value.flags[index]&(1<<(number-1)));
  const npc=(runner,mapId,slot)=>runner.runTlk({mapId,recordId:source.story.maps[mapId].index_nonzero.find(row=>row.slot===slot).record,
    context:{steps:0,explicitInteraction:true,npcMapId:mapId,npcSlot:slot}});
  const restore=async world=>{const saved=world.snapshot();world.replace(await decodeSave(await encodeSave(saved),source.mapIds));assert.deepEqual(world.snapshot(),saved);};

  const initial=world.snapshot();let defeat=false;
  const {runner,trace}=innerWhiteForestRunner(source,world,{battle:async({draft})=>{
    if(defeat){draft.party[0].hp.current=1;throw Error('YC-03 battle defeat');}return {outcome:'victory'};
  }});
  await npc(runner,'M01051',10);
  assert.equal(bit(world,31,1),true);assert.equal(bit(world,31,2),false);
  assert.equal(world.value.world_map.areas[0].statuses[3],0);
  innerWhiteForestRoute(source,world,'M01050');await npc(runner,'M01050',15);
  assert.equal(quantity(world,332),0);assert.equal(bit(world,5,1),false);
  innerWhiteForestRoute(source,world,'M01040','M01060');
  await runner.runTlk({mapId:'M01060',triggerId:6,recordId:56});await innerWhiteForestSelect(source,world,3);
  assert.equal(world.location.map_id,'M70071');
  await runner.runObject({mapId:'M70071',objectIndex:12});assert.equal(quantity(world,349),1);
  await restore(world);assert.equal((await runner.runObject({mapId:'M70071',objectIndex:12})).already_done,true);
  assert.equal(quantity(world,349),1);
  innerWhiteForestRoute(source,world,'M70072');
  assert.deepEqual((await runner.runObject({mapId:'M70072',objectIndex:13})).traversed,[1,2,4]);
  assert.equal(bit(world,97,1),false);
  innerWhiteForestRoute(source,world,'M70071');
  await runner.runTlk({mapId:'M70071',triggerId:4,recordId:1});await innerWhiteForestSelect(source,world,0);
  innerWhiteForestRoute(source,world,'M01040','M01050','M01051');await npc(runner,'M01051',10);
  assert.equal(quantity(world,349),0);assert.equal(bit(world,31,2),true);
  assert.ok([252,253].every(index=>world.value.recipe_unlock_indices.includes(index)));await restore(world);
  innerWhiteForestRoute(source,world,'M01050');await npc(runner,'M01050',15);
  assert.equal(bit(world,5,1),true);assert.equal(quantity(world,332),1);
  await npc(runner,'M01050',15);assert.equal(quantity(world,332),1);
  assert.equal(trace.animations.filter(row=>row.id==='m01050-1').length,1);
  innerWhiteForestRoute(source,world,'M01040','M01060');
  await runner.runTlk({mapId:'M01060',triggerId:6,recordId:56});await innerWhiteForestSelect(source,world,3);
  innerWhiteForestRoute(source,world,'M70073');
  const beforeFight=world.snapshot();defeat=true;
  await assert.rejects(runner.runTlk({mapId:'M70073',triggerId:31,recordId:1}),/YC-03 battle defeat/);
  assert.deepEqual(world.snapshot(),beforeFight);assert.equal(bit(world,98,1),false);defeat=false;
  await runner.runTlk({mapId:'M70073',triggerId:31,recordId:1});
  assert.equal(bit(world,98,1),true);assert.deepEqual(trace.battles.map(row=>[row.stage,row.members.map(member=>member.id)]),
    [['stage03.scn',['042']],['stage03.scn',['042']]]);
  assert.deepEqual(trace.animations.filter(row=>row.id==='m70073-1'),[{id:'m70073-1',commands:56}]);
  const afterFight=world.snapshot();assert.deepEqual([afterFight.location.x,afterFight.location.y],[288,1200]);
  assert.ok(trace.actors.some(row=>row.program==='m70073-1'&&row.command===27&&row.kind==='behavior'&&row.actor===10));
  await restore(world);
  assert.deepEqual((await runner.runTlk({mapId:'M70073',triggerId:31,recordId:1})).traversed,[1]);
  assert.deepEqual(world.location,afterFight.location);assert.equal(trace.battles.length,2);
  const moonOnly=new WorldStore(copy(afterFight),source.mapIds),moonRunner=innerWhiteForestRunner(source,moonOnly).runner;
  innerWhiteForestRoute(source,moonOnly,'M70076');await moonRunner.runObject({mapId:'M70076',objectIndex:7});
  innerWhiteForestRoute(source,moonOnly,'M70073','M70072');
  assert.deepEqual((await moonRunner.runObject({mapId:'M70072',objectIndex:13})).traversed,[1,2,6,4]);
  assert.equal(quantity(moonOnly,294),1);assert.equal(bit(moonOnly,97,1),false);
  innerWhiteForestRoute(source,world,'M70075');await runner.runObject({mapId:'M70075',objectIndex:7});
  assert.equal(quantity(world,293),1);assert.equal(quantity(world,332),1);
  innerWhiteForestRoute(source,world,'M70073','M70072');
  await runner.runObject({mapId:'M70072',objectIndex:13});
  assert.equal(quantity(world,293),1);assert.equal(bit(world,97,1),false);
  innerWhiteForestRoute(source,world,'M70073','M70076');await runner.runObject({mapId:'M70076',objectIndex:7});
  assert.equal(quantity(world,294),1);assert.equal(quantity(world,332),1);
  assert.equal((await npc(runner,'M70076',10)).save_requested,true);await restore(world);
  innerWhiteForestRoute(source,world,'M70073','M70072');
  const beforeGate=world.snapshot(),transfer=runner.transfer;
  runner.transfer=async({draft})=>{
    assert.equal(draft.flags[97]&1,1);assert.ok(!draft.inventory.some(row=>[293,294].includes(row.id)));
    throw Error('YC-03 gate target unavailable');
  };
  await assert.rejects(runner.runObject({mapId:'M70072',objectIndex:13}),/YC-03 gate target unavailable/);
  assert.deepEqual(world.snapshot(),beforeGate);runner.transfer=transfer;
  runner.choose=async()=>1;
  const leave=await runner.runObject({mapId:'M70072',objectIndex:13});
  assert.deepEqual(leave.traversed,[1,2,6,7,8,9,3]);assert.equal(world.location.map_id,'M70072');
  assert.equal(bit(world,97,1),true);assert.equal(quantity(world,293)+quantity(world,294),0);
  assert.equal(chapterObjectState(world.value,'M70072',13,source.story),0);await restore(world);
  assert.deepEqual((await runner.runObject({mapId:'M70072',objectIndex:13})).traversed,[1,3]);
  const sort=world.value.native_map_sort_code,releases=[];
  runner.transfer=async payload=>({...await transfer(payload),release:({failed})=>{
    releases.push(failed);assert.equal(world.location.map_id,'M70074_1');
  }});
  runner.choose=async()=>0;await runner.runObject({mapId:'M70072',objectIndex:13});
  assert.equal(world.location.map_id,'M70074_1');assert.equal(quantity(world,332),1);
  assert.equal(world.value.native_map_sort_code,sort);assert.deepEqual(releases,[false]);
  assert.equal(trace.objects.some(([id,index])=>id==='M70072'&&index===13),false);
  innerWhiteForestRoute(source,world,'M70074_2');await runner.runObject({mapId:'M70074_2',objectIndex:12});
  assert.equal(quantity(world,299),1);await restore(world);
  assert.equal((await runner.runObject({mapId:'M70074_2',objectIndex:12})).already_done,true);
  assert.equal(quantity(world,299),1);assert.equal(quantity(world,332),1);
  innerWhiteForestRoute(source,world,'M70074_1','M70072','M70071');
  await runner.runTlk({mapId:'M70071',triggerId:4,recordId:1});await innerWhiteForestSelect(source,world,0);
  innerWhiteForestRoute(source,world,'M01040','M01050');const earned=world.snapshot();
  assert.deepEqual(earned.party,initial.party);assert.equal(earned.money,initial.money);assert.deepEqual(earned.source,initial.source);
  let complete;
  for(const [choice,id]of [[0,358],[1,348],[2,342]]){
    const branch=new WorldStore(copy(earned),source.mapIds),f=innerWhiteForestRunner(source,branch,{choose:async()=>choice});
    await npc(f.runner,'M01050',15);
    assert.equal(quantity(branch,299),0);assert.equal(quantity(branch,id),quantity(world,id)+1);
    assert.equal(bit(branch,5,3),true);assert.equal(branch.location.map_id,'M17010');
    assert.deepEqual(f.trace.animations,[{id:'m01050-2',commands:44}]);
    await f.runner.runTlk({mapId:'M17010',triggerId:31,recordId:49});
    assert.equal(branch.location.map_id,'M17014');assert.equal(bit(branch,16,1),true);
    assert.deepEqual(branch.value.party.map(role=>role.id),['001','002','005']);
    assert.deepEqual(branch.value.party.slice(0,2),initial.party);assert.deepEqual(branch.value.equipment,earned.equipment);
    assert.deepEqual(branch.value.source,initial.source);assert.equal(branch.value.money,initial.money);
    assert.equal(quantity(branch,332),1);await restore(branch);
    if(choice===0)complete=branch.snapshot();
    branch.transact(draft=>{draft.location=copy(earned.location);});const inventory=copy(branch.value.inventory);
    await npc(f.runner,'M01050',15);assert.deepEqual(branch.value.inventory,inventory);
    assert.equal(f.trace.animations.filter(row=>row.id==='m01050-2').length,1);
  }
  return new WorldStore(complete,source.mapIds);
}
