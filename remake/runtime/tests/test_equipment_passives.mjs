// Real regional grants, menu/save APIs and bounded original x86 replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const local=name=>new URL(`../${name}`,import.meta.url);
const required=[
  'web/data/items.json','web/data/config/items.json','web/data/party_combat.json','web/data/opening_seed.json',
  'web/data/chapter_story.json','web/data/forest_status.json','web/data/forest_combat.json','web/data/party_rewards.json',
  'web/data/runtime_content.json','web/data/runtime_content.mjs','web/data/combat_sample.json',
  'evidence/forest_status_instructions_20261011.json',
  'evidence/white_forest_20261026/reward_passives/native_bundle.json',
].map(name=>({name,path:local(name)}));
for(const name of ['GAME.exe','SYSTEM/Object.ITM','Map/m70030.TLK','Map/m72063-3.TLK','Map/m72064.TLK','Fight_Role/031A.CHR','Fight_Role/031B.CHR','Fight_Role/033.CHR'])required.push({name,path:new URL(`../../../${name}`,import.meta.url)});
if(process.env.SEVENTH_SEAL_ITEM_TEST_CATALOG)required.push({name:process.env.SEVENTH_SEAL_ITEM_TEST_CATALOG,path:process.env.SEVENTH_SEAL_ITEM_TEST_CATALOG});
const missing=[];
async function checkMaterials(rows){
  await Promise.all(rows.map(async row=>{try{await access(row.path);}catch(error){
    if(error.code==='ENOENT')missing.push(row.name);else throw error;
  }}));
}
await checkMaterials(required);
if(!missing.length){
  // The official resolver checks every admitted map against original DAT.
  // Check those local inputs before importing/running the optional oracle suite.
  const registration=JSON.parse(await readFile(local('web/data/runtime_content.json'),'utf8'));
  await checkMaterials(Object.keys(registration.maps).flatMap(id=>[
    {name:`web/data/maps/${id.toLowerCase()}.json`,path:local(`web/data/maps/${id.toLowerCase()}.json`)},
    {name:`Map/${id.toLowerCase()}.dat`,path:new URL(`../../../Map/${id.toLowerCase()}.dat`,import.meta.url)},
  ]));
}
if(missing.length){
  test('White Forest real reward passives require transferred local source/oracle materials',
    {skip:`Local source/oracle materials unavailable: ${missing.sort().join(', ')}`},()=>{});
}else{
const {NativeAssemblyOracle}=await import('./native_assembly_oracle.mjs');
const {compileItemConfiguration,deriveItemConfiguration,upgradeItemConfiguration}=await import('../web/core/item_registry.mjs');
const {WorldStore,encodeSave,decodeSave}=await import('../web/core/world.mjs');
const {ChapterRunner,chapterChoices,initializeChapterItem}=await import('../web/core/chapter.mjs');
const {compileTlkFlow,nativeFlowId}=await import('../web/core/story_flow_compiler.mjs');
const {changeEquipment}=await import('../web/core/items.mjs');
const {insertCrystal,removeCrystal}=await import('../web/core/crystal_sockets.mjs');
const {createPartyActors}=await import('../web/core/party_attributes.mjs');
const {initializeNativeStatuses,applyNativeSkillStatus,tickNativeStatuses,clearNativeStatuses}=await import('../web/core/battle_status.mjs');
const {isSupportedItemPassiveDefinition,equipmentPassiveRows}=await import('../web/core/item_passives.mjs');
const {readContentDefinition}=await import('../tools/resolve_content_definition.mjs');
const {BattleController}=await import('../web/core/combat.mjs');
const {createRewardLedger,collectEnemyDefeat,planVictoryRewards}=await import('../web/core/battle_rewards.mjs');
const read=async name=>JSON.parse(await readFile(new URL(`../${name}`,import.meta.url),'utf8'));
const [published,overrides,attributes,seed,story,statusData,assembly,bundle]=await Promise.all([
  'web/data/items.json','web/data/config/items.json','web/data/party_combat.json','web/data/opening_seed.json',
  'web/data/chapter_story.json','web/data/forest_status.json','evidence/forest_status_instructions_20261011.json',
  'evidence/white_forest_20261026/reward_passives/native_bundle.json'].map(read));
const source=process.env.SEVENTH_SEAL_ITEM_TEST_CATALOG?JSON.parse(await readFile(process.env.SEVENTH_SEAL_ITEM_TEST_CATALOG,'utf8')):published;
const items=compileItemConfiguration(source,overrides,'original').data,copy=structuredClone,ZERO='00'.repeat(0xc6);
const {content}=await readContentDefinition();
const functions={...assembly.instructions};
for(const address of ['0x47a6a0','0x508bb0'])functions[address]=bundle.records.find(row=>row.operation==='procedure_assembly'&&row.parameters.procedure===address).normalized_result.split(/\r?\n/);
const draws=values=>{let at=0;const rng=()=>{assert.ok(at<values.length,'unexpected native RNG');return values[at++];};Object.defineProperty(rng,'calls',{get:()=>at});return rng;};
function instance(id){const def=items.definitions[id],raw=initializeChapterItem(def);new DataView(raw.buffer).setUint32(4,1,true);
  return {instance_id:`passive-fixture-${id}`,id,name:def.name,quantity:1,source_raw_hex:Buffer.from(raw).toString('hex')};}

async function rewardedWorld(){
  const initial=copy(seed);initial.opening.status='complete';initial.location={map_id:'M70020',x:0,y:0,direction:0};
  // Declared test key placement. The tested 127 itself must come from the
  // original CF4 grant; external key acquisition is outside this bounded case.
  initial.inventory.push(instance(336));
  const world=new WorldStore(initial),data=copy(story);data.item_definitions=items.definitions;
  data.flows=Object.fromEntries(Object.values(data.maps).filter(table=>table.records.length)
    .map(table=>[nativeFlowId(table.id),compileTlkFlow(table,{choices:chapterChoices})]));
  const runner=new ChapterRunner({world,data,content,say:async()=>{},choose:async()=>0,objectAnimation:async()=>{}});
  await runner.runObject({mapId:'M70020',objectIndex:3});assert.ok(world.value.inventory.some(row=>row.id===127));
  const inventory=copy(world.value.inventory);assert.equal((await runner.runObject({mapId:'M70020',objectIndex:3})).already_done,true);
  assert.deepEqual(world.value.inventory,inventory);
  world.transact(draft=>{draft.location={map_id:'M70030',x:0,y:0,direction:0};draft.flags[7]|=1;});
  // 7:1 is the declared external Istan request prerequisite. Actual r3..9,
  // including r8 grant and111:1, run through the production StoryFlow.
  const result=await runner.runTlk({mapId:'M70030',recordId:3,context:{steps:0,explicitInteraction:true}});
  assert.deepEqual(result.traversed,[3,4,5,6,7,8,9]);assert.ok(world.value.inventory.some(row=>row.id===170));
  const repeat=await runner.runTlk({mapId:'M70030',recordId:3,context:{steps:0,explicitInteraction:true}});
  assert.deepEqual(repeat.traversed,[3,10]);assert.equal(world.value.inventory.find(row=>row.id===170).quantity,1);
  changeEquipment(world,attributes,items,{roleId:'001',slotId:'special',instanceId:world.value.inventory.find(row=>row.id===127).instance_id});
  insertCrystal({worldStore:world,attributes,itemData:items,roleId:'001',socketIndex:1,instanceId:world.value.inventory.find(row=>row.id===170).instance_id});
  return world;
}

class Oracle extends NativeAssemblyOracle{
  constructor(actor,rng){super(functions,[actor],rng);this.cancellations=0;
    actor.native_status_slots.forEach((row,index)=>Buffer.from(row.raw_hex,'hex').forEach((value,offset)=>this.write(0x521a7d2+index*0xc6+offset,value,1)));
    this.write(0x521f52a,actor.status_flags_raw);this.write(0x55edfd0,1,1);this.write(0x503b7e8,0x30000000);
    for(const passive of actor.equipment_passives??[]){
      this.write(0x4f998a8+passive.group_index*0x8f2+passive.entry_index*0xe5,passive.item_id);
      Buffer.from(items.definitions[passive.item_id].raw_hex,'hex').forEach((value,offset)=>this.write(0x30000000+(passive.item_id-1)*0x3bf+offset,value,1));
    }
  }
  regRead(name){return name==='BL'?this.reg.EBX&255:super.regRead(name);}
  regWrite(name,value){if(name==='BL')this.reg.EBX=(this.reg.EBX&~255)|(value&255);else super.regWrite(name,value);}
  external(target){const arg=i=>this.read(this.reg.ESP+i*4);
    if(target===0x570a40){for(let i=0;i<arg(2);i++)this.write(arg(0)+i,arg(1),1);this.reg.EAX=arg(0);return;}
    if(target===0x570d10){const b=Array.from({length:arg(2)},(_,i)=>this.read(arg(1)+i,1));b.forEach((v,i)=>this.write(arg(0)+i,v,1));this.reg.EAX=arg(0);return;}
    if(target===0x507c60){this.write(arg(0),(this.read(arg(0))|(arg(1)&0x3ff))>>>0);return;}
    if(target===0x401609){this.cancellations++;return;}
    return super.external(target);
  }
  compare(actor){for(let slot=0;slot<100;slot++)assert.equal(Buffer.from(Array.from({length:0xc6},(_,i)=>this.read(0x521a7d2+slot*0xc6+i,1))).toString('hex'),actor.native_status_slots[slot].raw_hex,`slot${slot}`);
    assert.equal(this.read(0x521f52a)>>>0,actor.status_flags_raw);
    for(const field of statusData.aggregation)assert.equal(this.read(Number(field.address),field.bits===8?1:4),actor.status_by_address[field.address]);}
}

test('only registered real CF4/TLK/CHR rewards admit the exact original mode6 blocks',async()=>{
  const admitted=source.catalog.item_capability_admission.passive_item_ids;
  assert.deepEqual(admitted.filter(id=>![195,202].includes(id)),[127,170]);assert.deepEqual(admitted.filter(id=>[195,202].includes(id)),[195,202]);
  const original=await readFile(new URL('../../../SYSTEM/Object.ITM',import.meta.url));
  assert.equal(createHash('sha256').update(original).digest('hex'),source.source_hashes['SYSTEM/Object.ITM']);
  for(const id of [127,170,195,202]){const def=items.definitions[id];assert.equal(isSupportedItemPassiveDefinition(def),true);
    assert.equal(original.subarray(def.source.record_offset,def.source.record_offset+959).toString('hex'),def.raw_hex);
    assert.equal(def.equipment_passive.effect_raw_hex,original.subarray(def.source.record_offset+0x2a8,def.source.record_offset+0x36e).toString('hex'));}
  assert.equal(items.definitions[127].behavior.kind,'equip');assert.equal(items.definitions[170].behavior.kind,'status-immunity-crystal');
  assert.equal(items.definitions[170].equipment_passive.application_chance_raw,60);
  const wind=items.definitions[195];assert.equal(wind.behavior.kind,'status-immunity-crystal');
  assert.deepEqual([wind.equipment_passive.effect_id_raw,wind.equipment_passive.mode_raw,wind.equipment_passive.application_chance_raw],[6,6,0]);
  assert.equal(Buffer.from(wind.equipment_passive.effect_raw_hex,'hex').readInt32LE(2),-1);
  const origins=source.catalog.item_capability_admission.passive_sources[195];
  assert.deepEqual(origins.map(row=>[row.kind,row.map_id,row.record_id,row.enemy_id,row.enemy_slot,row.reward_slot]),
    [['registered-enemy-reward','M72063-3',3,'031A',2,2],['registered-enemy-reward','M72063-3',3,'031B',4,2]]);
  const energy=items.definitions[202];assert.equal(energy.behavior.kind,'status-immunity-crystal');
  assert.deepEqual([energy.equipment_passive.effect_id_raw,energy.equipment_passive.mode_raw,energy.equipment_passive.application_chance_raw],[38,6,0]);
  assert.equal(Buffer.from(energy.equipment_passive.effect_raw_hex,'hex').readInt32LE(2),-1);
  const energyOrigins=source.catalog.item_capability_admission.passive_sources[202];
  assert.deepEqual(energyOrigins.map(row=>[row.kind,row.map_id,row.record_id,row.enemy_id,row.enemy_slot,row.reward_slot]),
    [['registered-enemy-reward','M72064',8,'033',0,3]]);
  for(const [rows,id]of [[origins,195],[energyOrigins,202]])for(const row of rows){const chr=await readFile(new URL(`../../../${row.source.path}`,import.meta.url));
    assert.equal(createHash('sha256').update(chr).digest('hex'),row.source.sha256);assert.equal(chr.readInt32LE(row.source.offset),id);}
  const forged=copy(items.definitions[170]);forged.equipment_passive.effect_id_raw=35;assert.equal(isSupportedItemPassiveDefinition(forged),false);
});

test('real FF02 crystal rewards preserve native chance0 guaranteed immunity with one RNG draw',async()=>{
  const rewards=await read('web/data/party_rewards.json'),initial=copy(seed);
  initial.opening.status='complete';initial.location={map_id:'M72063-3',x:400,y:320,direction:0};
  const world=new WorldStore(initial);
  // Source groups below are reward-planning fixtures, not rendered victories.
  for(const [mapId,ids,itemId,quantity]of [['M72063-3',['031C','031A','031B'],195,2],['M72064',['033'],202,1]]){
    world.transact(draft=>{draft.location.map_id=mapId;});
    const actors=[{id:'001',side:'player',hp:{current:1},immune_raw:0,state_raw:0},
      ...ids.map(id=>({id,side:'enemy',hp:{current:0}}))],ledger=createRewardLedger(`ff02-source-loot-${mapId}`,actors);
    for(const actor of actors.slice(1))collectEnemyDefeat(ledger,actor,{data:rewards});
    const plan=planVictoryRewards({world:world.snapshot(),ledger,data:rewards,actors,rng:()=>0});
    assert.equal(plan.summary.drops.find(row=>row.id===itemId).quantity,quantity);
    world.transact(draft=>{Object.assign(draft,plan.world_patch);(draft.reward_records??=[]).push(plan.reward_record);});
    insertCrystal({worldStore:world,attributes,itemData:items,roleId:'001',socketIndex:1,
      instanceId:world.value.inventory.find(row=>row.id===itemId).instance_id});
    const saved=world.snapshot();world.replace(await decodeSave(await encodeSave(saved)));assert.deepEqual(world.snapshot(),saved);
    assert.equal(planVictoryRewards({world:world.snapshot(),ledger,data:rewards,actors,rng:()=>assert.fail('Repeated reward RNG')}).applied,false);
    const actor=createPartyActors(world.snapshot(),attributes,{},items)[0],effectId=itemId===195?6:38;
    assert.deepEqual(actor.equipment_passives.map(row=>row.item_id),[itemId]);
    for(const roll of [0,1,99,32767]){
      const rng=draws([roll]),nativeRng=draws([roll]),oracle=new Oracle(clearNativeStatuses(actor,statusData),nativeRng);
      const actual=initializeNativeStatuses(actor,statusData,undefined,rng);oracle.run(0x47a6a0,[0]);oracle.compare(actual);
      assert.equal(rng.calls,1);assert.deepEqual(oracle.rng_calls,[roll]);
      assert.deepEqual(actual.native_status_slots.filter(row=>row.raw_hex!==ZERO).map(row=>parseInt(row.raw_hex.slice(2,4),16)),[effectId]);
      assert.equal(tickNativeStatuses({actor:actual,threshold:1,now:100000,data:statusData,rng:draws([])}).ticks,0);
    }
    removeCrystal({worldStore:world,attributes,itemData:items,roleId:'001',socketIndex:1});
    const removed=world.snapshot();assert.deepEqual(await decodeSave(await encodeSave(removed)),removed);
    assert.equal(world.value.inventory.find(row=>row.id===itemId).quantity,quantity);
  }
});

test('real rewards equip/socket and retain bytes through save, disable and removal',async()=>{
  const world=await rewardedWorld(),before=world.snapshot();
  assert.deepEqual(await decodeSave(await encodeSave(before)),before);
  const actors=createPartyActors(before,attributes,{},items);assert.deepEqual(actors[0].equipment_passives.map(row=>[row.item_id,row.group_index,row.entry_index]),[[170,0,1],[127,5,0]]);
  const disabled=copy(items);disabled.definitions[127].runtime_enabled=false;disabled.definitions[170].runtime_enabled=false;
  assert.deepEqual(createPartyActors(before,attributes,{},disabled)[0].equipment_passives,actors[0].equipment_passives);
  removeCrystal({worldStore:world,attributes,itemData:disabled,roleId:'001',socketIndex:1});
  changeEquipment(world,attributes,disabled,{roleId:'001',slotId:'special'});
  assert.deepEqual(createPartyActors(world.snapshot(),attributes,{},disabled)[0].equipment_passives,[]);
  assert.deepEqual(world.value.party,before.party);
});

test('47A6A0 and508BB0 x86 match native order, inclusive61% admission and dormant key payload',async()=>{
  const world=await rewardedWorld(),a=createPartyActors(world.snapshot(),attributes,{},items)[0];
  for(const roll of [0,59,60,61,99,32767]){
    const raw=clearNativeStatuses(a,statusData),rng=draws([roll,100]),nativeRng=draws([roll,100]),oracle=new Oracle(raw,nativeRng);
    const actual=initializeNativeStatuses(a,statusData,undefined,rng);oracle.run(0x47a6a0,[0]);oracle.compare(actual);
    assert.equal(rng.calls,2);assert.deepEqual(oracle.rng_calls,[roll,100]);
    const ids=actual.native_status_slots.map(row=>parseInt(row.raw_hex.slice(2,4),16)).filter(Boolean);
    assert.deepEqual(ids,roll%100<=60?[6,35]:[35]);assert.equal(actual.hp.current,a.hp.current);
    const tick=tickNativeStatuses({actor:actual,threshold:1,now:100000,data:statusData,rng:draws([])});
    assert.equal(tick.ticks,0);assert.equal(tick.actor.hp.current,a.hp.current);assert.deepEqual(tick.actor.native_status_slots,actual.native_status_slots);
  }
});

test('real032 skill11 confusion still draws its application chance before mode6 rejects it',async()=>{
  const world=await rewardedWorld(),a=createPartyActors(world.snapshot(),attributes,{},items)[0];
  const actual=initializeNativeStatuses(a,statusData,undefined,draws([60,100])),rng=draws([0]);
  const skill=statusData.skills['032:11'];assert.equal(skill.effect_id_raw,6);
  const result=applyNativeSkillStatus({actor:actual,skill,data:statusData,rng,now:0});
  assert.equal(result.reason,'effect-immunity');assert.equal(result.applied,false);assert.equal(rng.calls,1);assert.deepEqual(result.actor,actual);
  const unprotected=initializeNativeStatuses(a,statusData,undefined,draws([61,100]));
  assert.equal(applyNativeSkillStatus({actor:unprotected,skill,data:statusData,rng:draws([0]),now:0}).applied,true);
});

test('production battle start installs the source passives before the first action',async()=>{
  const world=await rewardedWorld(),sample=await read('web/data/combat_sample.json');
  const actor=createPartyActors(world.snapshot(),attributes,{},items)[0],rng=draws([60,100]),before=world.snapshot();
  const battle=new BattleController({world,itemData:items,resolveAction:()=>{},applyDamage:()=>{},playAction:async()=>{}});
  battle.start({...sample,actors:[actor,sample.actors[1]],rng,status_data:statusData});
  assert.equal(rng.calls,2);
  assert.deepEqual(battle.actor('001').native_status_slots.filter(row=>row.raw_hex!==ZERO).map(row=>parseInt(row.raw_hex.slice(2,4),16)),[6,35]);
  assert.deepEqual(world.snapshot(),before,'initialization only changes the private battle actors');
});

test('retained hidden sockets still supply passives without a weapon; duplicate modes draw once',async()=>{
  const world=await rewardedWorld();changeEquipment(world,attributes,items,{roleId:'001',slotId:'weapon'});
  const a=createPartyActors(world.snapshot(),attributes,{},items)[0];assert.deepEqual(a.equipment_passives.map(row=>row.item_id),[170,127]);
  // Bounded duplicate-source branch fixture, without a second regional grant.
  a.equipment_passives.splice(1,0,{...copy(a.equipment_passives[0]),entry_index:2});
  const rng=draws([60,100]),nativeRng=draws([60,100]),raw=clearNativeStatuses(a,statusData),oracle=new Oracle(raw,nativeRng);
  const actual=initializeNativeStatuses(a,statusData,undefined,rng);oracle.run(0x47a6a0,[0]);oracle.compare(actual);
  assert.equal(rng.calls,2);assert.deepEqual(oracle.rng_calls,[60,100]);
  assert.equal(actual.equipment_passive_initialization[1].reason,'duplicate-id-and-mode');
});

test('exact former config migrates both capabilities while sparse explicit disable survives',()=>{
  const former=copy(source);
  for(const [id,previous]of Object.entries(source.catalog.item_capability_admission.previous_definitions)){
    Object.assign(former.definitions[id],copy(previous));delete former.definitions[id].equipment_passive;}
  delete former.catalog.item_capability_admission;
  const old=deriveItemConfiguration(former);old.entries[127].parameters.drop_rate=71;old.entries[170].parameters.drop_rate=72;
  const next=upgradeItemConfiguration(source,old);assert.equal(next.entries[127].parameters.enabled,true);assert.equal(next.entries[170].parameters.enabled,true);
  assert.equal(next.entries[127].parameters.drop_rate,71);assert.equal(next.entries[170].parameters.drop_rate,72);
  const sparse=copy(overrides);sparse.entries[170].parameters={enabled:false};
  assert.equal(compileItemConfiguration(source,upgradeItemConfiguration(source,sparse),'debug').data.definitions[170].runtime_enabled,false);
});

test('historical chapter equipment keeps numeric projection without executing an unadmitted passive',async()=>{
  const world=await rewardedWorld(),runner=new ChapterRunner({world,data:story,content,say:async()=>{}});
  world.transact(draft=>{runner.joinActor({actorSlot:1,modeRaw:0,draft});draft.inventory.push(instance(51));});
  const before=createPartyActors(world.snapshot(),attributes,{},items).find(row=>row.id==='002');
  changeEquipment(world,attributes,items,{roleId:'002',slotId:'head',instanceId:'passive-fixture-51'});
  const after=createPartyActors(world.snapshot(),attributes,{},items).find(row=>row.id==='002');
  const raw=Buffer.from(items.definitions[51].raw_hex,'hex');assert.equal(raw[0x2a9],1);assert.equal(raw[0x2b3],6);assert.equal(raw.readInt32LE(0x2aa),0);
  assert.equal(before.equipment.item_sums_by_offset['0x45'],10,'native initial weapon defense percent');
  assert.equal(after.linked_by_address['0x04f9909c']-before.linked_by_address['0x04f9909c'],11);
  assert.equal(after.linked_by_address['0x04f990e0']-before.linked_by_address['0x04f990e0'],50);
  assert.deepEqual(after.equipment_passives,[]);
  assert.deepEqual(initializeNativeStatuses(after,statusData,undefined,draws([])).native_status_slots,Array.from({length:100},()=>({raw_hex:ZERO})));
  // New unsupported equipment remains blocked; an existing numeric contract
  // cannot authorize arbitrary source-only special effects or a bad descriptor.
  for(const id of [118,136,141]){
    assert.throws(()=>equipmentPassiveRows([{item_id:id}],items),/被动作用尚未还原/);
    const cfg=deriveItemConfiguration(source);cfg.entries[id].parameters.enabled=true;
    assert.throws(()=>compileItemConfiguration(source,cfg,'debug'),/装备被动作用未还原/);
  }
  const changed=copy(items);changed.definitions[127].equipment_passive.effect_id_raw=6;
  assert.throws(()=>equipmentPassiveRows([{item_id:127}],changed),/被动作用尚未还原/);
});

test('current-catalog pre-socket format migrates separately from former source-only capability rows',()=>{
  const legacy=deriveItemConfiguration(source,{socketSupport:false});legacy.entries[170].parameters={drop_rate:77,enabled:false};
  const before=copy(legacy),migrated=upgradeItemConfiguration(source,legacy);
  assert.deepEqual(legacy,before);assert.equal(migrated.entries[170].parameters.enabled,false);
  assert.equal(migrated.entries[170].parameters.drop_rate,77);assert.ok(migrated.entries[170].parameters.attributes);
  const forged=copy(legacy);forged.entries[170].catalog.description='forged';
  assert.throws(()=>upgradeItemConfiguration(source,forged),/来源或基线不匹配/);
});

}
