import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import {readContentDefinition} from '../tools/resolve_content_definition.mjs';
import {readNativeChestFixtures,WHITE_FOREST_MAPS} from './native_map_chest_fixtures.mjs';
import {ChapterRunner,initializeChapterItem,chapterObjectState,validateChapterStory} from '../web/core/chapter.mjs';
import {nativeKeyedChest,nativeChestAnimation} from '../web/core/native_map_chests.mjs';
import {createStoryController} from '../web/controllers/story.mjs';
import {StoryPlayback} from '../web/core/story_playback.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {validateStoryBindings} from '../web/core/content_dependencies.mjs';
import {inspectContentReadiness} from '../web/core/content_readiness.mjs';
globalThis.crypto??=webcrypto;
const fixture=readNativeChestFixtures(),copy=value=>structuredClone(value);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fileHash=relative=>hash(fs.readFileSync(new URL(relative,import.meta.url)));
const quantity=(world,id)=>world.inventory.filter(row=>row.id===id).reduce((sum,row)=>sum+row.quantity,0);
function keyItem(definition,index){
  const raw=initializeChapterItem(definition);new DataView(raw.buffer).setUint32(4,1,true);
  return {instance_id:`closure-key-${index}`,id:definition.id,name:definition.name,quantity:1,
    source_raw_hex:Buffer.from(raw).toString('hex'),source_definition:copy(definition.source)};
}
function deterministicAnimation(row,world){
  const native=nativeChestAnimation(row.animation,4),trace={frames:[],images:[],elapsed:0,failAfter:0};
  const state={world,chapterStory:fixture.story,chapterResources:fixture.resources,objectPreview:null};
  const clock={paused:false,closed:false,async tween(ms,update,signals=[]){
    assert.equal(ms,native.action.interval_raw*native.frameIndices.length);
    for(let index=0;index<native.frameIndices.length;index++){
      for(const signal of signals)signal?.throwIfAborted();
      update((index+0.01)/native.frameIndices.length);
      trace.frames.push(state.objectPreview.bitmap.image);
      assert.equal(quantity(world.value,nativeKeyedChest(row.object).rewards[0].id),trace.rewardBefore);
      trace.elapsed+=native.action.interval_raw;
      if(trace.failAfter&&trace.frames.length===trace.failAfter)throw new Error('Deterministic chest animation interruption');
      await Promise.resolve();
    }
    update(1);
  }};
  state.engine={exploration:{clock}};
  const controller=createStoryController({state,actions:{image:async image=>{
    const frame=row.animation.frames.find(frame=>frame.image===image);assert.ok(frame);
    assert.equal(fileHash(`../web/${image}`),frame.sha256,'exported collection frame fingerprint');
    trace.images.push(image);return {image};
  }},$:()=>({}),canvas:{focus(){}},ctx:{}});
  const expected=native.frameIndices.map(index=>row.animation.frames.find(frame=>frame.index===index).image);
  const reset=(failAfter=0)=>Object.assign(trace,{frames:[],images:[],elapsed:0,failAfter,
    rewardBefore:quantity(world.value,nativeKeyedChest(row.object).rewards[0].id)});
  return {state,clock,trace,expected,reset,animate:controller.animateChapterObject,
    native:{action_index:native.action.index,interval_ms:native.action.interval_raw,
      frame_indices:native.frameIndices,duration_ms:native.action.interval_raw*native.frameIndices.length}};
}

