import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPartyActors,partyResourcesForWorld,consumePartyMp} from '../web/core/party_attributes.mjs';
import {chapterRoleFromDefinition} from '../web/core/chapter.mjs';
import {buildEffectiveAttributes,createNativeRng,applyNativeDamage} from '../web/core/combat_rules.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
const load = name => JSON.parse(readFileSync(new URL(`../web/data/${name}.json`,import.meta.url)));
const data = load('party_combat'), seed = load('opening_seed');
const copy = v => structuredClone(v);
const twoParty = () => {
  const world = copy(seed);
  world.party.push(chapterRoleFromDefinition(world.source.role_definitions['002']));
  return world;
};
const modifyHeader = (world, ident, changes) => {
  const role = world.party.find(row => row.id === ident), b = Buffer.from(role.combat_progress.header_raw_hex,'hex');
  for (const [offset, value] of Object.entries(changes)) b.writeInt32LE(value,Number(offset));
  role.combat_progress.header_raw_hex = b.toString('hex');
  role.level = b.readInt32LE(0x24); role.hp.maximum = b.readUInt32LE(0x34); role.mp.maximum = b.readUInt32LE(0x3c);
  for (const [name,offset] of [['attack',0x40],['defense',0x48]]) role.attributes_stored[name] = {current:b.readInt32LE(offset),base:b.readInt32LE(offset+4)};
};
const idleFromOriginal = ident => {
  const raw = readFileSync(new URL(`../../../Fight_Role/${ident}.CHR`,import.meta.url));
  const skill = raw.subarray(8+0x30b,8+0x30b+0x41d), action = raw.subarray(8+0x30b+0x41d,8+0x30b+0x41d+0xb0);
  return {actor_id:ident,fixed_raw_hex:skill.toString('hex'),class_raw:action[0x24],action_mask_raw:action[0x78],
    source:{path:`Fight_Role/${ident}.CHR`,fixed_record_offset:8+0x30b}};
};

test('party export uses unchanged original CHR and initialized weapon bytes, without a save', () => {
  assert.equal(data.source.original_game_executed,false);
  assert.ok(Object.keys(data.source_hashes).every(path => !/\.dat$|\.sav$/i.test(path)));
  for (const [path,expected] of Object.entries(data.source_hashes)) {
    const bytes = readFileSync(new URL(`../../../${path}`,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),expected);
  }
  for (const ident of ['001','002']) {
    const actor = data.actors[ident], original = readFileSync(new URL(`../../../${actor.source.path}`,import.meta.url));
    assert.equal(actor.header_raw_hex,original.subarray(8,8+0x30b).toString('hex'));
    assert.equal(actor.side_raw,original[8+0x19]); assert.equal(actor.role_kind_raw,original[8+0x18]);
    const equipment = data.initial_equipment.find(row => row.role_id === ident);
    assert.deepEqual(equipment,seed.source.initial_equipment.find(row => row.role_id === ident));
    assert.equal(createHash('sha256').update(Buffer.from(equipment.source_raw_hex,'hex')).digest('hex'),equipment.instance_sha256);
  }
});

test('adapter follows actual joined party, owns its actors and computes effective resources', () => {
  assert.deepEqual(createPartyActors(seed,data).map(actor => actor.id),['001']);
  const world = twoParty(), before = JSON.stringify(world), actors = createPartyActors(world,data);
  assert.deepEqual(actors.map(actor => [actor.id,actor.level,actor.role_link_raw,actor.native_role_slot_zero_based]),[['001',11,1,0],['002',10,2,1]]);
  assert.deepEqual(actors.map(actor => [actor.hp,actor.mp]),[
    [{current:968,maximum:968},{current:72,maximum:72}],
    [{current:900,maximum:900},{current:0,maximum:40}],
  ]);
  assert.deepEqual(actors.map(partyResourcesForWorld),[{hp:880,mp:66},{hp:900,mp:0}]);
  assert.equal(JSON.stringify(world),before);
  actors[0].linked_by_address['0x04f99088'] = 1;
  assert.equal(data.actors['001'].linked_by_address['0x04f99088'],88);
  assert.equal(actors[1].status_by_address['0x0521f551'],0);
  assert.equal(actors[0].current_skill,undefined);
});

test('fixed native role links survive party reorder and match effective-field assembly for both actors', () => {
  const world = twoParty(); world.party.reverse();
  const selected = Object.fromEntries(['001','002'].map(id => [id,idleFromOriginal(id)]));
  const actors = createPartyActors(world,data,selected);
  // Native formation slots are independent of roster enumeration and role links.
  assert.deepEqual(actors.map(actor => [actor.id,actor.party_slot_zero_based,actor.role_link_raw]),[['002',1,2],['001',0,1]]);
  const assembly = JSON.parse(readFileSync(new URL('../evidence/turn_rules_assembly_20261011.json',import.meta.url)));
  for (const [index,actor] of actors.entries()) {
    const actual = buildEffectiveAttributes(actor,actor.current_skill,createNativeRng(10));
    const oracle = new NativeAssemblyOracle(assembly.functions,actors,createNativeRng(10));
    oracle.run(0x41c610,[index,0x20000000,0x20000004,0x20000008,0x2000000c,0]);
    assert.deepEqual([actual.attack,actual.defense,actual.term3,actual.term4],[0,4,8,12].map(n => oracle.read(0x20000000+n)));
    assert.deepEqual(actual.trace.map(row => row.raw),oracle.rng_calls);
  }
});

