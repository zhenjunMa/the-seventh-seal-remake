// Independently read the original outer White Forest DAT/TLK/ANM bytes. These
// rules replays are bounded source fixtures, not natural-route gameplay claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ChapterRunner,chapterChoices} from '../web/core/chapter.mjs';
import {ChapterAnimationRunner,validateChapterSetupAnimation} from '../web/core/chapter_animation.mjs';
import {projectMapStage} from '../web/core/map_stage.mjs';
import {compileTlkFlow,nativeFlowId} from '../web/core/story_flow_compiler.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {SceneController} from '../web/core/scenes.mjs';
import {inspectContentReadiness} from '../web/core/content_readiness.mjs';
const copy=structuredClone;
const read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const original=name=>readFile(new URL(`../../../${name}`,import.meta.url));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const [seed,resources,sourceIndex,mapData]=await Promise.all(['opening_seed','chapter_map_resources','library/white_forest','world_map'].map(read));
const ids=['M70010','M70020','M70030','M70040','M70050','M70060'];
const content=copy(runtimeContent),story={schema:'seventh-seal-chapter-story',version:1,maps:{},programs:{},source_hashes:{},item_definitions:{}};
const npcsByMap={},roles=copy(resources.roles);
for(const mapId of ids){
  const dat=await original(`Map/${mapId.toLowerCase()}.dat`),index=sourceIndex.maps[mapId];
  assert.equal(digest(dat),index.source.sha256);
  content.maps[mapId]={path:`data/maps/${mapId.toLowerCase()}.json`,triggers:[],objects:[],rests:[],routes:[],npcs:[]};
  npcsByMap[mapId]=index.npcs.map(row=>({id:`${mapId}-role-${row.slot_zero_based}`,slot_zero_based:row.slot_zero_based,
    resource_id:String(row.resource_id).padStart(3,'0'),x:row.x_runtime,y:row.y_runtime,direction:row.direction,hidden:row.hidden}));
  if(!index.dialogue?.records?.length)continue;
  const path=`Map/${mapId.toLowerCase()}.TLK`,tlk=await original(path),sha256=digest(tlk),record_base=0x1a+tlk.readUInt32LE(2)*4;
  const fields={speaker:0x0f,condition_type:0x17,condition_index:0x1b,condition_bit:0x1f,
    mutation_type:0x23,mutation_index:0x27,mutation_bit:0x2b,if_true:0x2f,next:0x33};
  const records=Array.from({length:tlk.readUInt32LE(6)},(_,i)=>{
    const offset=record_base+i*0x66f,raw=tlk.subarray(offset,offset+0x66f);
    assert.equal(raw.readUInt32LE(0x13),i+1);
    return {id:i+1,offset,kind:raw[0],style:raw[1],region_byte_raw:raw[7],condition_byte_raw_0b:raw[11],
      ...Object.fromEntries(Object.entries(fields).map(([key,at])=>[key,raw.readUInt32LE(at)])),
      text_raw:new TextDecoder('gbk').decode(raw.subarray(0x37,0x137)).split('\0')[0],raw_hex:raw.toString('hex'),
      source:{path,sha256,offset,record_id:i+1}};
  });
  story.source_hashes[path]=sha256;
  story.maps[mapId]={id:mapId,source:{path,sha256},record_base,map_flag_index:dat.readUInt32LE(0x92),records,
    header_setup_tlk_raw:dat.readUInt32LE(0x8a),header_entry_tlk_raw:dat.readUInt32LE(0x13a),
    descriptors:index.descriptors,index_nonzero:index.npcs.map(row=>row.dialogue_index_entry).filter(Boolean)};
}
for(const mapId of ['M70010','M70030']){
  const id=`${mapId.toLowerCase()}-1`,path=`Animate/${id}.anm`,bytes=await original(path),source={path,sha256:digest(bytes),bytes:bytes.length};
  const commands=Array.from({length:bytes.readUInt32LE(2)},(_,index)=>{
    const offset=67+index*74,raw=bytes.subarray(offset,offset+74),row={index,opcode:raw[0],raw_hex:raw.toString('hex'),source:{...source,offset}};
    for(const at of [1,5,9,13,17,21,25])row[`u32_plus${at}`]=raw.readUInt32LE(at);
    for(let at=29;at<34;at++)row[`byte_plus${at}`]=raw[at];
    if(row.opcode===10)row.filename=raw.subarray(54).toString('ascii').split('\0')[0];
    return row;
  });
  story.programs[id]={schema:'seventh-seal-chapter-anm',version:1,id,source,commands,maps:[mapId],expected:{control_map:mapId,caller_maps:[mapId]}};
  content.programs[id]=copy(source);content.maps[mapId].setup_record=story.maps[mapId].header_setup_tlk_raw;
}
// Pose projection only needs the original DGP action dimensions. No placeholder
// image is introduced for the newly admitted NPC 061.
if(!roles['061']){
  const bytes=await original('ROLE/061.dgp');assert.equal(bytes[0],9);
  roles['061']={actions:Array.from({length:bytes[2]},(_,index)=>{
    const raw=bytes.subarray(67+index*172,67+(index+1)*172);
    return {index,first_frame:raw.readUInt32LE(0x72),frame_count:raw[14],directions:Math.max(1,raw[0])};
  })};
}
content.maps.M70010.npcs=[10,11,12,13,14];content.maps.M70010.triggers=[4];
content.maps.M70030.npcs=[10];content.maps.M70060.triggers=[2];
const itemBytes=await original('SYSTEM/Object.ITM'),itemOffset=0x61c+169*0x3bf,itemRaw=itemBytes.subarray(itemOffset,itemOffset+0x3bf);
assert.equal(itemRaw.readUInt32LE(0),170);
story.source_hashes['SYSTEM/Object.ITM']=digest(itemBytes);
story.item_definitions[170]={id:170,name:new TextDecoder('gbk').decode(itemRaw.subarray(4,28)).split('\0')[0],
  raw_hex:itemRaw.toString('hex'),source:{path:'SYSTEM/Object.ITM',sha256:digest(itemBytes),offset:itemOffset}};
