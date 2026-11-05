// Source DAT-only CF7 pedestals use the shared transaction and real object
// clock. Their +98=1 admits placement once, without removal or item effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {nativeToggleObject} from '../web/core/native_map_chests.mjs';
import {ChapterRunner,chapterObjectState} from '../web/core/chapter.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {MapObjectRuntime} from '../web/core/map_objects.mjs';
import {inspectContentReadiness} from '../web/core/content_readiness.mjs';
import {validateStoryBindings} from '../web/core/content_dependencies.mjs';
import {createStoryController} from '../web/controllers/story.mjs';

const copy=structuredClone,hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const seed=JSON.parse(await readFile(new URL('../web/data/opening_seed.json',import.meta.url),'utf8'));
async function source(mapId,index){
  const path=`Map/${mapId}.dat`,dat=await readFile(new URL(`../../../${path}`,import.meta.url)),sha256=hash(dat);
  const descriptorBytes=dat.readUInt32LE(0x18)===1?0x42:0x2b;
  const at=0x172+dat.readUInt32LE(0x146)*dat.readUInt32LE(0x14a)*64+32*(0x2a+descriptorBytes+0x1b+0x110)+index*0x112;
  const raw=dat.subarray(at,at+0x112),object={index,raw_hex:raw.toString('hex'),behavior_raw_cf:raw[0xcf],interaction_record_raw_f6:raw.readUInt32LE(0xf6),
    x_native:raw.readInt32LE(0x26),y_native:raw.readInt32LE(0x2a),source:{path,sha256,offset:at,bytes:0x112}};
  const directory=dat.subarray(0x14e,0x16e).toString('ascii').split('\0')[0].replaceAll('\\','/').replace(/^\.\//,'');
  const dgpPath=`${directory}${String(raw.readUInt32LE(0x1e)).padStart(3,'0')}.dgp`;
  const dgp=await readFile(new URL(`../../../${dgpPath}`,import.meta.url));assert.equal(dgp[0],9);
  const geometry=0x43+dgp[2]*0xac,frameCount=dgp.readUInt32LE(geometry+4);
  const actions=Array.from({length:dgp[2]},(_,index)=>{
    const raw=dgp.subarray(0x43+index*0xac,0x43+(index+1)*0xac),count=raw.readUInt32LE(0x0e);
    const logicalCount=raw[13]===0?raw.readUInt32LE(0x12):count;
    return {index,frame_count:count,directions:1,first_frame:raw.readUInt32LE(0x72),interval_raw:raw.readUInt32LE(1),
      source_action_raw_hex:raw.toString('hex'),logical_frames:Array.from({length:logicalCount},(_,i)=>raw[13]===0?raw[0x16+i]:i)};
  });
  const resource={source:{path:dgpPath,sha256:hash(dgp)},actions,frame_width:dgp.readUInt16LE(geometry),frame_height:dgp.readUInt16LE(geometry+2)};
  const map_flag_index=dat.readUInt32LE(0x92),table={id:mapId,map_flag_index,map_source:{path,sha256},source:null,dialogue_status:'source-file-absent',
    record_count:0,index_count:0,header_setup_tlk_raw:0,header_entry_tlk_raw:0,records:[],objects:[object],index_nonzero:[],descriptors:[]};
  const data={schema:'seventh-seal-chapter-story',version:1,maps:{[mapId]:table},programs:{},source_hashes:{[path]:sha256}};
  const content={maps:{[mapId]:{path:`data/maps/${mapId.toLowerCase()}.json`,objects:[{index,handler:'toggle-object'}],triggers:[],rests:[],routes:[],npcs:[]}},programs:{}};
  const resources={object_animations:{[mapId]:[{object_index_zero_based:index,frames:Array.from({length:frameCount},(_,index)=>({index})),actions}]},
    interactive_objects:{[mapId]:[{object_index_zero_based:index,source:{...object.source,raw_hex:object.raw_hex}}]},npcs_by_map:{},trigger_regions:{}};
  const model=()=>new MapObjectRuntime({objects:[{index,layer:raw[0xce]}],mapId,mapFlagIndex:map_flag_index,random:()=>0,
    resources:[{index,map_id:mapId,behavior_raw_cf:7,source_record_raw_hex:object.raw_hex,initial_frame_raw:raw.readUInt32LE(0x3c),fixed_clock_raw_b4:raw[0xb4],resource}]});
  return {mapId,index,raw,data,content,resources,model,table};
}

test('both native CF7 pedestals animate placement, preserve save state, reject replay and roll back cancelled clocks',async()=>{
  for(const [mapId,index]of [['YEARN-C02',8],['YEARN-D02',7]]){
    const value=await source(mapId,index),{raw,data,content,table}=value;
    assert.equal(raw[0x98],1);assert.equal(raw.readUInt32LE(0xf6),0);assert.ok(raw.readUInt32LE(0xfa)>0);
    assert.deepEqual(nativeToggleObject(table.objects[0]),{behavior:7});
    assert.equal(validateStoryBindings(content,data,value.resources),true);assert.deepEqual(inspectContentReadiness(content,data,value.resources).errors,[]);
    const initial=copy(seed);initial.opening.status='complete';initial.location={map_id:mapId,x:raw.readInt32LE(0x26)*2,y:raw.readInt32LE(0x2a)*2,direction:0};
    const world=new WorldStore(initial),before=world.snapshot();let runtime=value.model(),interactions=0,animations=0,cancel=false;
    const state={chapterStory:data,scenes:{current:{data:{id:mapId},objectRuntime:runtime}}};
    const presentation=createStoryController({state,actions:{},$:()=>({}),canvas:{}});
    const aborter=new AbortController();runtime.update(0,{world:world.value});
    const runner=new ChapterRunner({world,data,content,say:()=>assert.fail('DAT-only CF7 must not invent a TLK'),
      objectInteraction:async()=>{interactions++;},objectAnimation:async({draft,fromState,toState,signal})=>{
        animations++;assert.deepEqual([fromState,toState],[2,3]);assert.equal(chapterObjectState(draft,mapId,index,data),2);
        assert.deepEqual(world.snapshot(),before,'the real world stays uncommitted during placement');
        state.scenes.current.objectRuntime=runtime;
        const pending=presentation.animateChapterObject({mapId,objectIndex:index,fromState,toState,signal});
        runtime.update(150,{world:draft,paused:true});assert.equal(runtime.actors[0].frame,0);
        runtime.update(300,{world:draft});assert.equal(runtime.actors[0].frame,1);
        if(cancel)aborter.abort(Error('CF7 placement cancelled'));else runtime.update(450,{world:draft});
        await pending;
      }});
    cancel=true;
    await assert.rejects(runner.runObject({mapId,objectIndex:index,playback:{signal:aborter.signal,check(){aborter.signal.throwIfAborted();}}}),/CF7 placement cancelled/);
    assert.deepEqual(world.snapshot(),before);assert.equal(runtime.actors[0].frame,0);
    cancel=false;runtime=value.model();runtime.update(0,{world:world.value});
    assert.equal((await runner.runObject({mapId,objectIndex:index})).state,3);
    assert.equal(chapterObjectState(world.value,mapId,index,data),3);assert.equal(runtime.actors[0].commandState,3);
    for(const key of ['inventory','money','party','flags'])assert.deepEqual(world.value[key],before[key],'+FA must not be interpreted as a consumed or awarded item');
    world.replace(await decodeSave(await encodeSave(world.snapshot())));
    const saved=world.snapshot(),restored=value.model();restored.update(0,{world:world.value});assert.equal(restored.actors[0].actionIndex,1);
    assert.equal((await runner.runObject({mapId,objectIndex:index})).already_done,true);assert.deepEqual(world.snapshot(),saved);
    assert.equal(animations,2);assert.equal(interactions,2);
    const unknown=copy(table.objects[0]),changed=Buffer.from(unknown.raw_hex,'hex');changed[0x98]=0;unknown.raw_hex=changed.toString('hex');
    assert.throws(()=>nativeToggleObject(unknown),/可逆CF7/);
  }
});
