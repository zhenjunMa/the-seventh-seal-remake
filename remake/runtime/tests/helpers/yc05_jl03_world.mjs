// Continue the earned PC-01 endpoint through original DAT exits and TLK/ANM.
// Battle outcome callbacks and source clocks are rule checks, not live play.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {encodeSave,decodeSave} from '../../web/core/world.mjs';
import {StoryPlayback} from '../../web/core/story_playback.mjs';
import {allPartyRoles} from '../../web/core/party_roster.mjs';
import {MapObjectRuntime} from '../../web/core/map_objects.mjs';
import {projectMapStage} from '../../web/core/map_stage.mjs';
import {planRouteExit} from '../../web/core/route.mjs';
import {applyWorldMapCommandToDraft} from '../../web/core/world_map.mjs';
import {chapterObjectState} from '../../web/core/chapter.mjs';
import {floatingCityComplete} from './floating_city_world.mjs';
import {innerWhiteForestRunner,innerWhiteForestRoute,innerWhiteForestSelect} from './inner_white_forest_world.mjs';

export async function yc05Jl03Complete(source,{world,split=false,checkpoint=async()=>{}}={}){
  world??=(await floatingCityComplete(source)).world;
  const effects=source.effects??JSON.parse(await readFile(new URL('../../web/data/map_effects.json',import.meta.url),'utf8'));
  const retained=structuredClone(allPartyRoles(world.value));
  const bit=(index,number)=>Boolean(world.value.flags[index]&2**(number-1));
  const npc=(mapId,slot,playback)=>runner.runTlk({mapId,playback,
    recordId:source.story.maps[mapId].index_nonzero.find(row=>row.slot===slot).record,
    context:{steps:0,explicitInteraction:true,npcMapId:mapId,npcSlot:slot}});
  const trigger=(mapId,id,recordId,playback)=>runner.runTlk({mapId,triggerId:id,recordId,playback});
  const restore=async()=>{
    const saved=world.snapshot();world.replace(await decodeSave(await encodeSave(saved),source.mapIds));
    assert.deepEqual(world.snapshot(),saved);
  };
  let failBattle=false,cancelMap=null,cancelObjectState=null,playback,bookingDestination=0,model,objectTime=0;
  const {runner,trace}=innerWhiteForestRunner(source,world,{
    choose:async({mapId,record,choices})=>choices.find(row=>row.index===
      (mapId==='M01040'&&record.id===96?(split?0:1):mapId==='M03023'&&record.id===12?bookingDestination:0)).index,
    battle:async({draft})=>{
      if(failBattle){draft.party[0].hp.current=1;throw Error('YC-05 ambush defeated');}
      return {outcome:'victory'};
    },
    animationHooks:{
      map:async({mapId})=>{
        if(mapId==='M01065'){
          const resources=effects.maps.M01065.objects.map(row=>{
            const resource=structuredClone(effects.object_banks[row.bank]);
            for(const action of resource.actions){action.main_bitmap=action.main_sheet;action.intrinsic_bitmap=action.intrinsic_sheet;}
            return {...row,resource};
          });
          model=new MapObjectRuntime({objects:structuredClone(source.maps.M01065.objects),resources,
            mapId:'M01065',mapFlagIndex:384,random:()=>0});
          objectTime=0;model.update(objectTime,{world:world.value});
        }
        if(mapId===cancelMap)playback.cancel();
      },
      object:async({mapId,objectIndex,state,signal})=>{
        assert.equal(mapId,'M01065');assert.equal(objectIndex,1);
        // The public world remains unchanged while the transaction's CF7
        // opens/closes on its original action clock and the ANM awaits it.
        assert.equal(chapterObjectState(world.value,mapId,objectIndex,source.story),0);
        const actor=model.actors.find(row=>row.object.index===objectIndex);
        const completed=model.animate({objectIndex,state,signal});
        assert.ok(actor.pending);assert.equal(actor.commandState,state);
        const observation={state,phase:'running',frames:[actor.frame]};trace.cf7.push(observation);
        if(state===cancelObjectState)playback.cancel();
        for(let i=0;i<=actor.resource.actions[0].logical_frames.length&&actor.pending;i++){
          objectTime+=130;model.update(objectTime,{world:world.value});
          observation.frames.push(actor.frame);await Promise.resolve();
        }
        await completed;observation.phase='complete';observation.finished_state=actor.commandState;
        assert.equal(actor.commandState,state===2?3:0);
      }
    }
  });
  trace.cf7=[];
  assert.equal(world.location.map_id,'M17030-1');assert.equal(bit(471,1),true);
  assert.deepEqual(world.value.party.map(row=>row.id),['001','005']);
  await checkpoint('yc05_start',world,trace);
  innerWhiteForestRoute(source,world,'M17032');await trigger('M17032',1,2);
  assert.equal(world.location.map_id,'M17023');
  innerWhiteForestRoute(source,world,'M17022','M17021','M17020','M17010');
  const departure=planRouteExit(world.value,'M17010',48,source.story.maps,source.content);
  assert.equal(departure.denied,undefined);
  world.transact(draft=>{for(const command of departure.commands)applyWorldMapCommandToDraft(draft,command);});
  // The stolen-crystal altar closes the lake destination. The original
  // forest's far exit reopens it after10:2, while closing the route back.
  await innerWhiteForestSelect(source,world,6);assert.equal(world.location.map_id,'M70010');
  innerWhiteForestRoute(source,world,'M70040','M70060');await trigger('M70060',2,1);
  assert.equal(world.value.world_map.areas[0].statuses[2],0);
  await innerWhiteForestSelect(source,world,2);assert.equal(world.location.map_id,'M71014');
  await checkpoint('melt_before',world,trace);await trigger('M71014',3,7);
  assert.equal(bit(394,1),true);assert.deepEqual(world.value.party.map(row=>row.id),['001','005','002']);
  assert.deepEqual(allPartyRoles(world.value).find(row=>row.id==='002'),retained.find(row=>row.id==='002'));
  await restore();const melted=world.snapshot();await trigger('M71014',3,7);
  assert.deepEqual(world.value.party,melted.party);assert.deepEqual(world.value.flags,melted.flags);
  assert.equal(trace.animations.filter(row=>row.id==='m71014-1').length,1);
  await trigger('M71014',2,9);assert.equal(world.location.map_id,'M71011-1');
  innerWhiteForestRoute(source,world,'M71010','M71020','M71050');
  await trigger('M71050',3,1);assert.equal(world.location.map_id,'M01065');
  await trigger('M01065',31,65);assert.equal(world.location.map_id,'M01060');assert.equal(bit(384,2),true);
  innerWhiteForestRoute(source,world,'M01040');await checkpoint('pursuit_before',world,trace);
  await trigger('M01040',31,90);assert.equal(bit(4,25),true);assert.equal(bit(4,26),split);
  assert.equal(world.location.map_id,split?'M01020A':'M01050');
  assert.deepEqual(world.value.party.map(row=>row.id),split?['001']:['001','005','002']);
  await restore();await checkpoint(split?'split_pursuit':'together_pursuit',world,trace);
  if(!split){
    const beforeBattle=world.snapshot();failBattle=true;
    await assert.rejects(trigger('M01050',29,100),/YC-05 ambush defeated/);
    assert.deepEqual(world.snapshot(),beforeBattle);assert.equal(bit(5,2),false);failBattle=false;
    await checkpoint('ambush_before',world,trace);await trigger('M01050',29,100);
    assert.equal(bit(5,2),true);
    assert.deepEqual(trace.battles.map(group=>[group.stage,group.members.map(member=>member.id)]),[
      ['stage01.scn',['031A1','031B2']],
      ['stage01.scn',['031A1','031B2']]
    ]);
    const won=world.snapshot();await trigger('M01050',29,100);
    assert.deepEqual(world.value.flags,won.flags);assert.equal(trace.battles.length,2);
    innerWhiteForestRoute(source,world,'M01030','M01020A');
  }
  await trigger('M01020A',29,21);
  innerWhiteForestRoute(source,world,'M01021');await checkpoint('tower_before',world,trace);
  const beforeTower=world.snapshot();cancelObjectState=5;playback=new StoryPlayback();
  await assert.rejects(trigger('M01021',31,7,playback),{name:'AbortError'});
  assert.deepEqual(world.snapshot(),beforeTower);cancelObjectState=null;
  await trigger('M01021',31,7);
  assert.equal(world.location.map_id,'M01060');assert.equal(world.value.leader_id,'003');
  assert.deepEqual(world.value.party.map(row=>row.id),['001','003']);assert.equal(bit(384,1),true);
  assert.ok(world.value.recipe_unlock_indices.includes(254));
  assert.deepEqual(trace.cf7.filter(row=>row.phase==='complete').slice(-2).map(row=>[row.state,row.finished_state]),[[2,3],[5,0]]);
  assert.equal(chapterObjectState(world.value,'M01065',1,source.story),0);
  for(const role of retained)assert.deepEqual(allPartyRoles(world.value).find(row=>row.id===role.id),role);
  await restore();await checkpoint('wati_joined',world,trace);
  innerWhiteForestRoute(source,world,'M01040','M01030','M01020A','M01021');
  const towerDone=world.snapshot();await trigger('M01021',31,7);
  assert.deepEqual(world.value.flags,towerDone.flags);assert.deepEqual(world.value.party,towerDone.party);
  innerWhiteForestRoute(source,world,'M01022');await checkpoint('boarding_before',world,trace);
  assert.equal(bit(9,2),false);assert.equal(bit(40,1),false);
  const beforeBoarding=world.snapshot();cancelMap='M03023';playback=new StoryPlayback();
  await assert.rejects(npc('M01022',10,playback),{name:'AbortError'});
  assert.deepEqual(world.snapshot(),beforeBoarding);assert.equal(bit(40,25),false);cancelMap=null;
  await npc('M01022',10);
  assert.equal(world.location.map_id,'M03023');assert.equal(world.value.leader_id,'003');
  assert.deepEqual([world.location.x,world.location.y],[1040,546]);
  assert.deepEqual(world.value.party.map(row=>row.id),['001','003','004']);
  assert.equal(bit(40,25),true);assert.equal(bit(456,1),true);
  assert.equal(world.value.money,beforeBoarding.money);assert.deepEqual(world.value.inventory,beforeBoarding.inventory);
  assert.equal(bit(9,2),false);assert.equal(bit(40,1),false);
  for(const role of retained)assert.deepEqual(allPartyRoles(world.value).find(row=>row.id===role.id),role);
  assert.deepEqual(trace.animations.filter(row=>row.id==='m03021'),[{id:'m03021',commands:280}]);
  assert.deepEqual(trace.animations.filter(row=>row.id===(split?'m01022-2':'m01022-1')),
    [{id:split?'m01022-2':'m01022-1',commands:split?192:190}]);
  await restore();await checkpoint('yc05_main_end',world,trace);
  const beforeLayout=world.snapshot(),layout=await projectMapStage({mapId:'M03021-4',world:world.value,
    story:runner.data,npcs:source.resources.npcs_by_map['M03021-4'],roles:source.resources.roles,content:source.content});
  assert.equal(bit(464,1),false);assert.equal(layout.find(row=>row.slot_zero_based===11).hidden,true);
  assert.deepEqual(world.snapshot(),beforeLayout);

  // Direct source-root branch replay, separate from the main-chain endpoint:
  // the original post-arrival loader hides M03021-4 inspector11 until464:1.
  // These calls deliberately bypass NPC visibility, but obtain every booking
  // bit from its original counter. They do not prove a currently walkable trip.
  trace.ordinary_root_replay={npc_visibility_bypassed:true,main_end:'yc05_main_end',
    visibility_gate:'M03021-4 setup31 -> m03021-41 hides slot11 until464:1'};
  const travelParty=structuredClone(allPartyRoles(world.value)),money=world.value.money,inventory=structuredClone(world.value.inventory);
  innerWhiteForestRoute(source,world,'M03020','M03010','M03040','M03010','M03020','M03023');
  await npc('M03023',11);assert.equal(bit(411,1),true);assert.equal(bit(411,3),true);
  await restore();await npc('M03023',11);assert.equal(bit(411,1),false);assert.equal(bit(411,3),false);
  await npc('M03023',11);innerWhiteForestRoute(source,world,'M03021-4');
  await checkpoint('direct_root_floating_return_before',world,trace);await npc('M03021-4',11);
  assert.equal(world.location.map_id,'M01022');assert.equal(bit(411,1),false);assert.equal(bit(411,3),false);
  const afterReturn=world.snapshot();await npc('M01022',10);
  assert.equal(world.location.map_id,'M01022');assert.deepEqual(world.value.party,afterReturn.party);
  assert.equal(trace.animations.filter(row=>row.id==='m03021').length,1);
  innerWhiteForestRoute(source,world,'M01021');await npc('M01021',12);
  assert.equal(bit(40,1),true);assert.equal(bit(9,2),true);
  await npc('M01021',12);assert.equal(bit(40,1),false);assert.equal(bit(9,2),false);
  await npc('M01021',12);innerWhiteForestRoute(source,world,'M01022');await npc('M01022',10);
  assert.equal(world.location.map_id,'M03021-4');assert.equal(bit(40,1),false);assert.equal(bit(9,2),false);
  innerWhiteForestRoute(source,world,'M03023');bookingDestination=1;await npc('M03023',11);
  assert.equal(bit(411,2),true);assert.equal(bit(411,3),true);
  innerWhiteForestRoute(source,world,'M03021-4');await npc('M03021-4',11);
  assert.equal(world.location.map_id,'M29012');assert.equal(bit(411,2),false);assert.equal(bit(411,3),false);
  await restore();await checkpoint('direct_root_power_city_arrival',world,trace);
  innerWhiteForestRoute(source,world,'M29011');await npc('M29011',11);assert.equal(bit(519,1),true);
  innerWhiteForestRoute(source,world,'M29012');await npc('M29012',11);
  assert.equal(world.location.map_id,'M03021-4');assert.equal(bit(519,1),false);
  innerWhiteForestRoute(source,world,'M03023');
  assert.deepEqual(allPartyRoles(world.value),travelParty);assert.equal(world.value.money,money);
  assert.deepEqual(world.value.inventory,inventory);assert.equal(world.value.leader_id,'003');
  await restore();await checkpoint('direct_root_transport_end',world,trace);
  return {world,trace};
}
