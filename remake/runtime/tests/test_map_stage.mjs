// Real DAT/TLK/ANM fixtures exercise revisit layouts without playing arrival
// story. Source mutation tests below are isolated corrupt copies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {projectMapStage} from '../web/core/map_stage.mjs';
import {compileTlkFlow,nativeFlowId} from '../web/core/story_flow_compiler.mjs';
import {chapterChoices} from '../web/core/chapter.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {SceneController} from '../web/core/scenes.mjs';
const copy=structuredClone;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const original=name=>readFile(new URL(`../../../${name}`,import.meta.url));
const read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [seed,resources]=await Promise.all([read('opening_seed'),read('chapter_map_resources')]);

async function sourceTable(id){
  const dat=await original(`Map/${id.toLowerCase()}.dat`),tlk=await original(`Map/${id.toLowerCase()}.TLK`);
  const path=`Map/${id.toLowerCase()}.TLK`,sha256=digest(tlk),count=tlk.readUInt32LE(6),base=0x1a+tlk.readUInt32LE(2)*4;
  const fields={speaker:0x0f,condition_type:0x17,condition_index:0x1b,condition_bit:0x1f,
    mutation_type:0x23,mutation_index:0x27,mutation_bit:0x2b,if_true:0x2f,next:0x33};
  const records=Array.from({length:count},(_,index)=>{
    const offset=base+index*0x66f,raw=tlk.subarray(offset,offset+0x66f);assert.equal(raw.readUInt32LE(0x13),index+1);
    return {id:index+1,kind:raw[0],style:raw[1],region_byte_raw:raw[7],condition_byte_raw_0b:raw[11],
      ...Object.fromEntries(Object.entries(fields).map(([key,at])=>[key,raw.readUInt32LE(at)])),
      text_raw:new TextDecoder('gbk').decode(raw.subarray(0x37,0x137)).split('\0')[0],raw_hex:raw.toString('hex'),
      source:{path,sha256,offset,record_id:index+1}};
  });
  const recordBytes=dat.readUInt32LE(0x18)===1?0x42:0x2b;
  const npcStart=0x172+dat.readUInt32LE(0x146)*dat.readUInt32LE(0x14a)*64
    +32*(0x2a+recordBytes+0x1b+0x110)+dat.readUInt32LE(0x82)*0x112;
  const npcs=Array.from({length:dat[0x86]},(_,index)=>{
    const raw=dat.subarray(npcStart+index*0x4c5,npcStart+(index+1)*0x4c5),slot=index+10;
    return {id:`${id}-role-${slot}`,slot_zero_based:slot,resource_id:String(raw.readUInt32LE(0x28)).padStart(3,'0'),
      x:raw.readInt32LE(0x6f)*2,y:raw.readInt32LE(0x73)*2,direction:raw[0x45],hidden:Boolean(raw[0x97]||raw[0x2ac])};
  });
  return {table:{id,source:{path,sha256},map_flag_index:dat.readUInt32LE(0x92),records,
    header_setup_tlk_raw:dat.readUInt32LE(0x8a),header_entry_tlk_raw:dat.readUInt32LE(0x13a)},npcs};
}
async function sourceProgram(id,mapId){
  const bytes=await original(`Animate/${id}.anm`),source={path:`Animate/${id}.anm`,sha256:digest(bytes),bytes:bytes.length};
  const count=bytes.readUInt32LE(2);assert.equal(bytes.length,67+count*74);
  const commands=Array.from({length:count},(_,index)=>{
    const offset=67+index*74,raw=bytes.subarray(offset,offset+74),command={index,opcode:raw[0],raw_hex:raw.toString('hex'),source:{...source,offset}};
    for(const at of [1,5,9,13,17,21,25])command[`u32_plus${at}`]=raw.readUInt32LE(at);
    for(const at of [29,30,31,32,33])command[`byte_plus${at}`]=raw[at];
    if(command.opcode===10)command.filename=raw.subarray(54,74).toString('ascii').split('\0')[0];
    return command;
  });
  return {schema:'seventh-seal-chapter-anm',version:1,id,source,commands,maps:[mapId],
    expected:{control_map:mapId,caller_maps:[mapId]}};
}
async function fixture(mapId,names){
  const {table,npcs}=await sourceTable(mapId),content=copy(runtimeContent),world=copy(seed);
  world.opening.status='complete';world.location={map_id:mapId,x:1234,y:777,direction:4};
  content.maps[mapId]={...(content.maps[mapId]??{path:`data/maps/${mapId.toLowerCase()}.json`,triggers:[],objects:[],rests:[],routes:[]}),
    setup_record:table.header_setup_tlk_raw,...(table.header_entry_tlk_raw?{entry_record:table.header_entry_tlk_raw}:{})};
  const programs=Object.fromEntries(await Promise.all(names.map(async id=>[id,await sourceProgram(id,mapId)])));
  for(const [id,program]of Object.entries(programs))content.programs[id]=copy(program.source);
  const story={maps:{[mapId]:table},programs,flows:{[nativeFlowId(mapId)]:compileTlkFlow(table,{choices:chapterChoices})}};
  return {mapId,world,story,npcs,roles:resources.roles,content};
}
const slot=(rows,id)=>rows.find(row=>row.slot_zero_based===id);
const hiddenSlots=rows=>rows.filter(row=>row.hidden).map(row=>row.slot_zero_based).sort((a,b)=>a-b);
const hiddenByReturn=[10,11,12,14,15,16,17,19,20,21,22,23,24,25];

