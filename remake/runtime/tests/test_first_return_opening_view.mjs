// Actual source maps, controller, OpeningView and clock. PNG dimensions are
// read from real files; canvas pixels and dialogue interaction are not emulated.
import test from 'node:test';
import assert from 'node:assert/strict';
import {OpeningView} from '../web/opening_view.mjs';
import {ChapterRunner} from '../web/core/chapter.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {ActionClock} from '../web/phaser/components/action_clock.mjs';
import {SceneController} from '../web/core/scenes.mjs';
import {createMapController} from '../web/controllers/map.mjs';
import {createStoryController} from '../web/controllers/story.mjs';
import {firstReturnSource,firstReturnWorld,firstReturnRead as read,firstReturnBytes} from './helpers/first_return_source.mjs';
const data=await firstReturnSource(),copy=structuredClone;
async function fixture(options={}){
  const [catalog,opening,currentResources,isolatedResources]=await Promise.all([read('data/catalog.json'),read('data/opening_map_resources.json'),
    JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../web/data/chapter_map_resources.json',import.meta.url),'utf8')),read('data/chapter_map_resources.json')]);
  const resources=copy(currentResources);
  for(const key of ['roles','npcs_by_map','exits_by_map','global_object_tlk','trigger_regions','interactive_objects','object_animations','map_entry_tlk_header_raw','map_setup_tlk_header_raw'])
    Object.assign(resources[key]??={},isolatedResources[key]??{});
  opening.roles={...opening.roles,...resources.roles};
  if(!catalog.maps.some(row=>row.id==='M01050'))catalog.maps.push({id:'M01050',path:'data/maps/m01050.json'});
  const world=new WorldStore(firstReturnWorld(data,options),Object.keys(data.content.maps)),clock=new ActionClock();clock.time=0;
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{hidden:true,style:{opacity:'0'},dataset:{},replaceChildren(){},focus(){}});return nodes.get(id);};
  const images=new Map(),image=async path=>{
    if(images.has(path))return images.get(path);const bytes=await firstReturnBytes(path);assert.equal(bytes.subarray(1,4).toString(),'PNG',path);
    const out={path,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};assert.ok(out.width>0&&out.height>0);images.set(path,out);return out;
  };
  const events=[],dialogues=[],installs=[],statuses=[];
  const state={catalog,world,chapterStory:data.story,chapterResources:resources,openingResources:opening,events:[],
    actorResourcesByMap:new Map(),view:{zoom:1,frame:0},keys:new Set(),engine:{exploration:{clock}},
    storyRepository:{content:data.content,retainMap:()=>()=>{},ensureMap:async()=>{},ensureProgram:async id=>({program:data.story.programs[id],release(){}})},
    resources:{async attach(action,path,_scope,field='bitmap'){action[field]=await image(path);return action[field];}}};
  const canvas={focus(){}},map=createMapController({state,actions:{json:read,image},$,canvas,ctx:{}});
  const actions={json:read,image,log:event=>events.push(event),status:(message,error)=>statuses.push({message,error}),buildHud(){},updateNearest(){},
    prepareMap:(id,options)=>map.prepareMap(id,options),validateEntry:(scene,at)=>map.validateEntry(scene,at),
    commitView(scene,at){installs.push(scene.data.id);map.commitView(scene,at);}};
  state.scenes=new SceneController({world,prepare:actions.prepareMap,validateEntry:actions.validateEntry,commitView:actions.commitView,
    captureView:()=>copy(state.view),rollbackView:snapshot=>Object.assign(state.view,snapshot)});
  state.scenes.current=await map.prepareMap('M01050');state.scenes.setPhase('map');map.validateEntry(state.scenes.current,world.location);
  const controller=createStoryController({state,actions,$,canvas}),chapter=new ChapterRunner({world,data:data.story,content:data.content,
    say:async({mapId,record})=>dialogues.push([mapId,record.id]),choose:async()=>options.choice??0,
    animate:controller.animateChapter,setPhase:phase=>state.scenes.setPhase(phase),log:actions.log});state.chapterRunner=chapter;
  const check=()=>{const view=state.openingView;if(!view?.active)return;
    assert.ok(view instanceof OpeningView);
    for(const [slot,actor]of view.actors)if(actor.visible){const action=actor.role.actions.find(a=>a.index===actor.action);
      assert.ok(action,`actor${slot} action${actor.action}`);assert.ok(actor.frame>=0&&actor.frame<action.frame_count);assert.ok(actor.direction>=0&&actor.direction<action.directions);}
    for(const row of view.drawQueue())row.draw({save(){},restore(){},drawImage(bitmap,...args){assert.ok(bitmap?.path);assert.ok(args.every(Number.isFinite));}});
  };
  return {world,state,clock,map,controller,chapter,events,dialogues,installs,statuses,check,close(){state.openingView?.dispose();state.storyPlayback?.dispose();clock.destroy();}};
}
async function drive(f,promise){let done=false,error,result;promise.then(value=>{done=true;result=value;},reason=>{done=true;error=reason;});
  for(let i=0;!done;i++){assert.ok(i<30000,'bounded source18/44 ANM clock');await Promise.resolve();
    if(f.clock.tasks.size){f.clock.advance(160);f.check();}else await new Promise(resolve=>setImmediate(resolve));}
  if(error)throw error;assert.deepEqual(f.statuses.filter(row=>row.error),[]);return result;
}
test('official NPC15 interaction runs44 original first-return commands through real OpeningView, then the actual regional trigger joins005',async()=>{
  const previous=globalThis.document;globalThis.document={createElement:()=>({})};
  const f=await fixture();try{
    const npc=f.state.scenes.current.npcs.find(npc=>npc.slot_zero_based===15);assert.ok(npc);assert.ok(Math.hypot(npc.x-f.world.location.x,npc.y-f.world.location.y)<64);
    f.state.nearest=npc;const before=f.world.snapshot();await drive(f,f.controller.interact());
    const complete=f.events.filter(e=>e.type==='chapter-animation-complete');assert.deepEqual(complete.map(e=>[e.program,e.commands,e.steps]),[['m01050-2',44,44]]);
    assert.equal(f.world.location.map_id,'M17010');assert.equal(f.world.value.flags[10]&1,1);assert.equal(f.world.value.flags[5]&4,4);
    assert.equal(f.world.value.inventory.some(row=>row.id===299),false);assert.equal(f.world.value.inventory.find(row=>row.id===358)?.quantity,1);
    assert.equal(f.world.value.revision,before.revision+1);assert.equal(f.state.scenes.phase,'map');assert.equal(f.clock.tasks.size,0);
    f.map.validateEntry(f.state.scenes.current,f.world.location);assert.ok(f.installs.includes('M01050'));assert.ok(f.installs.includes('M17010'));
    await drive(f,f.controller.runChapter({mapId:'M17010',recordId:49,triggerId:31}));
    assert.equal(f.world.location.map_id,'M17014');assert.deepEqual(f.world.value.party.map(r=>r.id),['001','002','005']);
    assert.deepEqual(f.events.filter(e=>e.type==='chapter-animation-complete').map(e=>[e.program,e.commands,e.steps]),[['m01050-2',44,44],['m17010-2',23,23]]);
    assert.deepEqual(await decodeSave(await encodeSave(f.world.snapshot()),Object.keys(data.content.maps)),f.world.snapshot());
  }finally{f.close();globalThis.document=previous;}
});
test('official unaccepted NPC15 branch runs18 source commands and returns to a valid original exploration pose',async()=>{
  const previous=globalThis.document;globalThis.document={createElement:()=>({})};
  const f=await fixture({accepted:false,returnedItem:false});try{
    f.state.nearest=f.state.scenes.current.npcs.find(npc=>npc.slot_zero_based===15);await drive(f,f.controller.interact());
    assert.deepEqual(f.events.filter(e=>e.type==='chapter-animation-complete').map(e=>[e.program,e.commands,e.steps]),[['m01050-1',18,18]]);
    assert.equal(f.world.location.map_id,'M01050');assert.equal(f.world.value.inventory.find(row=>row.id===332)?.quantity,1);
    f.map.validateEntry(f.state.scenes.current,f.world.location);assert.equal(f.clock.tasks.size,0);
  }finally{f.close();globalThis.document=previous;}
});
