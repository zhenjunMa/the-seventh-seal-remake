import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {WorldMapController} from '../web/core/world_map.mjs';
import {worldMapEntry} from '../web/core/map_connections.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {admitPartyMember,deactivatePartyMember} from '../web/core/party_members.mjs';
import {migrateEquipment} from '../web/core/equipment.mjs';
import {initialEncounterState} from '../web/core/encounters.mjs';
import {applyExperience} from '../web/core/battle_rewards.mjs';
import {jadeLakeSource,jadeLakeWorld,jadeLakeRunner,jadeLakeRead,lakeMapIds} from './helpers/jade_lake_world.mjs';

const source=await jadeLakeSource(),copy=structuredClone;
const [attributes,items,rewards]=await Promise.all(['party_combat','items','party_rewards'].map(jadeLakeRead));
const run=(world,mapId,triggerId,recordId,extra={})=>jadeLakeRunner(source,world,extra).runner.runTlk({mapId,triggerId,recordId});
const bit=(world,index,number)=>Boolean(world.value.flags[index]&(1<<(number-1)));
function matureKai(world){
  world.transact(draft=>{
    const index=draft.party.findIndex(role=>role.id==='002');
    draft.party[index]=applyExperience(draft.party[index],3000,rewards,()=>0,[]).role;
    draft.party[index].hp.current=42;draft.party[index].mp.current=7;
    draft.party[index].skill_progress={version:1,learned_indices:[24]};
    draft.encounters=initialEncounterState(draft.party,0x12345678);
    draft.encounters.counters['002']=57;draft.encounters.remainders['002']=7.5;
    migrateEquipment(draft,attributes,items);
  });
}

test('all lake maps retain their actual source roots and the city handoff does not invent an arrival event',async()=>{
  const generated=await jadeLakeRead('chapter_story');
  for(const mapId of [...lakeMapIds,'M01060','M01065']){
    assert.ok(runtimeContent.maps[mapId],mapId);
    const table=source.story.maps[mapId];
    assert.equal(table.header_setup_tlk_raw,0);assert.equal(table.header_entry_tlk_raw,0);
    assert.equal(runtimeContent.maps[mapId].entry_record,undefined);assert.equal(runtimeContent.maps[mapId].setup_record,undefined);
    if(table.records.length){
      assert.equal(generated.maps[mapId].source.sha256,table.source.sha256);
      assert.deepEqual(generated.maps[mapId].records.map(row=>row.raw_hex),table.records.map(row=>row.raw_hex));
    }
  }
  assert.deepEqual(runtimeContent.maps.M71014.triggers,[1,2,3]);
  assert.deepEqual(runtimeContent.maps.M71013.triggers,[1,2]);
  assert.deepEqual(runtimeContent.maps.M01065.triggers,[31]);
  assert.equal(source.story.maps.M01060.descriptors.find(row=>row.id===31).cells.length,0);
  assert.ok(!runtimeContent.maps.M01060.triggers.includes(31));
  assert.deepEqual(runtimeContent.maps.M71013.npcs,[]);
  assert.ok(!runtimeContent.programs['m01060-2'],'the rescue event remains a separate complete event chain');
});

test('the initial lake entrance and its return preserve both original route variants',async()=>{
  for(const thawed of [false,true]){
    const world=jadeLakeWorld(source,{flags:[[394,1,thawed]]});
    const result=await run(world,'M71014',2,9);
    assert.deepEqual(result.traversed,thawed?[9,11]:[9,10]);
    assert.equal(world.location.map_id,thawed?'M71011-1':'M71011');
  }
  for(const thawed of [false,true]){
    const world=jadeLakeWorld(source,{mapId:'M71013',flags:[[394,1,thawed]]}),before=world.snapshot();
    const result=await run(world,'M71013',2,14);
    assert.deepEqual(result.traversed,thawed?[14,16]:[14,15]);
    assert.equal(world.location.map_id,thawed?'M71013':'M71012-2');
    if(thawed)assert.deepEqual(world.value.location,before.location);
  }
});

