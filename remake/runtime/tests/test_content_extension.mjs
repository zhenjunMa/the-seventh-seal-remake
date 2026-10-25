// Synthetic identities reuse retained records to test extension contracts.
// They are isolated copies, never admitted as new original-game content.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runtimeContent,runtimeContentDefinition,validateContentRegistration} from '../web/core/content_registry.mjs';
import {validateContentDependencies,validateStoryBindings} from '../web/core/content_dependencies.mjs';
import {validateEncounterData,generateGroup,previewMovement,initialEncounterState} from '../web/core/encounters.mjs';
import {validateForestAIData} from '../web/core/forest_ai.mjs';
import {validateBattleViewMetadata,BattleView} from '../web/battle_view.mjs';
import {createPartyActors,partyResourcesForWorld,consumePartyMp} from '../web/core/party_attributes.mjs';
import {ChapterRunner,chapterRoleFromDefinition} from '../web/core/chapter.mjs';
import {validateChapterAnimation} from '../web/core/chapter_animation.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
const read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const copy=structuredClone;
const [seed,party,story,resources,encounters,ai,view]=await Promise.all(['opening_seed','party_combat','chapter_story','chapter_map_resources','encounters','forest_ai','party_battle_view'].map(read));
function newParty(){
  const content=copy(runtimeContent),world=copy(seed),attributes=copy(party);
  world.opening.status='complete';world.party.push(chapterRoleFromDefinition(world.source.role_definitions['002']));
  for(const id of ['003','004']){
    const source={...copy(content.roles['001'].source),path:`Fight_Role/${id}.CHR`};
    content.roles[id]={side:'player',native_slot:Number(id)-1,source};
    const definition={...copy(world.source.role_definitions['001']),id,path:source.path};
    world.source.role_definitions[id]=definition;world.source.source_hashes[source.path]=source.sha256;
    attributes.source_hashes[source.path]=source.sha256;
    attributes.actors[id]={...copy(attributes.actors['001']),id,resource_id:id,source,native_role_slot_zero_based:Number(id)-1,role_link_raw:Number(id)};
    const equipment={...copy(attributes.initial_equipment[0]),role_id:id};
    attributes.initial_equipment=attributes.initial_equipment.filter(row=>row.role_id!==id);attributes.initial_equipment.push(equipment);world.source.initial_equipment=world.source.initial_equipment.filter(row=>row.role_id!==id);world.source.initial_equipment.push(copy(equipment));
  }
  return {content,world,attributes};
}

test('compiled registration matches editable data and rejects duplicate slots and unknown handlers',async()=>{
  assert.deepEqual(runtimeContentDefinition,await read('runtime_content'));
  const c=copy(runtimeContent);c.roles['002'].native_slot=0;assert.throws(()=>validateContentRegistration(c),/角色槽/);
  c.roles['002'].native_slot=1;c.maps.M17026.objects[0].handler='unimplemented-shop';assert.throws(()=>validateContentRegistration(c),/处理器/);
});

test('another registered map keeps its own encounter identity and seeded movement preview',()=>{
  const c=copy(runtimeContent),d=copy(encounters);
  c.maps.M99001={...copy(c.maps.M70010),path:'data/maps/m99001.json'};d.maps.M99001=copy(d.maps.M70010);
  validateEncounterData(d,c);
  const queue=[0,0,0,0],group=generateGroup(d.maps.M99001,d,()=>queue.shift());assert.equal(group.map_id,'M99001');
  const state=initialEncounterState(seed.party);state.counters['001']=41;
  const draws=[999,0,0,0,0],result=previewMovement(state,{party:seed.party,leader_id:'001',map_id:'M99001',dx:16,dy:0},d,()=>draws.shift(),c);
  assert.equal(result.encounter.map_id,'M99001');assert.equal(state.counters['001'],41);
  assert.throws(()=>validateEncounterData(d),/地图遇敌规则/);
});

