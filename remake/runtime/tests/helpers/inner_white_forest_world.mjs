// YC-03 rules fixture. DAT exits select exact source entry coordinates; this
// does not simulate walking, render poses, or claim a prior campaign playthrough.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {WorldStore} from '../../web/core/world.mjs';
import {ChapterRunner} from '../../web/core/chapter.mjs';
import {ChapterAnimationRunner} from '../../web/core/chapter_animation.mjs';
import {admitPartyMember} from '../../web/core/party_members.mjs';
import {runtimeContent} from '../../web/core/content_registry.mjs';
import {worldMapEntry} from '../../web/core/map_connections.mjs';
import {WorldMapController} from '../../web/core/world_map.mjs';

globalThis.crypto??=webcrypto;
export const innerWhiteForestMapIds=['M70071','M70072','M70073','M70075','M70076','M70074_1','M70074_2'];
const read=async name=>JSON.parse(await readFile(new URL(`../../web/data/${name}.json`,import.meta.url),'utf8'));
export const innerWhiteForestOriginal=path=>readFile(new URL(path,new URL('../../../../',import.meta.url)));

export async function innerWhiteForestSource(){
  const [story,seed,worldMap,resources]=await Promise.all(['chapter_story','opening_seed','world_map','chapter_map_resources'].map(read));
  const ids=[...innerWhiteForestMapIds,'M01051','M01050','M01040','M01060'];
  const maps=Object.fromEntries(await Promise.all(ids.map(async id=>[id,await read(`maps/${id.toLowerCase()}`)])));
  return {story,seed,worldMap,resources,maps,content:runtimeContent,mapIds:Object.keys(runtimeContent.maps)};
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
    transfer:async({destination})=>{trace.transfers.push(destination);return {location:worldMapEntry({},destination,source.story)};},
    animate:async({program,runTlk,joinActor,leaveActor,flagCommand,draft,playback})=>{
      const hooks=Object.fromEntries(['map','actor','move','camera','wait','fade','sound','media'].map(name=>[name,async()=>{}]));
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
      draft.native_map_sort_code=exit.source.entry_sort_code;delete draft.map_npc_state;});
  }
}

export async function innerWhiteForestSelect(source,world,index){
  const controller=new WorldMapController({world,data:source.worldMap,
    prepare:async destination=>({location:worldMapEntry({},destination,source.story)}),load(){}});
  controller.open(0);await controller.select(index);
}