test('the source 471:1 handoff runs the entire thaw animation once and preserves an interrupted flag write',async()=>{
  const early=jadeLakeWorld(source),earlyTrace=jadeLakeRunner(source,early);
  assert.deepEqual((await earlyTrace.runner.runTlk({mapId:'M71014',triggerId:3,recordId:7})).traversed,[7,12]);
  assert.equal(bit(early,394,1),false);assert.deepEqual(earlyTrace.trace.animations,[]);
  const world=jadeLakeWorld(source,{flags:[[471,1]],party:['001','002','005']}),before=world.snapshot();let staged=false;
  await assert.rejects(run(world,'M71014',3,7,{say:async({record,draft})=>{
    if(record.id===5){staged=true;assert.equal(Boolean(draft.flags[394]&1),true);throw Error('thaw dialogue interrupted');}
  }}),/thaw dialogue interrupted/);
  assert.equal(staged,true);assert.deepEqual(world.snapshot(),before);
  const {runner,trace}=jadeLakeRunner(source,world);
  await runner.runTlk({mapId:'M71014',triggerId:3,recordId:7});
  assert.equal(bit(world,394,1),true);assert.deepEqual(trace.animations,[{id:'m71014-1',commands:16}]);
  assert.equal(world.value.party.filter(row=>row.id==='002').length,1);
  assert.deepEqual((await runner.runTlk({mapId:'M71014',triggerId:3,recordId:7})).traversed,[7]);
  assert.equal(trace.animations.length,1);
});

test('the real thaw mode1 command restores the retained Kai without reading its XY or changing the leader',async()=>{
  const world=jadeLakeWorld(source,{flags:[[471,1]],party:['001','002','005']});matureKai(world);
  const grown=world.snapshot(),kai=copy(grown.party.find(row=>row.id==='002'));
  world.transact(draft=>deactivatePartyMember(draft,'002',{content:source.content}));
  const saved=await decodeSave(await encodeSave(world.snapshot()),source.mapIds),restored=new WorldStore(saved,source.mapIds),before=restored.snapshot();
  assert.deepEqual(before.reserve_party.find(row=>row.role.id==='002').role,kai);
  const command=source.story.programs['m71014-1'].commands[12];
  assert.deepEqual([command.opcode,command.u32_plus5,command.byte_plus29,command.u32_plus13,command.u32_plus17],[36,1,1,168,704]);
  const {runner}=jadeLakeRunner(source,restored);
  restored.transact(draft=>{
    const result=runner.joinActor({actorSlot:command.u32_plus5,modeRaw:command.byte_plus29,command,draft});
    assert.deepEqual(result,{id:'002',added:true,reactivated:true});
    assert.deepEqual(draft.location,before.location);assert.equal(draft.leader_id,before.leader_id);
  });
  assert.deepEqual(restored.value.party.find(row=>row.id==='002'),kai);
  assert.deepEqual(restored.value.reserve_party,[]);
  assert.deepEqual(restored.value.equipment,before.equipment);
  assert.deepEqual(restored.value.encounters,grown.encounters);
  assert.deepEqual(restored.value.formation_slots,['001','002','005',null]);
  const active=restored.snapshot();
  const poses=[],activeRunner=jadeLakeRunner(source,restored,{animationHooks:{actor:async row=>poses.push({command:row.command.index,kind:row.kind,actor:row.actor})}});
  await activeRunner.runner.runTlk({mapId:'M71014',triggerId:3,recordId:7});
  assert.deepEqual(restored.value.party,active.party);assert.deepEqual(restored.value.equipment,active.equipment);
  assert.deepEqual(restored.value.encounters,active.encounters);assert.equal(restored.value.leader_id,'001');
  // c3 moves actor0 to native(164,643); c12 native(168,704) has no
  // placement/control effect in the original 4B6720 mode1 branch.
  assert.deepEqual(restored.value.location,{map_id:'M71014',x:328,y:1286,direction:3});
  assert.ok(!poses.some(row=>row.command===12||row.kind==='control'));
});