test('saved native growth recomputes percentage bonuses without resetting depleted resources', () => {
  const world = twoParty();
  modifyHeader(world,'001',{[0x24]:12,[0x28]:7440,[0x2c]:9520,[0x34]:960,[0x3c]:72,
    [0x40]:60,[0x44]:60,[0x48]:44,[0x4c]:44,[0x58]:51,[0x5c]:51,[0x64]:2080});
  world.party[0].hp.current = 800; world.party[0].mp.current = 20;
  const [actor] = createPartyActors(world,data);
  assert.equal(actor.level,12); assert.deepEqual(actor.hp,{current:896,maximum:1056});
  assert.deepEqual(actor.mp,{current:27,maximum:79});
  assert.equal(actor.linked_by_address['0x04f99088'],96);
  assert.equal(actor.linked_by_address['0x04f99090'],7);
  assert.equal(actor.linked_by_address['0x04f99098'],3);
  assert.equal(actor.raw_by_address['0x0524a729'],51);
  assert.deepEqual(partyResourcesForWorld(actor),{hp:800,mp:20});
});

test('both actors persist lethal HP as raw DWORD bits and remain dead after re-entry', () => {
  const world = twoParty(), actors = createPartyActors(world,data);
  for (const actor of actors) {
    const dead = applyNativeDamage(actor,{damage:actor.hp.current+1,after_settled_raw:1});
    assert.equal(dead.hp.current,0); assert.equal(dead.state_raw,4);
    const raw = partyResourcesForWorld(dead);
    world.party.find(role => role.id === actor.id).hp.current = raw.hp;
    assert.equal(raw.hp,(-actor.resource_bonuses.hp_current) >>> 0);
  }
  const restored = createPartyActors(world,data);
  assert.deepEqual(restored.map(actor => [actor.hp.current,actor.state_raw,actor.raw_hp]),[[0,4,-88],[0,4,0]]);
  world.party[1].hp.current = 100;
  assert.deepEqual(createPartyActors(world,data).map(actor => actor.state_raw),[4,0]);
});

test('zero raw resources retain initial equipment bonus and signed depleted MP', () => {
  const world = twoParty(); world.party[0].hp.current = 0; world.party[0].mp.current = (-6) >>> 0;
  const [actor] = createPartyActors(world,data);
  assert.equal(actor.hp.current,88); assert.equal(actor.state_raw,0); assert.equal(actor.mp.current,0);
  assert.deepEqual(partyResourcesForWorld(actor),{hp:0,mp:4294967290});
  world.party[0].hp.current = (-89) >>> 0;
  const [depleted]=createPartyActors(world,data);
  assert.equal(depleted.effective_hp_raw,-1);assert.equal(depleted.hp.current,0);
  assert.equal(partyResourcesForWorld(depleted).hp,(-89)>>>0);
});

test('MP submission handles either player and rejects insufficient or inconsistent resources', () => {
  const world = twoParty(); world.party[1].mp.current = 40;
  const actors = createPartyActors(world,data);
  const ingni = consumePartyMp(actors[0],72), kai = consumePartyMp(actors[1],12);
  assert.deepEqual(partyResourcesForWorld(ingni),{hp:880,mp:4294967290});
  assert.deepEqual(partyResourcesForWorld(kai),{hp:900,mp:28});
  assert.equal(actors[0].mp.current,72); assert.equal(actors[1].mp.current,40);
  assert.throws(() => consumePartyMp(kai,29),/MP不足/);
  kai.raw_mp--; assert.throws(() => partyResourcesForWorld(kai),/MP显示/);
  ingni.status_by_address['0x0521f559'] = 1;
  assert.throws(() => partyResourcesForWorld(ingni),/状态资源/);
});

test('inventory rewards do not become equipped; altered initial equipment is rejected', () => {
  const world = twoParty(), before = createPartyActors(world,data);
  world.inventory.push({id:4,quantity:2,name:'兽骨戒指',source_raw_hex:'cc'.repeat(0xe5)});
  assert.deepEqual(createPartyActors(world,data).map(actor => actor.linked_by_address),before.map(actor => actor.linked_by_address));
  world.source.initial_equipment[0].source_raw_hex = '00'.repeat(0xe5);
  assert.throws(() => createPartyActors(world,data),/换装尚未接入/);
});

test('old v1 progress fallback requires matching native initial values and never imports historical state', () => {
  const world = twoParty(); world.party.forEach(role => delete role.combat_progress);
  assert.deepEqual(createPartyActors(world,data).map(actor => actor.level),[11,10]);
  world.party[1].level++;
  assert.throws(() => createPartyActors(world,data),/缺少保存成长来源/);
  const historical = load('world_seed'); assert.throws(() => createPartyActors(historical,data),/新游戏来源/);
});

test('source or malformed growth changes fail before any persistent world mutation', () => {
  for (const change of [
    w => w.source.sha256 = '0'.repeat(64),
    w => w.source.source_hashes['Fight_Role/002.CHR'] = '0'.repeat(64),
    w => w.source.role_definitions['002'].header_raw_hex = '00'.repeat(0x30b),
    w => w.party[1].hp.maximum++,
    w => w.party[1].attributes_stored.attack.current++,
    w => modifyHeader(w,'002',{[0x60]:2}),
    w => w.party[1].id = '003',
  ]) {
    const world = twoParty(); change(world); const before = JSON.stringify(world);
    assert.throws(() => createPartyActors(world,data)); assert.equal(JSON.stringify(world),before);
  }
});

test('selected skill ownership is checked and source skills are independently copied', () => {
  const skill = idleFromOriginal('002'), actors = createPartyActors(twoParty(),data,{'002':skill});
  assert.deepEqual(actors[1].current_skill,skill);
  actors[1].current_skill.source.path = 'changed'; assert.equal(skill.source.path,'Fight_Role/002.CHR');
  assert.throws(() => createPartyActors(twoParty(),data,{'001':skill}),/不属于当前角色/);
});
