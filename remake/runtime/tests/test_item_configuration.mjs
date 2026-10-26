import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto,createHash} from 'node:crypto';
import {deriveItemConfiguration,compileItemConfiguration,upgradeItemConfiguration} from '../web/core/item_registry.mjs';
import {expandParameterOverrides} from '../web/core/config_overrides.mjs';
import {ChapterRunner,chapterRoleFromDefinition} from '../web/core/chapter.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {createPartyActors} from '../web/core/party_attributes.mjs';
import {useWorldItem,changeEquipment,usableItems,restoreActorWithItem,canEquipItem} from '../web/core/items.mjs';
import {validateItemInstance,ITEM_VALUE_PAIRS,withItemQuantity} from '../web/core/equipment.mjs';
import {isSupportedCrystalDefinition,insertCrystal,removeCrystal} from '../web/core/crystal_sockets.mjs';
globalThis.crypto??=webcrypto;
const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
const data=await read('items'),attributes=await read('party_combat'),overrides=await read('config/items'),config=expandParameterOverrides(deriveItemConfiguration(data),overrides),copy=structuredClone;

test('The complete indexed catalog reconstructs the immutable 416-record source and covers every unified parameter entry',()=>{
  const ids=Array.from({length:416},(_,i)=>i+1),records=ids.map(id=>Buffer.from(data.definitions[id].raw_hex,'hex'));
  assert.deepEqual(data.indexes.ids,ids);
  assert.deepEqual(Object.keys(overrides.entries),ids.map(String));
  const source=Buffer.concat([Buffer.from(data.catalog.header_raw_hex,'hex'),...records]);
  assert.equal(source.length,400508);assert.equal(source.readUInt32LE(0x20),416);
  assert.equal(createHash('sha256').update(source).digest('hex'),'9d38c8cda16a06549cb3d09547b7b69b6d9fec4ee03926aef862b8da25d078b8');
  for(const id of ids){
    const def=data.definitions[id],raw=records[id-1];
    assert.equal(raw.length,959);assert.equal(raw.readUInt32LE(0),id);
    assert.equal(def.source.record_index,id-1);assert.equal(def.source.record_offset,0x61c+(id-1)*959);
    assert.equal(def.source.definition_file_offset,def.source.record_offset);
    assert.equal(def.source.record_sha256,createHash('sha256').update(raw).digest('hex'));
    assert.equal(def.type_raw_24,raw[0x24]);assert.equal(def.subtype_raw_25,raw[0x25]);
    assert.equal(def.allowed_role_mask_raw_13e,raw.readUInt32LE(0x13e));
    assert.equal(def.drop_rate,raw.readInt32LE(0x158));assert.equal(def.unique_raw,raw[0x14b]);
    assert.equal(def.raw_fields.special_effect_block.raw_hex,raw.subarray(0x2a8).toString('hex'));
    assert.equal(def.value_ranges.length,32);
    for(const [instanceOffset,definitionOffset]of ITEM_VALUE_PAIRS){
      const range=def.value_ranges.find(r=>r.instance_offset===instanceOffset);
      assert.equal(range.definition_offset,definitionOffset);
      assert.equal(range.minimum,raw.readInt32LE(definitionOffset));assert.equal(range.maximum,raw.readInt32LE(definitionOffset+4));
    }
  }
});

test('Exact source indexes preserve duplicate names, internal rows, placeholders and raw classification without enabling them',()=>{
  const definitions=Object.values(data.definitions),check=(name,keyOf)=>{
    const keys=[...new Set(definitions.map(keyOf).filter(key=>key!==null))];
    assert.deepEqual(Object.keys(data.indexes[name]).sort(),keys.sort());
    for(const key of keys)assert.deepEqual(data.indexes[name][key],definitions.filter(r=>keyOf(r)===key).map(r=>r.id));
  };
  check('by_name',r=>r.name);check('by_category',r=>r.category);check('by_record_status',r=>r.record_status);
  check('by_type_subtype',r=>`${r.type_raw_24}:${r.subtype_raw_25}`);check('by_slot',r=>r.slot_id??null);
  check('by_role_mask',r=>String(r.allowed_role_mask_raw_13e));
  assert.deepEqual(data.indexes.by_name['\u6d77\u7687\u5370'],[125,393]);
  assert.deepEqual(data.catalog.duplicate_names,{'\u6d77\u7687\u5370':[125,393]});
  assert.equal(data.definitions[125].category,'equipment');assert.equal(data.definitions[393].category,'item');
  assert.deepEqual(data.indexes.by_record_status.placeholder,[6,75,76,232,233,234,235]);
  assert.equal(data.indexes.by_record_status['internal-source'].length,20);
  assert.deepEqual(data.catalog.classification_counts,{weapon:18,equipment:108,crystal:66,item:135,material:68,unknown:1,internal:20});
  for(const id of [...data.indexes.by_record_status.placeholder,...data.indexes.by_record_status['internal-source']]){
    assert.equal(config.entries[id].parameters.enabled,false);
    assert.equal(data.definitions[id].behavior.kind,'source-only');
  }
});