test('the full thaw source program admits reserve Kai once and leaves a full four-person formation intact',async()=>{
  for(const full of [false,true]){
    const world=jadeLakeWorld(source,{flags:[[471,1]],party:['001','002','005']});matureKai(world);
    world.transact(draft=>{
      deactivatePartyMember(draft,'002',{content:source.content});
      if(full)for(const id of ['003','004'])admitPartyMember(draft,id,{definitions:source.story.role_definitions,content:source.content});
    });
    const before=world.snapshot(),retained=copy(before.reserve_party.find(row=>row.role.id==='002'));
    if(!full){
      await assert.rejects(run(world,'M71014',3,7,{animationHooks:{actor:async row=>{
        if(row.command.index===14)throw Error('restore view interrupted after Kai admission');
      }}}),/restore view interrupted after Kai admission/);
      assert.deepEqual(world.snapshot(),before);
    }
    const {runner,trace}=jadeLakeRunner(source,world);
    await runner.runTlk({mapId:'M71014',triggerId:3,recordId:7});
    assert.deepEqual(trace.animations,[{id:'m71014-1',commands:16}]);
    assert.equal(world.value.leader_id,before.leader_id);assert.equal(bit(world,394,1),true);
    assert.deepEqual(world.value.location,{map_id:'M71014',x:328,y:1286,direction:3});
    assert.deepEqual(world.value.equipment,before.equipment);
    if(full){
      assert.deepEqual(world.value.party,before.party);assert.deepEqual(world.value.reserve_party,before.reserve_party);
      assert.deepEqual(world.value.formation_slots,before.formation_slots);assert.deepEqual(world.value.encounters,before.encounters);
    }else{
      assert.equal(world.value.party.filter(row=>row.id==='002').length,1);
      assert.deepEqual(world.value.party.find(row=>row.id==='002'),retained.role);assert.deepEqual(world.value.reserve_party,[]);
      assert.equal(world.value.encounters.counters['002'],57);assert.equal(world.value.encounters.remainders['002'],7.5);
      assert.equal(world.value.encounters.rng_state,before.encounters.rng_state);
    }
    const completed=world.snapshot();
    assert.deepEqual((await runner.runTlk({mapId:'M71014',triggerId:3,recordId:7})).traversed,[7]);
    assert.deepEqual(world.value.party,completed.party);assert.deepEqual(world.value.reserve_party,completed.reserve_party);
  }
});

test('the east lake exit commits its source visit flag before a normal city selection and save restore',async()=>{
  const world=jadeLakeWorld(source,{mapId:'M71013'}),before=world.snapshot();
  const result=await run(world,'M71013',1,1);
  assert.deepEqual(result.traversed,[1,2,17]);assert.deepEqual(result.world_map_requested,{area:0});
  assert.equal(bit(world,393,1),true);assert.equal(world.value.world_map.areas[0].selected_index,2);
  assert.equal(world.value.world_map.areas[0].statuses[0],0);
  const views=[],controller=new WorldMapController({world,data:source.worldMap,
    prepare:async destination=>({location:worldMapEntry({},destination,source.story)}),
    load:(prepared,location)=>views.push(copy(location))});
  controller.open(0);await controller.select(0);
  assert.deepEqual(world.location,{map_id:'M01060',x:112,y:1616,direction:2});
  assert.deepEqual(views,[world.location]);assert.deepEqual(world.value.party,before.party);assert.deepEqual(world.value.inventory,before.inventory);
  const saved=await decodeSave(await encodeSave(world.snapshot()),source.mapIds),restored=new WorldStore(saved,source.mapIds);
  assert.deepEqual(restored.snapshot(),world.snapshot());
  const returned=await run(restored,'M01060',6,56);
  assert.deepEqual(returned.traversed,[56,57,58,59,60]);assert.deepEqual(returned.world_map_requested,{area:0});
  assert.equal(restored.value.world_map.areas[0].statuses[2],0);assert.equal(bit(restored,393,1),true);
});