test('registered new enemy uses existing AI and view contracts, unregistered identity remains rejected',()=>{
  const c=copy(runtimeContent),data=copy(ai),meta=copy(view);
  c.roles['014']={...copy(c.roles['013']),source:{...copy(c.roles['013'].source),path:'Fight_Role/014.CHR'}};
  c.battle_rosters['party-source-group'].push('014');
  data.roles['014']={...copy(data.roles['013']),id:'014',source:copy(c.roles['014'].source)};
  validateForestAIData(data,c);
  const role={...copy(meta.roles.find(row=>row.id==='013')),id:'014'};
  for(const skill of [role.skill,...role.alternate_skills??[],...role.response_skills??[]])skill.role_id='014';
  meta.roles.push(role);validateBattleViewMetadata(meta,c);
  const renderer=new BattleView({canvas:{getContext:()=>({})},content:c});renderer.meta=meta;renderer.ready=true;
  renderer.setRoster([{id:'001',side:'player'},{id:'enemy-new',resource_id:'014',side:'enemy'}],{yantu:{id:'yantu',actor_id:'001'},test:{id:'test',actor_id:'enemy-new'}});
  assert.equal(renderer.roster[1].resource_id,'014');
  assert.throws(()=>validateForestAIData(data),/未登记/);
  assert.throws(()=>validateBattleViewMetadata(meta),/未登记/);
});

test('third and fourth party members join idempotently, retain formation/RNG and persist resources',async()=>{
  const {content,world,attributes}=newParty();world.encounters=initialEncounterState(world.party,1234);
  world.encounters.counters['001']=53;world.formation_slots=['001','002',null,null];
  // The production story now also exports real 003. This fixture deliberately
  // uses synthetic 003/004 identities, so give it matching private definitions.
  const data={...story,role_definitions:copy(world.source.role_definitions)};
  const store=new WorldStore(world),runner=new ChapterRunner({world:store,data,content,say:async()=>{}});
  const next=store.snapshot();
  for(const slot of [2,3])assert.equal(runner.joinActor({actorSlot:slot,modeRaw:0,draft:next}).added,true);
  assert.equal(runner.joinActor({actorSlot:2,modeRaw:0,draft:next}).added,false);
  assert.deepEqual(next.formation_slots,['001','002','003','004']);assert.equal(next.encounters.rng_state,1234);assert.equal(next.encounters.counters['001'],53);
  assert.deepEqual(next.encounters.counters,{'001':53,'002':0,'003':0,'004':0});
  const actors=createPartyActors(next,attributes,{},null,content);assert.equal(actors.length,4);
  const actor=consumePartyMp(actors[2],1,content);assert.equal(partyResourcesForWorld(actor,{content}).mp,65);
  next.party[2].mp.current=65;
  assert.deepEqual(await decodeSave(await encodeSave(next)),next);
  const unregistered=copy(runtimeContent);delete unregistered.roles['003'];
  assert.throws(()=>createPartyActors(next,attributes,{},null,unregistered),/未登记/);
});

test('same chest handler works on another registered map and rolls back failed animation',async()=>{
  const c=copy(runtimeContent),data=copy(story),id='M99001',table=copy(data.maps.M17026);
  table.id=id;table.source.path='Map/m99001.TLK';data.source_hashes[table.source.path]=table.source.sha256;
  for(const record of table.records)if(record.source)record.source.path=table.source.path;
  data.maps[id]=table;c.maps[id]={...copy(c.maps.M17026),path:'data/maps/m99001.json'};
  const world=copy(seed);world.opening.status='complete';world.location.map_id=id;world.flags[51]|=1;
  const store=new WorldStore(world),before=store.snapshot(),failed=new ChapterRunner({world:store,data,content:c,say:async()=>{},objectAnimation:async()=>{throw Error('fixture asset failure')}});
  await assert.rejects(failed.runObject({mapId:id,objectIndex:9}),/fixture asset failure/);assert.deepEqual(store.snapshot(),before);
  const runner=new ChapterRunner({world:store,data,content:c,say:async()=>{}});
  await runner.runObject({mapId:id,objectIndex:9});assert.equal(store.value.inventory.length,3);
  const after=store.snapshot();assert.equal((await runner.runObject({mapId:id,objectIndex:9})).already_done,true);assert.deepEqual(store.snapshot(),after);
});

test('new program registration accepts the supported bytecode and still rejects unknown opcodes or source drift',()=>{
  const c=copy(runtimeContent),program=copy(story.programs['m17029-1']);program.id='m99001-1';program.source.path='Animate/m99001-1.anm';
  for(const command of program.commands)command.source.path=program.source.path;
  for(const command of program.context_sources.map_commands)command.source.path=program.source.path;
  c.programs[program.id]=copy(program.source);validateChapterAnimation(program,c);
  assert.throws(()=>validateChapterAnimation(program),/来源不兼容/);
  const command=program.commands.find(command=>command.opcode!==10),opcode=command.opcode;
  command.opcode=254;assert.throws(()=>validateChapterAnimation(program,c),/未支持/);
  command.opcode=opcode;program.source.sha256='f'.repeat(64);assert.throws(()=>validateChapterAnimation(program,c),/来源不兼容/);
});