story.flows=Object.fromEntries(Object.values(story.maps).map(table=>[nativeFlowId(table.id),compileTlkFlow(table,{choices:chapterChoices})]));
const mapIds=Object.keys(content.maps);
function world(mapId,{pursuit=false,late=false,request=false,reward=false}={}){
  const value=copy(seed);value.opening.status='complete';value.location={map_id:mapId,x:599,y:711,direction:4};
  for(const [index,mask,on]of [[10,2,pursuit],[384,1,late],[7,1,request],[111,1,reward]])value.flags[index]=on?value.flags[index]|mask:value.flags[index]&~mask;
  return new WorldStore(value,mapIds);
}
function fixture(mapId,value){return {mapId,world:value?.value??value,story,npcs:npcsByMap[mapId],roles,content};}
function runner(value,extra={}){
  return new ChapterRunner({world:value,data:story,content,say:async()=>{},choose:async({choices})=>choices[0].index,
    worldMapState:()=>({areas:mapData.areas.map(({id,selected_index,statuses})=>({id,selected_index,statuses:[...statuses]}))}),...extra});
}
const bySlot=(rows,slot)=>rows.find(row=>row.slot_zero_based===slot);

test('generated outer dialogue and both loader programs retain the independent original byte records',async()=>{
  const generated=await read('chapter_story');
  assert.deepEqual(Object.keys(sourceIndex.maps),ids);
  for(const [mapId,table]of Object.entries(story.maps)){
    const actual=generated.maps[mapId];assert.ok(actual,mapId);
    assert.deepEqual(actual.records.map(row=>row.raw_hex),table.records.map(row=>row.raw_hex));
    assert.equal(actual.header_setup_tlk_raw,table.header_setup_tlk_raw);assert.equal(actual.header_entry_tlk_raw,0);
    assert.equal(actual.map_flag_index,table.map_flag_index);
  }
  for(const [id,program]of Object.entries(story.programs))assert.deepEqual(generated.programs[id].commands.map(row=>row.raw_hex),program.commands.map(row=>row.raw_hex));
  const selected={...content,maps:Object.fromEntries(ids.map(id=>[id,content.maps[id]]))};
  const report=inspectContentReadiness(selected,story,resources);
  assert.equal(report.passed,true,JSON.stringify(report.errors));
  assert.equal(report.entrances.filter(row=>row.kind==='setup').length,2);
});

