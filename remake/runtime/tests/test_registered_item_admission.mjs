// Real source party operations/gift and normal menu equipment API. No dev gear.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {compileItemConfiguration,upgradeItemConfiguration,deriveItemConfiguration} from '../web/core/item_registry.mjs';
import {changeEquipment,canEquipItem} from '../web/core/items.mjs';
import {isSupportedCrystalDefinition} from '../web/core/crystal_catalog.mjs';
import {fireValleyPartyFixture,headlessRunner} from './helpers/fire_valley_world.mjs';
const read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
// Optional isolated official-producer output, used before the unified asset
// build. Normal test runs read only the published catalog.
const items=process.env.SEVENTH_SEAL_ITEM_TEST_CATALOG?JSON.parse(await readFile(process.env.SEVENTH_SEAL_ITEM_TEST_CATALOG,'utf8')):await read('items');
const [attributes,overrides]=await Promise.all(['party_combat','config/items'].map(read));
const {worlds}=await fireValleyPartyFixture();

test('source-owned003/004/005 initial gear can be unequipped and reequipped in original mode then survives save/load',async()=>{
  const configured=compileItemConfiguration(items,overrides,'original');assert.deepEqual(configured.differences,[]);
  for(const roleId of ['003','004','005']){
    const store=new WorldStore(worlds[roleId==='005'?'after_incoming':'before_incoming']);
    const source=attributes.initial_equipment.find(row=>row.role_id===roleId),definition=configured.data.definitions[source.item_id];
    const provenance=structuredClone(store.value.source),progress=structuredClone(store.value.party.find(row=>row.id===roleId));
    assert.equal(definition.runtime_enabled,true);assert.equal(canEquipItem(definition,roleId,definition.slot_id),true);
    changeEquipment(store,attributes,configured.data,{roleId,slotId:definition.slot_id});
    const returned=store.value.inventory.find(row=>row.id===source.item_id);assert.ok(returned);
    const expected=Buffer.from(source.source_raw_hex,'hex');expected.writeUInt32LE(1,4);
    assert.equal(returned.source_raw_hex,expected.toString('hex'));
    changeEquipment(store,attributes,configured.data,{roleId,slotId:definition.slot_id,instanceId:returned.instance_id});
    assert.equal(store.value.equipment.roles[roleId].find(row=>row.id===source.item_id).source_raw_hex,expected.toString('hex'));
    assert.deepEqual(store.value.source,provenance);assert.deepEqual(store.value.party.find(row=>row.id===roleId),progress);
    assert.deepEqual(await decodeSave(await encodeSave(store.snapshot())),store.snapshot());
  }
});

test('actual M17025 root1 gift50 can be equipped by source-allowed005 and round-tripped, with role-mask still enforced',async()=>{
  const configured=compileItemConfiguration(items,overrides,'original').data,store=new WorldStore(worlds.after_incoming),headless=headlessRunner(store);
  const result=await headless.runner.runTlk({mapId:'M17025',recordId:1,context:{explicitInteraction:true,steps:0}});
  assert.deepEqual(result.traversed,[1,2,3,4]);const reward=store.value.inventory.find(row=>row.id===50);assert.ok(reward);
  const raw=reward.source_raw_hex;assert.equal(configured.definitions['50'].runtime_enabled,true);
  assert.equal(canEquipItem(configured.definitions['50'],'001','head'),false);
  assert.equal(canEquipItem(configured.definitions['50'],'005','head'),true);
  changeEquipment(store,attributes,configured,{roleId:'005',slotId:'head',instanceId:reward.instance_id});
  assert.equal(store.value.equipment.roles['005'].find(row=>row.id===50).source_raw_hex,raw);
  assert.deepEqual(await decodeSave(await encodeSave(store.snapshot())),store.snapshot());
});

test('explicit disabled overrides and source-only/out-of-region rows retain their admission gates',()=>{
  const override=structuredClone(overrides);override.entries['39'].parameters.enabled=false;
  const configured=compileItemConfiguration(items,override,'debug').data,store=new WorldStore(worlds.before_incoming);
  assert.equal(configured.definitions['39'].runtime_enabled,false);
  changeEquipment(store,attributes,configured,{roleId:'003',slotId:'weapon'});
  const returned=store.value.inventory.find(row=>row.id===39),before=store.snapshot();
  assert.throws(()=>changeEquipment(store,attributes,configured,{roleId:'003',slotId:'weapon',instanceId:returned.instance_id}),/不能装备/);
  assert.deepEqual(store.snapshot(),before);
  for(const id of [99,257,347])assert.equal(compileItemConfiguration(items,overrides,'original').data.definitions[id].runtime_enabled,false,String(id));
  const sparse=structuredClone(overrides);sparse.entries['50'].parameters={enabled:false,drop_rate:73};
  const upgraded=upgradeItemConfiguration(items,sparse);assert.equal(upgraded.entries['50'].parameters.enabled,false);
  assert.equal(upgraded.entries['50'].parameters.drop_rate,73);
});