test('All thirteen registered direct chests close their key, reward, real action, failure and saved-state branches',
  {skip:fixture.skip},async()=>{
  const report={schema:'seventh-seal-native-direct-chest-validation',version:1,passed:false,
    scope:'Outer White Forest six maps / thirteen keyed-chest registrations. Production ChapterRunner and story controller execute with a deterministic test clock and source-verified frame assets. This is not browser or original-gameplay observation.',
    provenance:{source_hashes:fixture.source_hashes,input_hashes:{
      'web/data/chapter_story.json':fileHash('../web/data/chapter_story.json'),
      'web/data/chapter_map_resources.json':fileHash('../web/data/chapter_map_resources.json'),
      'web/data/runtime_content.json':fileHash('../web/data/runtime_content.json'),
      'web/core/native_map_chests.mjs':fileHash('../web/core/native_map_chests.mjs'),
      'web/core/map_objects.mjs':fileHash('../web/core/map_objects.mjs'),
      'web/core/map_presentation.mjs':fileHash('../web/core/map_presentation.mjs'),
      'web/core/chapter.mjs':fileHash('../web/core/chapter.mjs'),
      'web/controllers/story.mjs':fileHash('../web/controllers/story.mjs'),
      'tests/test_native_map_chest_closure.mjs':fileHash('./test_native_map_chest_closure.mjs')},
      content_resolution:'readContentDefinition() resolves current authoring JSON against original DAT identities; compiled runtime_content.mjs is not required.'},
    maps:[],chests:[],limitations:['No browser rendering, physical input, exact native clock phase or original gameplay was observed.',
      'Native full-inventory persistent global drop pool is not reproduced; the separate direct-chest unit test verifies atomic rollback and retry.']};
  try{
    const {content,sources,input_sha256}=await readContentDefinition();
    report.provenance.resolver_input_sha256=input_sha256;
    const {story}=sources,resources=fixture.resources;
    validateChapterStory(story);
    const scoped={...content,programs:{},maps:Object.fromEntries(WHITE_FOREST_MAPS.map(id=>{
      const binding=content.maps[id];assert.ok(binding,`${id} current registration`);
      return [id,{...binding,triggers:[],rests:[],routes:[],npcs:[],entry_record:undefined,setup_record:undefined}];
    }))};
    validateStoryBindings(scoped,story,resources);
    const readiness=inspectContentReadiness(scoped,story,resources);assert.deepEqual(readiness.errors,[]);
    report.readiness={passed:readiness.passed,direct_object_entrances:readiness.entrances.length};
    const registrations=WHITE_FOREST_MAPS.flatMap(id=>content.maps[id].objects.map(row=>`${id}:${row.index}:${row.handler}`));
    assert.equal(registrations.length,13);
    const seed=copy(sources.seed);seed.opening.status='complete';
    for(const id of WHITE_FOREST_MAPS){
      const table=story.maps[id],animations=resources.object_animations[id];
      report.maps.push({id,map_flag_index:table.map_flag_index,dialogue_status:table.dialogue_status,
        dialogue_records:table.records.length,registered_chests:content.maps[id].objects.length,
        source_animations:animations.length});
      assert.equal(animations.length,content.maps[id].objects.length);
      if(['M70020','M70040','M70050'].includes(id)){
        assert.equal(table.dialogue_status,'source-file-absent');assert.equal(table.source,null);
        assert.deepEqual(table.records,[]);assert.equal(table.header_setup_tlk_raw,0);assert.equal(table.header_entry_tlk_raw,0);
      }
    }
    for(const row of fixture.chests){
      const {map_id:mapId,map_flag_index:flag,object}=row,chest=nativeKeyedChest(object);
      assert.ok(registrations.includes(`${mapId}:${object.index}:keyed-chest`));
      const makeSeed=(key=false,state=0)=>{
        const next=copy(seed);next.location={map_id:mapId,x:object.x_native*2,y:object.y_native*2,direction:0};
        while(next.event_records[flag].length<=object.index)next.event_records[flag].push('00'.repeat(14));
        next.event_records[flag][object.index]=state.toString(16).padStart(2,'0')+'a5'.repeat(13);
        if(key)next.inventory.push(keyItem(story.item_definitions[chest.keyId],`${mapId}-${object.index}`));
        return next;
      };
      const world=new WorldStore(makeSeed()),animation=deterministicAnimation(row,world);
      const runner=new ChapterRunner({world,data:story,content,objectData:resources.interactive_objects,
        say:async()=>{throw new Error('A direct chest cannot enter a TLK flow');},objectAnimation:animation.animate});
      if(story.maps[mapId].dialogue_status==='source-file-absent')assert.ok(!Object.values(runner.data.flows).some(flow=>flow.map_id===mapId));
      const invoke=async()=>{
        const playback=new StoryPlayback({clock:animation.clock});
        try{const result=await runner.runObject({mapId,objectIndex:object.index,playback});playback.complete();return result;}
        catch(error){playback.fail(error);throw error;}finally{playback.dispose();}
      };
      const results={map_id:mapId,object_index:object.index,key_item_id:chest.keyId,rewards:chest.rewards,
        source_animation:animation.native,scenarios:{}};
      animation.reset();let before=world.snapshot();const locked=await invoke();
      assert.equal(locked.locked,true);assert.equal(locked.key_id,chest.keyId);assert.deepEqual(world.snapshot(),before);
      assert.deepEqual(animation.trace.frames,[]);results.scenarios.missing_key={passed:true,world_unchanged:true,animation_frames:0};
      world.replace(makeSeed(true));animation.reset();before=world.snapshot();const opened=await invoke();
      assert.equal(opened.state,3);assert.deepEqual(opened.rewards,chest.rewards);
      assert.deepEqual(animation.trace.frames,animation.expected);assert.deepEqual(animation.trace.images,animation.expected);
      assert.equal(animation.trace.elapsed,animation.native.duration_ms);assert.equal(animation.state.objectPreview,null);
      for(const reward of chest.rewards)assert.equal(quantity(world.value,reward.id),quantity(before,reward.id)+1);
      assert.deepEqual(world.value.inventory.find(item=>item.id===chest.keyId),before.inventory.find(item=>item.id===chest.keyId));
      assert.equal(world.value.event_records[flag][object.index],'03'+'a5'.repeat(13));
      results.scenarios.with_key={passed:true,key_retained:true,state:3,collection_frames:animation.trace.frames.length,
        action_index:animation.native.action_index,first_physical_frame:animation.native.frame_indices[0]};
      animation.reset();before=world.snapshot();assert.equal((await invoke()).already_done,true);assert.deepEqual(world.snapshot(),before);
      assert.deepEqual(animation.trace.frames,[]);results.scenarios.repeat={passed:true,world_unchanged:true,animation_frames:0};
      world.replace(await decodeSave(await encodeSave(world.snapshot())));animation.reset();before=world.snapshot();
      assert.equal((await invoke()).already_done,true);assert.deepEqual(world.snapshot(),before);assert.deepEqual(animation.trace.frames,[]);
      results.scenarios.save_load_completed={passed:true,reward_duplicated:false,state:3};
      world.replace(makeSeed(true));animation.reset(4);before=world.snapshot();
      await assert.rejects(invoke(),/Deterministic chest animation interruption/);assert.deepEqual(world.snapshot(),before);
      assert.equal(animation.state.objectPreview,null);assert.equal(animation.trace.frames.length,4);
      assert.equal(chapterObjectState(world.value,mapId,object.index,story),0);
      results.scenarios.animation_failure={passed:true,world_unchanged:true,interrupted_after_frames:4,reward_committed:false};
      animation.reset();assert.equal((await invoke()).state,3);for(const reward of chest.rewards)assert.equal(quantity(world.value,reward.id),quantity(before,reward.id)+1);
      results.scenarios.failure_retry={passed:true,state:3,award_count:1};
      world.replace(await decodeSave(await encodeSave(makeSeed(false,2))));animation.reset();before=world.snapshot();
      assert.equal((await invoke()).state,3);assert.deepEqual(animation.trace.frames,animation.expected);
      for(const reward of chest.rewards)assert.equal(quantity(world.value,reward.id),quantity(before,reward.id)+1);
      assert.equal(world.value.event_records[flag][object.index],'03'+'a5'.repeat(13));
      assert.equal(quantity(world.value,chest.keyId),0);
      results.scenarios.save_load_pending_state2={passed:true,key_required:false,state:3,award_count:1,unknown_event_bytes_preserved:true};
      report.chests.push(results);
    }
    assert.equal(report.chests.length,13);report.summary={maps:6,chests:13,scenarios_per_chest:7,
      passed_scenarios:report.chests.reduce((sum,row)=>sum+Object.values(row.scenarios).filter(value=>value.passed).length,0),
      original_sources_verified:Object.keys(fixture.source_hashes).length,source_bytes_unchanged:true};
    for(const [path,digest]of Object.entries(fixture.source_hashes))assert.equal(fileHash(`../../../${path}`),digest);
    report.passed=true;
  }catch(error){report.error=error.stack;throw error;}
  finally{
    if(process.env.WHITE_FOREST_CHEST_REPORT)fs.writeFileSync(process.env.WHITE_FOREST_CHEST_REPORT,JSON.stringify(report,null,2)+'\n');
  }
});