test('initial Fire Valley keeps DAT NPCs and preserves a separately declared arrival entry',async()=>{
  const value=await fixture('M17010',['m17010-4','m17010-5']),before=copy(value);
  assert.equal(value.story.maps.M17010.header_setup_tlk_raw,69);assert.equal(value.content.maps.M17010.entry_record,90);
  assert.deepEqual(hiddenSlots(value.npcs),[13,18,27,28,29]);
  assert.deepEqual(await projectMapStage(value),value.npcs);assert.deepEqual(value,before);
});

test('late return shows source slots28/29, hides the absent villagers, and ignores party placement',async()=>{
  const value=await fixture('M17010',['m17010-4','m17010-5']);value.world.flags[12]|=1;
  const before=copy(value),result=await projectMapStage(value);
  assert.deepEqual(hiddenSlots(result),[...hiddenByReturn,13,18,27].sort((a,b)=>a-b));
  assert.deepEqual({x:slot(result,28).x,y:slot(result,28).y,hidden:slot(result,28).hidden}, {x:1024,y:1054,hidden:false});
  assert.deepEqual({x:slot(result,29).x,y:slot(result,29).y,hidden:slot(result,29).hidden}, {x:1120,y:1052,hidden:false});
  assert.equal(result.some(row=>row.slot_zero_based<10),false);
  assert.deepEqual(value.world.location,{map_id:'M17010',x:1234,y:777,direction:4});
  assert.equal(value.world.flags[10]&16,0,'layout must not consume the separate arrival conversation');
  for(const id of hiddenByReturn){assert.equal(slot(result,id).x,slot(value.npcs,id).x);assert.equal(slot(result,id).y,slot(value.npcs,id).y);}
  assert.deepEqual(value,before);assert.deepEqual(await projectMapStage(value),result,'save preview and reload project the same state');
});

test('completed late-return conversation selects layout4 and does not reveal slots28/29 again',async()=>{
  const value=await fixture('M17010',['m17010-4','m17010-5']);value.world.flags[12]|=1;value.world.flags[10]|=16;
  const before=copy(value),result=await projectMapStage(value);
  assert.deepEqual(hiddenSlots(result),[...hiddenByReturn,13,18,27,28,29].sort((a,b)=>a-b));
  assert.deepEqual(result.filter(row=>!row.hidden).map(row=>row.slot_zero_based),[26]);
  assert.deepEqual(value,before);assert.deepEqual(await projectMapStage(value),result);
});

test('village and Lienan house source setup follow their own phase flags on every load',async()=>{
  for(const [mapId,names,flag,mask]of [['M17020',['m17020-1'],12,1],['M17028',['m17028'],10,16]]){
    const value=await fixture(mapId,names);assert.deepEqual(await projectMapStage(value),value.npcs);
    value.world.flags[flag]|=mask;const before=copy(value),result=await projectMapStage(value);
    assert.ok(result.length>0);assert.ok(result.every(row=>row.hidden));
    assert.deepEqual(await projectMapStage(value),result);assert.deepEqual(value,before);
  }
});

test('setup refuses mutating flows and non-layout ANM commands without changing world or source',async()=>{
  const value=await fixture('M17010',['m17010-4','m17010-5']);value.world.flags[12]|=1;
  const flow=value.story.flows[nativeFlowId(value.mapId)],entry=flow.commands.find(row=>row.id===flow.entries[69]);
  Object.assign(entry,{op:'set_flag',index:10,value:99});const before=copy(value);
  await assert.rejects(projectMapStage(value),/不能执行 set_flag/);assert.deepEqual(value,before);
  const animation=await fixture('M17010',['m17010-4','m17010-5','m17010-6']);animation.world.flags[12]|=1;
  const command=animation.story.flows[nativeFlowId(animation.mapId)].commands.find(row=>row.program_id==='m17010-5');
  command.program_id='m17010-6';const sourceBefore=copy(animation);
  await assert.rejects(projectMapStage(animation),/含非布局指令/);assert.deepEqual(animation,sourceBefore);
});