test('all actual Fire Valley mutation5 grants have a recovered enabled equipment, medicine or crystal capability',async()=>{
  const [story,index]=await Promise.all(['chapter_story','library/fire_valley'].map(read)),configured=compileItemConfiguration(items,overrides,'original').data;
  const records=Object.entries(index.maps).flatMap(([mapId,map])=>{
    if(map.dialogue.status==='source-file-absent'){assert.deepEqual(map.dialogue.records,[]);assert.equal(story.maps[mapId],undefined);return [];}
    assert.ok(story.maps[mapId],`${mapId} source TLK must be registered`);return story.maps[mapId].records;
  });
  const ids=[...new Set(records.filter(row=>row.mutation_type===5&&row.mutation_index===0).map(row=>row.mutation_bit))].sort((a,b)=>a-b);
  assert.deepEqual(ids,[4,8,12,50,51,61,150,156,272]);
  for(const id of ids){
    const row=configured.definitions[id];assert.equal(row.runtime_enabled,true,String(id));
    assert.ok(row.behavior.kind==='equip'||row.effect&&row.use_in_battle!==false||isSupportedCrystalDefinition(row),`missing grant capability ${id}`);
  }
  assert.equal(configured.definitions[272].use_in_field,false);assert.equal(configured.definitions[272].use_in_battle,true);
});

test('recovered status-cure migrates exact old source-only v2 rows but preserves sparse disabled and numeric edits',()=>{
  const former=structuredClone(items),previous=former.catalog.item_capability_admission.previous_definitions;
  for(const [id,row]of Object.entries(previous)){
    Object.assign(former.definitions[id],structuredClone(row));delete former.definitions[id].equipment_passive;
  }
  delete former.catalog.item_capability_admission;
  const old=deriveItemConfiguration(former);old.entries['272'].parameters.drop_rate=73;
  const next=upgradeItemConfiguration(items,old);assert.equal(next.entries['272'].parameters.enabled,true);assert.equal(next.entries['272'].parameters.drop_rate,73);
  assert.equal(next.entries['272'].parameters.use_in_field,false);
  const sparse=structuredClone(overrides);sparse.entries['272'].parameters={enabled:false,drop_rate:73};
  const disabled=compileItemConfiguration(items,upgradeItemConfiguration(items,sparse),'debug').data;
  assert.equal(disabled.definitions[272].runtime_enabled,false);assert.equal(disabled.definitions[272].drop_rate,73);
  const bad=deriveItemConfiguration(items);bad.entries['272'].parameters.use_in_field=true;
  assert.throws(()=>compileItemConfiguration(items,bad,'debug'),/仅支持战斗/);
});

test('new admitted equipment defaults preserve non-default numeric edits through configuration upgrade',()=>{
  const baseline=deriveItemConfiguration(items),edited=structuredClone(baseline);
  edited.entries['40'].parameters.drop_rate=71;
  edited.entries['41'].parameters.attributes.attack_flat={minimum:123,maximum_exclusive:123};
  const next=upgradeItemConfiguration(items,edited);assert.equal(next.entries['40'].parameters.drop_rate,71);
  assert.deepEqual(next.entries['41'].parameters.attributes.attack_flat,{minimum:123,maximum_exclusive:123});
  assert.equal(next.entries['40'].parameters.enabled,true);assert.equal(next.entries['41'].parameters.enabled,true);
});

test('exact former full equipment baseline migrates recovered defaults, retains numeric edits and rejects readonly drift',()=>{
  const former=structuredClone(items),admission=former.catalog.equipment_admission;
  assert.deepEqual(admission.promoted_item_ids,[39,40,41,42,50]);
  for(const [id,availability]of Object.entries(admission.previous_availability))former.definitions[id].availability=structuredClone(availability);
  delete former.catalog.equipment_admission;
  const old=deriveItemConfiguration(former);assert.equal(old.entries['39'].original.enabled,false);
  old.entries['40'].parameters.drop_rate=71;
  old.entries['41'].parameters.attributes.attack_flat={minimum:123,maximum_exclusive:123};
  const next=upgradeItemConfiguration(items,old);
  assert.equal(next.entries['40'].parameters.enabled,true);assert.equal(next.entries['40'].parameters.drop_rate,71);
  assert.deepEqual(next.entries['41'].parameters.attributes.attack_flat,{minimum:123,maximum_exclusive:123});
  const bad=structuredClone(old);bad.entries['39'].catalog.availability.reasons.push('forged');
  assert.throws(()=>upgradeItemConfiguration(items,bad),/旧装备来源或基线不匹配/);
});
