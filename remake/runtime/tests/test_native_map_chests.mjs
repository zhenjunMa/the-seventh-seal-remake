import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {nativeKeyedChest,canOpenNativeChest,nativeChestAnimation} from '../web/core/native_map_chests.mjs';
import {ChapterRunner,chapterObjectState,initializeChapterItem,validateChapterStory} from '../web/core/chapter.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {validateStoryBindings} from '../web/core/content_dependencies.mjs';
import {inspectContentReadiness} from '../web/core/content_readiness.mjs';
import {readNativeChestFixtures} from './native_map_chest_fixtures.mjs';
import {MapObjectRuntime} from '../web/core/map_objects.mjs';
import {mapPresentation} from '../web/core/map_presentation.mjs';
globalThis.crypto??=webcrypto;
const read=path=>JSON.parse(fs.readFileSync(new URL(path,import.meta.url),'utf8'));
const source=readNativeChestFixtures();
const testSource=(name,fn)=>test(name,{skip:source.skip},fn);
const items=read('../web/data/items.json'),seed=read('../web/data/opening_seed.json');
const fixture=source.chests.find(row=>row.map_id==='M70020'&&row.object.index===3);
const copy=value=>structuredClone(value),hex=raw=>Buffer.from(raw).toString('hex');
function item(id){
  const definition=items.definitions[id],raw=initializeChapterItem(definition);
  new DataView(raw.buffer).setUint32(4,1,true);
  return {instance_id:`chest-test-${id}`,id,name:definition.name,quantity:1,source_raw_hex:hex(raw),source_definition:definition.source};
}
function setup({key=false,state=0,animation=async()=>{}}={}){
  const {map_id:id,map_flag_index,map_source,object}=fixture;
  const data={schema:'seventh-seal-chapter-story',version:1,maps:{[id]:{
    id,map_flag_index,map_source,source:null,dialogue_status:'source-file-absent',record_count:0,index_count:0,
    header_setup_tlk_raw:0,header_entry_tlk_raw:0,
    records:[],objects:[object],index_nonzero:[],descriptors:[]}},programs:{},item_definitions:items.definitions,
    source_hashes:{...items.source_hashes,[map_source.path]:map_source.sha256}};
  const content={maps:{[id]:{triggers:[],objects:[{index:object.index,handler:'keyed-chest'}],rests:[],routes:[],npcs:[]}},programs:{}};
  const initial=copy(seed);initial.opening.status='complete';initial.location={map_id:id,x:0,y:0,direction:0};
  if(key)initial.inventory.push(item(336));
  if(state){while(initial.event_records[map_flag_index].length<=object.index)initial.event_records[map_flag_index].push('00'.repeat(14));
    initial.event_records[map_flag_index][object.index]=state.toString(16).padStart(2,'0')+'a5'.repeat(13);}
  const world=new WorldStore(initial);
  const runner=new ChapterRunner({world,data,content,say:async()=>{throw new Error('Direct chest cannot enter TLK');},objectAnimation:animation});
  const run=()=>runner.runObject({mapId:id,objectIndex:object.index});
  return {world,runner,data,content,run};
}

testSource('All thirteen outer White Forest chests retain source hashes, F2 keys and ten-slot reward IDs',()=>{
  assert.equal(source.chests.length,13);
  const expected=[[335,159],[333,353],[336,127],[332,156],[335,354],[334,158],[334,271],[335,159],[333,354],[334,271],[332,156],[337,161],[335,338]];
  for(const [index,row]of source.chests.entries()){
    for(const provenance of [row.map_source,row.animation.source])assert.equal(source.source_hashes[provenance.path],provenance.sha256);
    const chest=nativeKeyedChest(row.object);
    assert.deepEqual([chest.keyId,chest.rewards[0].id],expected[index]);assert.deepEqual(chest.rewards,[{slot:0,id:expected[index][1]}]);
    const raw=Buffer.from(row.object.raw_hex,'hex');raw.writeUInt32LE(999,0x48);
    assert.deepEqual(nativeKeyedChest({...row.object,raw_hex:raw.toString('hex')}),chest,'+48 is a rebuilt queue ordinal');
    initializeChapterItem(items.definitions[chest.rewards[0].id]);
  }
});