test('rest handler accepts different map/descriptor/record IDs and keeps explicit interaction and choice-source guards',async()=>{
  const c=copy(runtimeContent),data=copy(story),id='M99002',table=copy(data.maps.M17026);
  table.id=id;table.source.path='Map/m99002.TLK';data.source_hashes[table.source.path]=table.source.sha256;
  const remap=(source,newId)=>{
    const record=copy(source),raw=Buffer.from(record.raw_hex,'hex');record.id=newId;raw.writeUInt32LE(newId,0x13);
    for(const [field,offset]of [['condition_bit',0x1f],['if_true',0x2f],['next',0x33]]){record[field]=0;raw.writeUInt32LE(0,offset);}
    record.offset=table.record_base+(newId-1)*0x66f;
    record.source={...record.source,path:table.source.path,record_id:newId,offset:record.offset};
    return {record,raw};
  };
  const question=remap(table.records.find(row=>row.id===10),110),restore=remap(table.records.find(row=>row.id===12),112);
  question.raw.writeUInt32LE(112,0x59b);question.record.raw_hex=question.raw.toString('hex');restore.record.raw_hex=restore.raw.toString('hex');
  table.records=[question.record,restore.record];data.maps[id]=table;
  const binding=copy(c.maps.M17026.rests[0]);binding.descriptor_id=88;binding.record_id=110;binding.restore_records=[112];binding.choices[0].record_id=112;
  table.descriptors=[{...copy(table.descriptors.find(row=>row.id===2)),id:88,field_26_raw:110}];
  c.maps[id]={path:'data/maps/m99002.json',triggers:[],objects:[],rests:[binding],routes:[]};
  const value=copy(seed);value.opening.status='complete';value.location.map_id=id;value.party[0].hp.current=1;
  const world=new WorldStore(value),runner=new ChapterRunner({world,data,content:c,say:async()=>{},choose:async()=>0,animate:async()=>{}});
  await assert.rejects(runner.runTlk({mapId:id,recordId:110}),/主动交互入口/);assert.equal(world.value.party[0].hp.current,1);
  await runner.runRest({explicitInteraction:true,descriptorId:88});assert.equal(world.value.party[0].hp.current,world.value.party[0].hp.maximum);
  binding.choices[0].record_id=999;await assert.rejects(runner.runRest({explicitInteraction:true,descriptorId:88}),/原始选择不兼容/);
});

test('cross-file audit admits current content and rejects a registered enemy with missing dependencies',async()=>{
  const names={catalog:'catalog',seed:'opening_seed',story:'chapter_story',resources:'chapter_map_resources',party:'party_combat',commands:'party_skills',forest:'forest_combat',ai:'forest_ai',rewards:'party_rewards',reactions:'party_reactions',status:'forest_status',encounters:'encounters',view:'party_battle_view',itemView:'item_presentation',lifecycle:'battle_lifecycle',menu:'operation_menu'};
  const data=Object.fromEntries(await Promise.all(Object.entries(names).map(async([key,name])=>[key,await read(name)])));
  assert.deepEqual(validateContentDependencies(runtimeContent,data),{
    roles:Object.keys(runtimeContent.roles).length,maps:Object.keys(runtimeContent.maps).length,programs:Object.keys(runtimeContent.programs).length});
  const missingMenu=copy(data);delete missingMenu.menu.actor_panels['003'];
  assert.throws(()=>validateContentDependencies(runtimeContent,missingMenu),/菜单人物条/);
  const staleTiming=copy(data);staleTiming.menu.standing_actors['003'].interval_ms=120;
  assert.throws(()=>validateContentDependencies(runtimeContent,staleTiming),/菜单与战斗待机时序不一致/);
  const wrongTimingRole=copy(data);wrongTimingRole.menu.standing_actors['003'].timing_source.role_id='001';
  assert.throws(()=>validateContentDependencies(runtimeContent,wrongTimingRole),/菜单与战斗待机时序不一致/);
  const c=copy(runtimeContent);c.roles['014']={...copy(c.roles['013']),source:{...copy(c.roles['013'].source),path:'Fight_Role/014.CHR'}};
  assert.throws(()=>validateContentDependencies(c,data),/资源角色表/);
  const changed=copy(runtimeContent);changed.maps.M17029.triggers.push(999);
  assert.throws(()=>validateStoryBindings(changed,story,resources),/触发器 999/);
});