test('restoring late flags prepares their NPC layout from the saved world and skips arrival playback',async()=>{
  const value=await fixture('M17010',['m17010-4','m17010-5']),store=new WorldStore(copy(value.world));
  const saved=copy(value.world);saved.flags[12]|=1;saved.revision=77;saved.location={map_id:'M17010',x:1199,y:801,direction:2};
  const sourceBefore=copy(value),savedBefore=copy(saved),preparedWorlds=[],entryReasons=[];let arrivalPlaybacks=0;
  const controller=new SceneController({world:store,
    async prepare(id,options){
      assert.equal(id,'M17010');preparedWorlds.push(copy(options?.world));
      return {data:{id},npcs:await projectMapStage({...value,world:options?.world})};
    },validateEntry(){},commitView(){},
    async enter(scene,draft,reason){entryReasons.push(reason);if(reason==='restore')return false;arrivalPlaybacks++;return true;}
  });
  controller.current={data:{id:'M17010'},npcs:copy(value.npcs)};controller.setPhase('map');
  await controller.loadLocation(saved.location,{restoredWorld:saved,reason:'restore'});
  assert.deepEqual(preparedWorlds,[savedBefore]);assert.deepEqual(entryReasons,['restore']);assert.equal(arrivalPlaybacks,0);
  assert.equal(slot(controller.current.npcs,28).hidden,false);assert.equal(slot(controller.current.npcs,29).hidden,false);
  assert.equal(slot(controller.current.npcs,10).hidden,true);
  assert.deepEqual(store.snapshot(),savedBefore);assert.deepEqual(saved,savedBefore);assert.deepEqual(value,sourceBefore);
});

test('saved current-map actors override pure setup on restore, and ordinary entry reloads DAT/setup',async()=>{
  const value=await fixture('M17010',['m17010-4','m17010-5']);value.world.flags[12]|=1;
  value.world.map_npc_state={map_id:'M17010',actors:[{slot:28,x:1400,y:900,direction:3,hidden:true,action:0,frame:0}]};
  const restored=await projectMapStage(value);assert.deepEqual([slot(restored,28).x,slot(restored,28).y,slot(restored,28).hidden],[1400,900,true]);
  const store=new WorldStore(value.world),controller=new SceneController({world:store,
    prepare:async(id,{world})=>({data:{id},npcs:await projectMapStage({...value,world})}),validateEntry(){},commitView(){}});
  controller.current={data:{id:'M17010'},npcs:restored};controller.setPhase('map');
  await controller.loadLocation(value.world.location);
  assert.deepEqual([slot(controller.current.npcs,28).x,slot(controller.current.npcs,28).y,slot(controller.current.npcs,28).hidden],[1024,1054,false]);
  assert.equal('map_npc_state' in store.value,false,'ordinary entry does not retain a permanent per-map cache');
});

test('a failed restore of the late NPC layout rolls back the early scene, view and world',async()=>{
  const value=await fixture('M17010',['m17010-4','m17010-5']),store=new WorldStore(copy(value.world));
  const saved=copy(value.world);saved.flags[12]|=1;saved.location={map_id:'M17010',x:1199,y:801,direction:2};
  const before=store.snapshot(),savedBefore=copy(saved),sourceBefore=copy(value),view={phase:'early'},early={data:{id:'M17010'},npcs:copy(value.npcs)};
  let projected=null,rollbacks=0,entryCalls=0;
  const controller=new SceneController({world:store,
    async prepare(id,options){projected=await projectMapStage({...value,world:options?.world});return {data:{id},npcs:projected};},
    validateEntry(){},captureView:()=>copy(view),rollbackView(checkpoint){rollbacks++;Object.assign(view,checkpoint);},
    commitView(){view.phase='late';throw Error('restore layout view failure');},
    async enter(){entryCalls++;return false;}
  });
  controller.current=early;controller.setPhase('map');
  await assert.rejects(controller.loadLocation(saved.location,{restoredWorld:saved,reason:'restore'}),/restore layout view failure/);
  assert.equal(slot(projected,28).hidden,false);assert.equal(slot(projected,10).hidden,true);
  assert.equal(controller.current,early);assert.equal(controller.phase,'map');assert.deepEqual(view,{phase:'early'});
  assert.equal(rollbacks,1);assert.equal(entryCalls,0);assert.deepEqual(store.snapshot(),before);
  assert.deepEqual(saved,savedBefore);assert.deepEqual(value,sourceBefore);
});