test('a failed city view handoff retains the completed lake world and can retry',async()=>{
  const world=jadeLakeWorld(source,{mapId:'M71013'});await run(world,'M71013',1,1);
  const before=world.snapshot(),checkpoint={map_id:'M71013'};let rollbacks=0,fail=true;
  const controller=new WorldMapController({world,data:source.worldMap,
    prepare:async destination=>({location:worldMapEntry({},destination,source.story)}),
    captureView:()=>checkpoint,rollbackView:value=>{assert.equal(value,checkpoint);rollbacks++;},
    load:()=>{if(fail)throw Error('city texture unavailable');}});
  controller.open(0);await assert.rejects(controller.select(0),/city texture unavailable/);
  assert.deepEqual(world.snapshot(),before);assert.equal(rollbacks,1);assert.equal(controller.phase,'open');
  fail=false;await controller.select(0);assert.equal(world.location.map_id,'M01060');
});

test('the late lake city route preserves 124:1, complete 05.bik call and the one-time canal-gate event',async()=>{
  const world=jadeLakeWorld(source,{mapId:'M71050',flags:[[471,1]],party:['001','002','005']}),before=world.snapshot();
  await assert.rejects(run(world,'M71050',3,1,{transfer:async()=>{throw Error('canal map unavailable');}}),/canal map unavailable/);
  assert.deepEqual(world.snapshot(),before);
  const transfer=await run(world,'M71050',3,1);
  assert.deepEqual(transfer.traversed,[1,4,5]);assert.equal(bit(world,124,1),true);
  assert.deepEqual(world.location,{map_id:'M01065',x:272,y:400,direction:2});
  const beforeMovie=world.snapshot();let movies=0;
  await assert.rejects(jadeLakeRunner(source,world,{animationHooks:{media:async({filename})=>{
    assert.equal(filename,'05.bik');assert.equal(bit(world,384,2),false);movies++;throw Error('05 movie interrupted');
  }}}).runner.runTlk({mapId:'M01065',triggerId:31,recordId:65}),/05 movie interrupted/);
  assert.equal(movies,1);assert.deepEqual(world.snapshot(),beforeMovie);
  const party=copy(world.value.party),{runner,trace}=jadeLakeRunner(source,world);
  await runner.runTlk({mapId:'M01065',triggerId:31,recordId:65});
  assert.equal(bit(world,384,2),true);assert.equal(bit(world,384,1),false);
  assert.deepEqual(trace.animations,[{id:'m71050-1',commands:29}]);assert.deepEqual(trace.media,['05.bik']);
  assert.deepEqual(world.location,{map_id:'M01060',x:200,y:1572,direction:2});assert.deepEqual(world.value.party,party);
  const restored=new WorldStore(await decodeSave(await encodeSave(world.snapshot()),source.mapIds),source.mapIds);
  restored.transact(draft=>{draft.location={...beforeMovie.location};});
  const repeated=jadeLakeRunner(source,restored);
  assert.deepEqual((await repeated.runner.runTlk({mapId:'M01065',triggerId:31,recordId:65})).traversed,[65]);
  assert.deepEqual(repeated.trace.media,[]);
});

test('both admitted communication crystals require interaction and save only after their events commit',async()=>{
  for(const [mapId,recordId]of [['M71014',15],['M01060',61]]){
    const world=jadeLakeWorld(source,{mapId}),before=world.snapshot();
    await assert.rejects(jadeLakeRunner(source,world).runner.runTlk({mapId,recordId}),/主动交互入口/);
    assert.deepEqual(world.snapshot(),before);
    const {runner}=jadeLakeRunner(source,world,{choose:async()=>{assert.deepEqual(world.snapshot(),before);return 0;}});
    const result=await runner.runTlk({mapId,recordId,context:{steps:0,explicitInteraction:true}});
    assert.equal(result.save_requested,true);assert.equal(world.value.revision,before.revision+1);
    assert.deepEqual(await decodeSave(await encodeSave(world.snapshot()),source.mapIds),world.snapshot());
  }
});