test('White Forest loader source projects the pursuit camp only between the actual 10:2 and 384:1 transitions',async()=>{
  assert.deepEqual(story.programs['m70010-1'].commands.map(row=>row.opcode),[10,35,35,35,35,35,32,31,16,30,16]);
  for(const pursuit of [false,true])for(const late of [false,true]){
    const value=world('M70010',{pursuit,late}),before=value.snapshot(),sourceBefore=copy(npcsByMap.M70010);
    const npcs=await projectMapStage(fixture('M70010',value)),camp=pursuit&&!late;
    assert.equal(bySlot(npcs,10).hidden,false);
    for(const slot of [11,12,13,14])assert.equal(bySlot(npcs,slot).hidden,!camp,`${slot}, pursuit=${pursuit}, late=${late}`);
    if(camp)assert.deepEqual([11,12,13,14].map(slot=>{const row=bySlot(npcs,slot);return [row.x,row.y,row.direction,row.stage_action,row.stage_frame];}),
      [[224,720,0,0,0],[416,752,0,0,0],[256,704,0,0,0],[400,720,0,0,0]]);
    assert.deepEqual(await projectMapStage(fixture('M70010',value)),npcs);
    assert.deepEqual(value.snapshot(),before);assert.deepEqual(npcsByMap.M70010,sourceBefore);
  }
});

test('Istan appears only after the external 7:1 handoff, using source loader coordinates',async()=>{
  for(const request of [false,true]){
    const value=world('M70030',{request}),before=value.snapshot(),npcs=await projectMapStage(fixture('M70030',value));
    assert.equal(bySlot(npcs,10).hidden,!request);
    if(request)assert.deepEqual([npcs[0].x,npcs[0].y,npcs[0].stage_action,npcs[0].stage_frame],[238,434,0,0]);
    assert.deepEqual(value.snapshot(),before);
  }
});

test('the shared setup validator admits source focus and barrier but rejects world effects and map changes',()=>{
  const program=story.programs['m70010-1'];assert.equal(validateChapterSetupAnimation(program,'M70010',content),program);
  assert.throws(()=>validateChapterSetupAnimation(program,'M70030',content),/不能切换地图/);
  const changed=copy(program),command=changed.commands[6];
  command.opcode=14;command.raw_hex='0e'+command.raw_hex.slice(2);
  assert.throws(()=>validateChapterSetupAnimation(changed,'M70010',content),/含非布局指令 14/);
});

test('source camp ANM still runs its focus and barrier through the shared presentation executor',async()=>{
  const trace=[],value=world('M70010',{pursuit:true});
  await new ChapterAnimationRunner({program:story.programs['m70010-1'],content,initialLocation:value.value.location,
    hooks:Object.fromEntries(['map','actor','move','camera','wait'].map(name=>[name,async row=>trace.push({name,...row})]))}).run();
  assert.deepEqual(trace.filter(row=>row.name==='camera').map(row=>[row.command.index,row.kind,row.actor,row.modeRaw]),[[6,'focus',0,1]]);
  assert.deepEqual(trace.filter(row=>row.kind==='barrier').map(row=>row.command.index),[7]);
  assert.equal(trace.filter(row=>row.kind==='place').length,5);
});