test('Role lookup uses every raw mask bit and retains ascending native IDs independently of runtime support',()=>{
  const expectedRoleIds=[];
  for(let bit=0;bit<32;bit++){
    const ids=Object.values(data.definitions).filter(r=>(r.allowed_role_mask_raw_13e&2**bit)!==0).map(r=>r.id);
    if(!ids.length)continue;
    const roleId=String(bit+1).padStart(3,'0');expectedRoleIds.push(roleId);
    assert.deepEqual(data.indexes.by_allowed_role[roleId],ids);
  }
  assert.deepEqual(Object.keys(data.indexes.by_allowed_role).sort(),expectedRoleIds.sort());
});

async function fixture(){
  const seed=await read('opening_seed');seed.opening.status='complete';seed.location={map_id:'M17026',x:400,y:320,direction:0};
  seed.party.push(chapterRoleFromDefinition(seed.source.role_definitions['002']));seed.flags[51]|=1;
  const world=new WorldStore(seed,['M17026','M72061','M70010']);
  const runner=new ChapterRunner({world,data:await read('chapter_story'),objectData:(await read('chapter_map_resources')).interactive_objects,say:async()=>{},animate:async()=>{},objectAnimation:async()=>{}});
  await runner.runObject({mapId:'M17026',objectIndex:9});await runner.runTlk({mapId:'M17026',recordId:14});return world;
}

test('All 416 source items share one configuration, including unimplemented crystals and anomalous records',()=>{
  const before=copy(data),cfgBefore=copy(config),compiled=compileItemConfiguration(data,config,'original');
  assert.deepEqual(compileItemConfiguration(data,overrides,'original'),compiled);
  const sparse=copy(overrides);sparse.entries['4'].parameters={attributes:{speed_flat:{minimum:40,maximum_exclusive:40}}};
  assert.equal(compileItemConfiguration(data,sparse,'debug').data.definitions['4'].runtime_attributes.speed_flat.minimum,40);
  const badSource=copy(overrides);badSource.source_hashes['SYSTEM/Object.ITM']='0'.repeat(64);assert.throws(()=>compileItemConfiguration(data,badSource,'original'),/来源指纹/);
  assert.equal(Object.keys(config.entries).length,416);assert.deepEqual(data,before);assert.deepEqual(config,cfgBefore);
  for(const [id,def]of Object.entries(data.definitions)){
    assert.equal(config.entries[id].owner.item_id,def.id);assert.equal(compiled.data.definitions[id].raw_hex,def.raw_hex);
    assert.equal(config.entries[id].catalog.value_ranges.length,32);
  }
  assert.equal(config.entries['36'].catalog.validation.all_value_ranges_ordered,false);
  assert.equal(config.entries['240'].catalog.behavior.kind,'source-only');
  const cfg=copy(config);cfg.entries['240'].parameters.enabled=true;
  assert.throws(()=>compileItemConfiguration(data,cfg,'debug'),/作用未还原/);
  cfg.entries['240'].parameters.enabled=false;cfg.entries['240'].parameters.effect={restore_mp_flat:500};
  assert.throws(()=>compileItemConfiguration(data,cfg,'debug'),/字段缺失或未知/);
});

test('Saved equipment rolls obey native exclusive bounds and inverted ranges retain their assigned minimum',()=>{
  const instance=id=>{
    const def=data.definitions[id],source=new DataView(Uint8Array.from(def.raw_hex.match(/../g),h=>parseInt(h,16)).buffer);
    const bytes=new Uint8Array(229),view=new DataView(bytes.buffer);
    view.setUint32(0,def.id,true);view.setUint32(4,1,true);bytes[9]=source.getUint8(0x176);
    for(const [at,from]of ITEM_VALUE_PAIRS)view.setInt32(at,source.getInt32(from,true),true);
    return {def,bytes,view,item:()=>({id:def.id,name:def.name,quantity:1,source_raw_hex:Array.from(bytes,n=>n.toString(16).padStart(2,'0')).join('')})};
  };
  const variable=instance('31'),range=variable.def.value_ranges.find(r=>r.minimum<r.maximum);
  assert.ok(range);variable.view.setInt32(range.instance_offset,range.maximum-1,true);
  assert.doesNotThrow(()=>validateItemInstance(variable.item(),variable.def));
  variable.view.setInt32(range.instance_offset,range.maximum,true);
  assert.throws(()=>validateItemInstance(variable.item(),variable.def),/原定义范围/);
  const inverted=instance('36'),bad=inverted.def.value_ranges.find(r=>r.minimum>r.maximum);
  assert.ok(bad);assert.doesNotThrow(()=>validateItemInstance(inverted.item(),inverted.def));
  inverted.view.setInt32(bad.instance_offset,bad.maximum,true);
  assert.throws(()=>validateItemInstance(inverted.item(),inverted.def),/原定义范围/);
});