testSource('CF4 collection uses its second action and starts at physical frame10',()=>{
  for(const {animation}of source.chests){
    const {action,frameIndices}=nativeChestAnimation(animation,4);
    assert.equal(action.index,1);assert.equal(frameIndices[0],10);
    assert.equal(frameIndices.at(-1),animation.frames.length-1);
    assert.ok([15,16].includes(frameIndices.length));
  }
});

testSource('Direct CF4 admission rejects a player-strike first action and linked directional effect emitters',()=>{
  const animation=copy(fixture.animation),first=Buffer.from(animation.actions[0].raw_hex,'hex');
  assert.equal(first[0x7f],0);first[0x7f]=1;animation.actions[0].raw_hex=first.toString('hex');
  assert.equal(Buffer.from(animation.actions[1].raw_hex,'hex')[0x7f],0);
  assert.throws(()=>nativeChestAnimation(animation,4),/首动作所需人物攻击/);
  const raw=Buffer.from(fixture.object.raw_hex,'hex');raw[0x52]=32;
  assert.deepEqual(nativeKeyedChest({...fixture.object,raw_hex:raw.toString('hex')}),nativeKeyedChest(fixture.object));
  raw[0x51]=1;
  assert.throws(()=>nativeKeyedChest({...fixture.object,raw_hex:raw.toString('hex')}),/物件联动尚未接入/);
});

testSource('All thirteen chests project native live layer1 ordering and source action-derived saved layer2 ordering',async()=>{
  for(const row of source.chests){
    const map=read(`../web/data/maps/${row.map_id.toLowerCase()}.json`),original=map.objects.find(object=>object.index===row.object.index);
    assert.equal(Buffer.from(row.object.raw_hex,'hex')[0xce],2);assert.equal(original.layer,2);
    const make=()=>{
      const object={...copy(original),bitmap:{name:'source-object'}},resource={frame_width:row.animation.frame_width,
        frame_height:row.animation.frame_height,actions:row.animation.actions.map(action=>{
          const raw=Buffer.from(action.raw_hex,'hex');assert.equal(raw[13]&15,1);
          return {...copy(action),source_action_raw_hex:action.raw_hex,logical_frames:Array.from({length:raw.readUInt32LE(14)},(_,i)=>i),
            main_bitmap:{name:`action${action.index}-main`},intrinsic_bitmap:{name:`action${action.index}-light`}};
        })};
      const model=new MapObjectRuntime({objects:[object],resources:[{index:object.index,behavior_raw_cf:4,
        source_record_raw_hex:row.object.raw_hex,resource}],mapFlagIndex:row.map_flag_index,mapId:row.map_id});
      const scene={data:{id:row.map_id,role_layer_preview:2},objects:[object],npcs:[]};
      return {object,model,scene};
    };
    const initial=copy(seed);initial.opening.status='complete';initial.location={map_id:row.map_id,x:original.x_world,
      y:original.sort_y-52,direction:0};const world=new WorldStore(initial),live=make();
    const queue=scene=>mapPresentation({scene,world:world.value,role:{frame_width:16,frame_height:16,map_draw_offset:{x:0,y:0}},
      action:{bitmap:{name:'leader'}},view:{frame:0},time:0});
    live.model.update(0,{world:world.value,paused:true});assert.equal(live.object.layer,2);
    assert.deepEqual(queue(live.scene).map(entry=>entry.key),['leader',`object:${original.index}`]);
    world.transact(draft=>{while(draft.event_records[row.map_flag_index].length<=original.index)draft.event_records[row.map_flag_index].push('00'.repeat(14));
      draft.event_records[row.map_flag_index][original.index]='03'+'a5'.repeat(13);});
    const committed=world.snapshot();live.model.update(1,{world:world.value,paused:true});
    assert.equal(live.object.layer,1);assert.deepEqual(queue(live.scene).map(entry=>entry.key),[`object:${original.index}`,'leader']);
    assert.equal(queue(live.scene)[0].pose.image.name,'action1-main');assert.deepEqual(world.snapshot(),committed);
    const pending=copy(committed);pending.event_records[row.map_flag_index][original.index]='02'+'a5'.repeat(13);
    live.model.update(2,{world:pending,paused:true});assert.equal(live.object.layer,2,'a reverted pending state uses the initial source layer');
    live.model.update(3,{world:committed,paused:true});assert.equal(live.object.layer,1,'a live state2 completion is layer1');
    world.replace(await decodeSave(await encodeSave(world.snapshot())));const restored=make();
    restored.model.update(0,{world:world.value,paused:true});
    const mode=Buffer.from(row.animation.actions[1].raw_hex,'hex')[13]>>>4;
    assert.equal(mode,0);assert.equal(restored.object.layer,[2,3,1][mode]);
    assert.deepEqual(queue(restored.scene).map(entry=>entry.key),['leader',`object:${original.index}`]);
    assert.equal(queue(restored.scene)[1].pose.image.name,'action1-main');
    assert.equal(world.value.event_records[row.map_flag_index][original.index],'03'+'a5'.repeat(13));
  }
});