test('the two actual world-map exits follow both source flag decisions',async()=>{
  for(const mapId of ['M70010','M70060'])for(const pursuit of [false,true])for(const late of [false,true]){
    const value=world(mapId,{pursuit,late}),result=await runner(value).runTlk({mapId,recordId:1,triggerId:mapId==='M70010'?4:2});
    const expected=mapId==='M70010'?(!pursuit?[1,15]:late?[1,15,16,17]:[1,15,16])
      :!pursuit?[1,10,2,3,4]:late?[1,5,9]:[1,5,11,6,8];
    assert.deepEqual(result.traversed,expected,`${mapId}, pursuit=${pursuit}, late=${late}`);
    const selected=mapId==='M70060'&&pursuit&&!late?2:6;
    // Native TLK mutations run on record entry, before its condition selects
    // the next record. M70010:r15 already opens destination6 on both branches.
    assert.deepEqual(result.world_map_requested,{area:0});assert.equal(value.value.world_map.areas[0].selected_index,selected);
    if(mapId==='M70060')assert.equal(Boolean(value.value.flags[story.maps[mapId].map_flag_index]&1),!pursuit);
  }
});

test('Istan original purple-crystal reward commits once, rolls back an interrupted receipt, and survives save restore',async()=>{
  const value=world('M70030',{request:true}),before=value.snapshot();let staged=false;
  await assert.rejects(runner(value,{say:async({record,draft})=>{
    if(record.id!==9)return;staged=true;assert.equal(draft.inventory.find(row=>row.id===170)?.quantity,1);throw Error('receipt interrupted');
  }}).runTlk({mapId:'M70030',recordId:3,context:{steps:0,explicitInteraction:true}}),/receipt interrupted/);
  assert.equal(staged,true);assert.deepEqual(value.snapshot(),before);
  const result=await runner(value).runTlk({mapId:'M70030',recordId:3,context:{steps:0,explicitInteraction:true}});
  assert.deepEqual(result.traversed,[3,4,5,6,7,8,9]);assert.equal(value.value.flags[111]&1,1);
  assert.equal(value.value.inventory.find(row=>row.id===170)?.quantity,1);
  const restored=new WorldStore(await decodeSave(await encodeSave(value.snapshot()),mapIds),mapIds),inventory=copy(restored.value.inventory);
  assert.deepEqual((await runner(restored).runTlk({mapId:'M70030',recordId:3,context:{steps:0,explicitInteraction:true}})).traversed,[3,10]);
  assert.deepEqual(restored.value.inventory,inventory);
});

test('every admitted outer NPC uses its real TLK entry, including communication-crystal save choices',async()=>{
  for(const mapId of ['M70010','M70030'])for(const slot of content.maps[mapId].npcs){
    const value=world(mapId,{pursuit:true,request:true}),entry=story.maps[mapId].index_nonzero.find(row=>row.slot===slot);
    const result=await runner(value).runTlk({mapId,recordId:entry.record,context:{steps:0,explicitInteraction:true}});
    assert.ok(result.traversed.includes(entry.record));
  }
  const entry=story.maps.M70010.records.find(row=>row.id===2),choices=chapterChoices(entry);
  assert.equal(choices.length,2);
  for(const choice of choices){
    const value=world('M70010'),result=await runner(value,{choose:async()=>choice.index}).runTlk({mapId:'M70010',recordId:2,context:{steps:0,explicitInteraction:true}});
    assert.equal(result.save_requested,choice.recordId===3);
  }
});

test('restoring pursuit layout uses saved flags and coordinates without invoking arrival or world-map exits',async()=>{
  const value=world('M70010'),saved=world('M70010',{pursuit:true}).snapshot();saved.location={map_id:'M70010',x:811,y:919,direction:6};
  const prepared=[],controller=new SceneController({world:value,
    async prepare(id,{world:preview}){prepared.push(copy(preview));return {data:{id},npcs:await projectMapStage(fixture(id,preview))};},
    validateEntry(){},commitView(){},async enter(scene,draft,reason){assert.equal(reason,'restore');return false;}});
  controller.current={data:{id:'M70010'},npcs:copy(npcsByMap.M70010)};controller.setPhase('map');
  await controller.loadLocation(saved.location,{restoredWorld:saved,reason:'restore'});
  assert.deepEqual(value.snapshot(),saved);assert.deepEqual(prepared,[saved]);assert.equal(bySlot(controller.current.npcs,11).hidden,false);
  assert.equal(value.value.world_map,undefined);
});