test('Equipment tuning changes linked getters and role restrictions without changing source rolls or save bytes',async()=>{
  const world=await fixture(),ring=world.value.inventory.find(r=>r.id===4),cfg=copy(config);
  cfg.entries['4'].parameters.attributes.speed_flat={minimum:40,maximum_exclusive:40};
  const compiled=compileItemConfiguration(data,cfg,'debug').data,before=createPartyActors(world.snapshot(),attributes,{},data)[0];
  changeEquipment(world,attributes,compiled,{roleId:'001',slotId:'ring',instanceId:ring.instance_id});
  const native=createPartyActors(world.snapshot(),attributes,{},data)[0],tuned=createPartyActors(world.snapshot(),attributes,{},compiled)[0];
  assert.equal(native.linked_by_address['0x04f990a4']-before.linked_by_address['0x04f990a4'],21);
  assert.equal(tuned.linked_by_address['0x04f990a4']-before.linked_by_address['0x04f990a4'],42);
  const saved=world.snapshot(),loaded=await decodeSave(await encodeSave(saved),world.mapIds);
  assert.deepEqual(loaded,saved);assert.deepEqual(createPartyActors(loaded,attributes,{},compiled),createPartyActors(saved,attributes,{},compiled));
  assert.equal(world.value.equipment.roles['001'].find(r=>r.id===4).source_raw_hex.slice(0x29*2,0x2d*2),ring.source_raw_hex.slice(0x29*2,0x2d*2));
  cfg.entries['51'].parameters.allowed_role_mask=3;const roles=compileItemConfiguration(data,cfg,'debug').data;
  assert.equal(canEquipItem(data.definitions['51'],'001','head'),false);
  assert.equal(canEquipItem(roles.definitions['51'],'001','head'),true);
  assert.equal(canEquipItem(roles.definitions['51'],'002','head'),true);
});

test('Field and battle medicine use the same configured effect and honor separate scope gates and isolated snapshots',async()=>{
  const world=await fixture(),tea=world.value.inventory.find(r=>r.id===12),cfg=copy(config);
  cfg.entries['12'].parameters.effect.restore_mp_flat=7;
  const active=compileItemConfiguration(data,cfg,'debug').data;
  cfg.entries['12'].parameters.effect.restore_mp_flat=30;
  const result=useWorldItem(world,attributes,active,{instanceId:tea.instance_id,targetId:'002'});
  assert.equal(result.actor.raw_mp,7);assert.equal(world.value.inventory.find(r=>r.id===12).quantity,4);
  const battleResult=restoreActorWithItem(result.actor,world.value.inventory.find(r=>r.id===12),active);
  assert.equal(battleResult.actor.raw_mp,14);assert.equal(active.definitions['12'].effect.restore_mp_flat,7);
  cfg.entries['12'].parameters.use_in_field=false;
  const limited=compileItemConfiguration(data,cfg,'debug').data,before=world.snapshot();
  assert.equal(usableItems(world.value.inventory,limited,'field').some(r=>r.id===12),false);
  assert.equal(usableItems(world.value.inventory,limited,'battle').some(r=>r.id===12),true);
  assert.throws(()=>useWorldItem(world,attributes,limited,{instanceId:tea.instance_id,targetId:'002'}),/配置禁用/);
  assert.deepEqual(world.snapshot(),before);
});

test('Strict validation rejects source drift, invalid limits, unsupported behavior and original-mode edits',()=>{
  const mutations=[c=>c.entries['51'].owner.item_id=61,c=>c.entries['51'].catalog.slot_id='ring',
    c=>c.entries['12'].parameters.effect.revive=true,c=>c.entries['4'].parameters.attributes.speed_flat.minimum=41,
    c=>c.entries['4'].parameters.allowed_role_mask=256,c=>c.entries['4'].parameters.enabled=1];
  for(const mutate of mutations){const cfg=copy(config);mutate(cfg);assert.throws(()=>compileItemConfiguration(data,cfg,'debug'),/道具配置/);}
  const cfg=copy(config);cfg.entries['12'].parameters.effect.restore_mp_flat=7;
  assert.throws(()=>compileItemConfiguration(data,cfg,'original'),/原版模式/);
});