testSource('Missing elemental key leaves every world byte unchanged and equipped keys are accepted without consumption',async()=>{
  const {world,run}=setup(),before=world.snapshot(),result=await run();
  assert.equal(result.locked,true);assert.equal(result.key_id,336);assert.deepEqual(world.snapshot(),before);
  const snapshot=world.snapshot();snapshot.source.initial_equipment.push({role_id:'001',item_id:336});
  assert.equal(canOpenNativeChest(snapshot,nativeKeyedChest(fixture.object)),true);
});

testSource('Direct rewards commit after animation, retain the key and remain empty after save/load',async()=>{
  let animations=0;const context=setup({key:true,animation:async({draft})=>{
    animations++;assert.equal(chapterObjectState(draft,fixture.map_id,fixture.object.index,context.data),2);
    assert.equal(draft.inventory.some(row=>row.id===127),false);assert.equal(context.world.value.inventory.some(row=>row.id===127),false);
  }});
  const {world,run}=context,before=world.snapshot();const result=await run();
  assert.equal(animations,1);assert.equal(result.state,3);assert.deepEqual(result.rewards,[{slot:0,id:127}]);
  assert.equal(world.value.inventory.find(row=>row.id===127).quantity,1);
  assert.deepEqual(world.value.inventory.find(row=>row.id===336),before.inventory.find(row=>row.id===336));
  const loaded=await decodeSave(await encodeSave(world.snapshot()));world.replace(loaded);
  const done=world.snapshot();assert.equal((await run()).already_done,true);assert.deepEqual(world.snapshot(),done);assert.equal(animations,1);
});

testSource('Saved state2 completes without checking a key, preserves unknown event bytes and grants its pending reward',async()=>{
  const {world,run}=setup({state:2});await run();
  assert.equal(world.value.inventory.find(row=>row.id===127).quantity,1);
  assert.equal(world.value.event_records[fixture.map_flag_index][fixture.object.index],'03'+'a5'.repeat(13));
  const bad=setup({key:true,animation:async()=>{throw new Error('Object image unavailable');}}),before=bad.world.snapshot();
  await assert.rejects(bad.run(),/Object image unavailable/);assert.deepEqual(bad.world.snapshot(),before);
});

testSource('Full inventory rolls back a direct chest and permits a reward-preserving retry after clearing one slot',async()=>{
  const {world,run}=setup({key:true});
  world.transact(draft=>{while(draft.inventory.length<1000)draft.inventory.push({...item(336),instance_id:`full-${draft.inventory.length}`});});
  const before=world.snapshot();await assert.rejects(run(),/背包已满/);assert.deepEqual(world.snapshot(),before);
  world.transact(draft=>{draft.inventory.pop();});assert.equal((await run()).state,3);
  assert.equal(world.value.inventory.find(row=>row.id===127).quantity,1);
});

testSource('Source-absent TLK maps admit direct objects without inventing an empty dialogue flow',()=>{
  const {data,content,runner}=setup();assert.equal(validateChapterStory(data),data);assert.deepEqual(runner.data.flows,{});
  const resources={object_animations:{[fixture.map_id]:[fixture.animation]},interactive_objects:{[fixture.map_id]:[
    {object_index_zero_based:fixture.object.index,source:{...fixture.object.source,raw_hex:fixture.object.raw_hex}}]},trigger_regions:{},npcs_by_map:{}};
  assert.equal(validateStoryBindings(content,data,resources),true);
  const report=inspectContentReadiness(content,data,resources);assert.deepEqual(report.errors,[]);assert.equal(report.entrances[0].kind,'direct-object');
  const altered=copy(data);altered.maps[fixture.map_id].source={path:'invented.tlk'};
  assert.throws(()=>validateChapterStory(altered),/无对白地图来源无效/);
});