test('Legacy six-drop migration retains existing probability edits and v2 re-export is stable',()=>{
  const entries=Object.fromEntries(['240','241','242','331','348','358'].map(id=>{
    const def=data.definitions[id];return [id,{name:def.name,source:{path:def.source.path,sha256:def.source.sha256,definition_file_offset:def.source.definition_file_offset},original:{drop_rate:def.drop_rate},parameters:{drop_rate:def.drop_rate}}];
  }));entries['242'].parameters.drop_rate=100;
  const migrated=upgradeItemConfiguration(data,{schema:config.schema,version:1,notes:'legacy',entries});
  assert.equal(Object.keys(migrated.entries).length,416);assert.equal(migrated.entries['242'].parameters.drop_rate,100);
  assert.deepEqual(upgradeItemConfiguration(data,migrated),migrated);
  assert.deepEqual(deriveItemConfiguration(data),config);
});
test('pre-socket v2 migration enables only source-confirmed plain crystals and preserves other parameter edits',()=>{
  const legacy=deriveItemConfiguration(data,{socketSupport:false});legacy.entries['156'].parameters.drop_rate=77;legacy.entries['4'].parameters.attributes.speed_flat={minimum:40,maximum_exclusive:40};
  const before=copy(legacy),next=upgradeItemConfiguration(data,legacy);
  assert.deepEqual(legacy,before);assert.equal(next.entries['156'].parameters.enabled,true);assert.equal(next.entries['156'].parameters.drop_rate,77);
  assert.deepEqual(next.entries['4'].parameters.attributes.speed_flat,{minimum:40,maximum_exclusive:40});
  assert.equal(Object.values(data.definitions).filter(row=>!row.equipment_passive&&isSupportedCrystalDefinition(row)).length,21);
  assert.equal(legacy.entries['170'].catalog.behavior.kind,'status-immunity-crystal');
  assert.equal(next.entries['170'].parameters.enabled,true);assert.ok(next.entries['170'].parameters.attributes);
  for(const [id,definition]of Object.entries(data.definitions))if(definition.category==='crystal'&&!isSupportedCrystalDefinition(definition))assert.equal(next.entries[id].parameters.enabled,false);
  assert.deepEqual(upgradeItemConfiguration(data,next),next);const forged=copy(legacy);forged.entries['156'].catalog.description='changed';assert.throws(()=>upgradeItemConfiguration(data,forged),/来源/);
});
test('crystal attributes use unified parameters while retaining installed raw bytes and allowing disabled crystals to be removed',async()=>{
  const world=await fixture(),cfg=copy(config),definition=data.definitions['156'],ruby=withItemQuantity({instance_id:'tuning-ruby',id:156,name:definition.name,source_raw_hex:definition.initialized_raw_hex},3);
  world.transact(draft=>draft.inventory.push(ruby));cfg.entries['156'].parameters.attributes.element_0={minimum:75,maximum_exclusive:75};
  const active=compileItemConfiguration(data,cfg,'debug').data,before=createPartyActors(world.snapshot(),attributes,{},active)[0],storedParty=world.snapshot().party;
  insertCrystal({worldStore:world,attributes,itemData:active,roleId:'001',socketIndex:1,instanceId:ruby.instance_id});
  const saved=world.snapshot(),after=createPartyActors(saved,attributes,{},active)[0];assert.equal(after.linked_by_address['0x04f990e0']-before.linked_by_address['0x04f990e0'],75);
  assert.equal(saved.crystal_sockets.roles['001'][0].source_raw_hex,ruby.source_raw_hex);assert.deepEqual(saved.party,storedParty);
  cfg.entries['156'].parameters.enabled=false;const disabled=compileItemConfiguration(data,cfg,'debug').data;assert.equal(createPartyActors(saved,attributes,{},disabled)[0].linked_by_address['0x04f990e0'],after.linked_by_address['0x04f990e0']);
  removeCrystal({worldStore:world,attributes,itemData:disabled,roleId:'001',socketIndex:1});assert.equal(world.value.inventory.find(row=>row.id===156).quantity,3);assert.equal(world.value.crystal_sockets.roles['001'][0],null);
});
