import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
import {ChapterRunner, validateChapterStory, chapterProgress, chapterRoleFromDefinition, chapterObjectState, initializeChapterItem, chapterRestChoices,chapterChoices} from '../web/core/chapter.mjs';
import {WorldStore, validateWorld, encodeSave, decodeSave} from '../web/core/world.mjs';

globalThis.crypto ??= webcrypto;
const read = file => JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
const story = read('../web/data/chapter_story.json');
const initial = read('../web/data/opening_seed.json');
const legacy = read('../web/data/world_seed.json');
const resources = read('../web/data/chapter_map_resources.json');
const copy = value => structuredClone(value);
function seed() {
  const world = copy(initial);
  world.opening.status = 'complete';
  world.location = {map_id:'M17029', x:596, y:532, direction:1};
  return world;
}
const store = () => new WorldStore(seed());
function runner(world, extra = {}) {
  return new ChapterRunner({world, data:story, say:async () => {}, ...extra});
}

test('Fire Valley crystal follows native use/leave choices and defers saving until commit',async()=>{
  const world=store();world.transact(draft=>{draft.location.map_id='M17010';});
  const before=world.snapshot(),record=story.maps.M17010.records.find(row=>row.id===44);
  assert.deepEqual(chapterChoices(record).map(row=>[row.text,row.recordId]),[['使用。',45],['离开。',0]]);
  const event=runner(world,{choose:async()=>{assert.deepEqual(world.snapshot(),before);return 0;}});
  const result=await event.runTlk({mapId:'M17010',recordId:44,context:{steps:0,explicitInteraction:true}});
  assert.deepEqual(result.traversed,[44,45]);assert.equal(result.save_requested,true);assert.equal(event.running,false);
  assert.equal(result.world.revision,before.revision+1);
  assert.deepEqual(result.world.party,before.party);assert.deepEqual(result.world.flags,before.flags);
  const leave=runner(world,{choose:async()=>1});
  assert.equal((await leave.runTlk({mapId:'M17010',recordId:44,context:{steps:0,explicitInteraction:true}})).save_requested,false);
});

test('crystal saves require explicit interaction and failed choices leave all progress intact',async()=>{
  const world=store(),before=world.snapshot();
  await assert.rejects(runner(world).runTlk({mapId:'M17010',recordId:45}),/存档需要主动交互入口/);
  await assert.rejects(runner(world,{choose:async()=>0}).runTlk({mapId:'M17010',recordId:44}),/主动交互入口/);
  await assert.rejects(runner(world,{choose:async()=>99}).runTlk({mapId:'M17010',recordId:44,context:{steps:0,explicitInteraction:true}}),/选择结果无效/);
  assert.deepEqual(world.snapshot(),before);
});

test('Fire Valley full TLK table stays bound to source bytes and rejects changed text', () => {
  validateChapterStory(story);
  const bad = copy(story);
  bad.maps.M17029.records[23].text_raw = 'Changed invitation';
  assert.throws(() => validateChapterStory(bad), /与原始记录不同/);
});

test('Kai invitation flag is written on the original TLK record, after a successful dialogue transaction', async () => {
  const world = store(), before = world.snapshot(), lines = [], phases = [];
  const event = runner(world, {say:async ({record,draft}) => {
    lines.push(record.id);
    assert.equal(draft.flags[51] & 1, 1);
    assert.equal(world.value.flags[51], before.flags[51]);
  },setPhase:phase => phases.push(phase)});
  const result = await event.runTlk({mapId:'M17029', recordId:24});
  assert.deepEqual(lines, [24]);
  assert.deepEqual(result.traversed, [24]);
  assert.equal(world.value.flags[51] & 1, 1);
  assert.equal(world.value.revision, before.revision + 1);
  assert.deepEqual(world.value.party, before.party);
  assert.deepEqual(phases, ['event','map']);
});

test('Failed invitation display retains every world byte and releases the event lock', async () => {
  const world = store(), before = world.snapshot();
  const event = runner(world, {say:async () => {throw new Error('Dialogue unavailable');}});
  await assert.rejects(event.runTlk({mapId:'M17029', recordId:24}), /Dialogue unavailable/);
  assert.deepEqual(world.snapshot(), before);
  assert.equal(event.running, false);
});

test('Actual王厅 flag branch skips its join animation when invitation was completed', async () => {
  const world = store();
  world.transact(draft => {draft.flags[51] |= 1;});
  let animations = 0;
  const event = runner(world, {animate:async () => {animations++;}});
  const result = await event.runTlk({mapId:'M17029', recordId:25});
  assert.deepEqual(result.traversed, [25]);
  assert.equal(animations, 0);
  assert.deepEqual(world.value.party.map(role => role.id), ['001']);
});

test('Nested original join dialogue and actor opcode commit once, repeated join preserves Kai progress', async () => {
  const world = store(), before = world.snapshot();
  world.setEncounterState({rng_state:123456,counters:{'001':73},remainders:{'001':7.5}});
  const event = runner(world, {animate:async ({mapId,program,runTlk,joinActor}) => {
    assert.equal(program.source.path.toLowerCase(), 'animate/m17029-1.anm');
    await runTlk({mapId, recordId:24});
    assert.deepEqual(await joinActor({actorSlot:1, modeRaw:0}), {id:'002',added:true});
    assert.deepEqual(await joinActor({actorSlot:1, modeRaw:0}), {id:'002',added:false});
    await runTlk({mapId, recordId:26});
  }});
  await event.runTlk({mapId:'M17029', recordId:25});
  assert.equal(world.value.revision, before.revision + 2);
  assert.deepEqual(world.value.encounters,{rng_state:123456,counters:{'001':73,'002':0},remainders:{'001':7.5,'002':0}});
  assert.deepEqual(world.value.party.map(role => role.id), ['001','002']);
  assert.equal(world.value.party[1].level, 10);
  assert.deepEqual(world.value.party[1].hp, {current:900,maximum:900});
  assert.deepEqual(world.value.party[1].mp, {current:0,maximum:40});
  assert.deepEqual(world.value.source.initial_equipment, before.source.initial_equipment);
  world.transact(draft => {draft.party[1].hp.current = 42;});
  const draft = world.snapshot();
  event.joinActor({actorSlot:1, modeRaw:0,draft});
  assert.equal(draft.party[1].hp.current, 42);
  validateWorld(draft);
});

test('Interrupted join animation cannot commit its flag or added party member', async () => {
  const world = store(), before = world.snapshot();
  const event = runner(world, {animate:async ({mapId,runTlk,joinActor}) => {
    await runTlk({mapId,recordId:24});
    await joinActor({actorSlot:1,modeRaw:0});
    throw new Error('Sprite load failed');
  }});
  await assert.rejects(event.runTlk({mapId:'M17029',recordId:25}), /Sprite load failed/);
  assert.deepEqual(world.snapshot(), before);
});

test('Concurrent event invocation and intervening world changes cannot overwrite progress', async () => {
  const world = store();
  let release;
  const event = runner(world, {say:async () => new Promise(resolve => {release=resolve;})});
  const pending = event.runTlk({mapId:'M17029',recordId:24});
  await assert.rejects(event.runTlk({mapId:'M17029',recordId:24}), /正在执行/);
  world.transact(draft => {draft.money=123;});
  release();
  await assert.rejects(pending, /执行期间发生变化/);
  assert.equal(world.value.money, 123);
  assert.equal(world.value.flags[51], 0);
});

test('Legacy v1 saves remain valid and do not synthesize a new party or opening state', async () => {
  const restored = await decodeSave(await encodeSave(legacy));
  assert.deepEqual(restored, legacy);
  assert.equal('opening' in restored, false);
  const state = chapterProgress(restored);
  assert.equal(state.kai_joined, legacy.party.some(role => role.id === '002'));
  assert.equal(state.equipment_ready, Boolean(legacy.flags[48] & 1));
  const kai = chapterRoleFromDefinition(initial.source.role_definitions['002']);
  assert.equal(kai.combat_progress.header_raw_hex, initial.source.role_definitions['002'].header_raw_hex);
});

test('Original aid unlock learns source72 for active001/002 and retains future005 once', async () => {
  const world = store();
  world.transact(draft=>{draft.party.push(chapterRoleFromDefinition(initial.source.role_definitions['002']));});
  const before=world.snapshot(),event=runner(world);
  const result=await event.runTlk({mapId:'M17010',recordId:93});
  assert.deepEqual(result.traversed,[93,94,95]);
  assert.deepEqual(world.value.party.find(role=>role.id==='001').skill_progress,{version:1,learned_indices:[36]});
  assert.deepEqual(world.value.party.find(role=>role.id==='002').skill_progress,{version:1,learned_indices:[31]});
  assert.deepEqual(world.value.native_pending_skill_unlocks,[{role_id:'005',source_skill_id:72}]);
  assert.deepEqual(world.value.flags,before.flags);assert.deepEqual(world.value.inventory,before.inventory);
  assert.deepEqual(world.value.source,before.source);
  const saved=await decodeSave(await encodeSave(world.snapshot()));
  assert.deepEqual(saved.native_pending_skill_unlocks,world.value.native_pending_skill_unlocks);
  const learned=copy(world.value.party),pending=copy(world.value.native_pending_skill_unlocks);
  await event.runTlk({mapId:'M17010',recordId:93});
  assert.deepEqual(world.value.party,learned);assert.deepEqual(world.value.native_pending_skill_unlocks,pending);
});

function home({kai = false} = {}) {
  const value = seed();
  value.location.map_id = 'M17026';
  if (kai) {
    value.flags[51] |= 1;
    value.party.push(chapterRoleFromDefinition(initial.source.role_definitions['002']));
  }
  return new WorldStore(value);
}
const chest = {mapId:'M17026', objectIndex:9};

test('Original chest prerequisite gives no equipment before inviting Kai and leaves the chest usable', async () => {
  const world = home(), lines = [];
  const event = runner(world, {objectData:resources.interactive_objects,
    say:async ({record}) => {lines.push(record.id);},
    objectAnimation:async () => {assert.fail('Unprepared chest must not open');}});
  const result = await event.runObject(chest);
  assert.deepEqual(lines, [3]);
  assert.deepEqual(result.traversed, [1,3]);
  assert.equal(result.state, 0);
  assert.equal(world.value.flags[48], 0);
  assert.deepEqual(world.value.inventory, []);
});

test('Actual chest awards the two accessories, crown, and two rings, then saves native object state3', async () => {
  const world = home({kai:true}), before = world.snapshot();
  const event = runner(world, {objectData:resources.interactive_objects,
    objectAnimation:async ({draft,fromState,toState}) => {
      assert.equal(fromState, 2); assert.equal(toState, 3);
      assert.equal(chapterObjectState(draft, chest.mapId, chest.objectIndex, story), 2);
      assert.equal(chapterObjectState(world.value, chest.mapId, chest.objectIndex, story), 0);
    }});
  const result = await event.runObject(chest);
  assert.deepEqual(result.traversed, [1,4,2,5,6,7,8]);
  assert.equal(result.state, 3);
  assert.deepEqual(world.value.inventory.map(row => [row.id,row.name,row.quantity]),
    [[61,'珍珠耳环',1],[51,'烈焰冠',1],[4,'兽骨戒指',2]]);
  assert.equal(world.value.flags[48] & 1, 1);
  assert.equal(world.value.event_records[48][9], `03${'00'.repeat(13)}`);
  assert.deepEqual(world.value.party, before.party);
  assert.deepEqual(world.value.source.initial_equipment, before.source.initial_equipment);
  const record = Buffer.from(world.value.inventory.find(row => row.id === 51).source_raw_hex, 'hex');
  assert.equal(record.readUInt32LE(0), 51);
  assert.equal(record.readUInt32LE(4), 1);
  assert.equal(record.readInt32LE(0x21), 10); // Original crown defense.
  assert.equal(record[8], 0xcc);
  assert.equal(record[0xe4], 0xcc);
  assert.equal(record[0x0c], 0);
});

test('Completed chest remains empty after save/load using object records, without a fabricated flag guard', async () => {
  const world = home({kai:true});
  await runner(world).runObject(chest);
  const saved = await decodeSave(await encodeSave(world.snapshot()));
  // The native CF3 object guard remains authoritative even if flag48 is clear.
  saved.flags[48] = 0;
  const restored = new WorldStore(saved), before = restored.snapshot();
  const result = await runner(restored, {say:async () => {assert.fail('No repeated chest dialogue');}}).runObject(chest);
  assert.equal(result.already_done, true);
  assert.deepEqual(restored.snapshot(), before);
});

test('Failed chest animation rolls back equipment, map flag, and object state before a successful retry', async () => {
  const world = home({kai:true}), before = world.snapshot();
  const event = runner(world, {objectAnimation:async () => {throw new Error('Chest atlas unavailable');}});
  await assert.rejects(event.runObject(chest), /Chest atlas unavailable/);
  assert.deepEqual(world.snapshot(), before);
  event.objectAnimation = async () => {};
  const result = await event.runObject(chest);
  assert.equal(result.state, 3);
  assert.equal(world.value.inventory.reduce((count,row) => count + row.quantity,0), 4);
});

test('Restored pending object state2 finishes without awarding inventory twice and preserves unknown event bytes', async () => {
  const world = home({kai:true});
  const retained = `02${'a1'.repeat(13)}`;
  world.transact(draft => {draft.event_records[48] = [...Array(9).fill('00'.repeat(14)),retained];});
  const result = await runner(world, {say:async () => {assert.fail('Pending object has already run TLK');}}).runObject(chest);
  assert.equal(result.state, 3);
  assert.deepEqual(world.value.inventory, []);
  assert.equal(world.value.event_records[48][9], `03${'a1'.repeat(13)}`);
});

test('Tea supply uses the original five item mutations and flag48 bit2 prevents repeated NPC gifts', async () => {
  const world = home(), lines = [];
  const event = runner(world, {say:async ({record}) => {lines.push(record.id);}});
  await event.runTlk({mapId:'M17026',recordId:14});
  assert.deepEqual(world.value.inventory.map(row => [row.id,row.quantity]), [[12,5]]);
  assert.equal(world.value.flags[48] & 2, 2);
  const tea = Buffer.from(world.value.inventory[0].source_raw_hex, 'hex');
  assert.equal(tea.readInt32LE(0x15), 50);
  assert.equal(tea.readUInt32LE(4), 5);
  const before = copy(world.value.inventory);
  lines.length = 0;
  await event.runTlk({mapId:'M17026',recordId:14});
  assert.deepEqual(lines, [22]);
  assert.deepEqual(world.value.inventory, before);
});

test('Original inventory stack ceiling remains99 and keeps raw quantity synchronized', async () => {
  const world = home(), raw = initializeChapterItem(story.item_definitions[12]);
  new DataView(raw.buffer).setUint32(4,98,true);
  world.transact(draft => {draft.inventory.push({instance_id:'tea-existing',id:12,name:'碧沙草茶',quantity:98,source_raw_hex:Buffer.from(raw).toString('hex')});});
  await runner(world).runTlk({mapId:'M17026',recordId:14});
  assert.equal(world.value.inventory.length, 1);
  assert.equal(world.value.inventory[0].quantity, 99);
  assert.equal(Buffer.from(world.value.inventory[0].source_raw_hex, 'hex').readUInt32LE(4), 99);
});

test('Chest manifest must match original DAT bytes before story state can change', async () => {
  const world = home({kai:true}), before = world.snapshot(), bad = copy(resources.interactive_objects);
  bad.M17026[0].source.offset++;
  await assert.rejects(runner(world,{objectData:bad}).runObject(chest), /清单与原始地图不一致/);
  assert.deepEqual(world.snapshot(), before);
});

test('Bed asks the two original choices and declining keeps all saved resources intact', async () => {
  const world = home({kai:true});
  world.transact(draft => {draft.party[0].hp.current = 42; draft.party[1].mp.current = 0;});
  const before = world.snapshot();
  const event = runner(world, {choose:async ({record, choices}) => {
    assert.equal(record.text_raw, '需要休息一下吗？');
    assert.deepEqual(choices.map(row => [row.index,row.text,row.recordId]), [[0,'休息。',12],[1,'不用。',0]]);
    return 1;
  },animate:async () => {assert.fail('Declining rest must not animate');}});
  const result = await event.runRest({explicitInteraction:true});
  assert.deepEqual(result.traversed, [10]);
  assert.deepEqual(world.value.party, before.party);
  assert.deepEqual(world.value.inventory, before.inventory);
  assert.deepEqual(world.value.flags, before.flags);
});

test('Confirmed rest restores raw HP/MP for the active party and commits after the source ANM completes', async () => {
  const world = home({kai:true});
  world.transact(draft => {draft.party[0].hp.current = 0xffffffa0; draft.party[0].mp.current = 0;
    draft.party[1].hp.current = 1; draft.party[1].mp.current = 2;});
  const before = world.snapshot();
  const event = runner(world, {choose:async () => 0, animate:async ({program,mapId,draft,runTlk}) => {
    assert.equal(program.id, 'm17026-1');
    assert.equal(mapId, 'M17026');
    for (const role of draft.party) {
      assert.equal(role.hp.current, role.hp.maximum);
      assert.equal(role.mp.current, role.mp.maximum);
    }
    assert.deepEqual(world.value.party, before.party);
    await runTlk({mapId, recordId:13});
  }});
  const result = await event.runRest({explicitInteraction:true});
  assert.deepEqual(result.traversed, [10,12,11]);
  assert.equal(world.value.revision, before.revision + 1);
  for (const role of world.value.party) {
    assert.equal(role.hp.current, role.hp.maximum);
    assert.equal(role.mp.current, role.mp.maximum);
    if (role.combat_progress) {
      const raw = Buffer.from(role.combat_progress.header_raw_hex, 'hex');
      assert.equal(raw.readUInt32LE(0x30), role.hp.current);
      assert.equal(raw.readUInt32LE(0x38), role.mp.current);
    }
  }
  for (const key of ['inventory','flags','event_records','location','money','source'])
    assert.deepEqual(world.value[key], before[key]);
  assert.deepEqual((await decodeSave(await encodeSave(world.snapshot()))).party, world.value.party);
});

test('Rest animation and invalid choices cannot partially replenish the saved world', async () => {
  const world = home(), before = world.snapshot();
  const event = runner(world, {choose:async () => 0, animate:async () => {throw new Error('Fade unavailable');}});
  await assert.rejects(event.runRest({explicitInteraction:true}), /Fade unavailable/);
  assert.deepEqual(world.snapshot(), before);
  assert.equal(event.running, false);
  event.choose = async () => 2;
  await assert.rejects(event.runRest({explicitInteraction:true}), /选择结果无效/);
  assert.deepEqual(world.snapshot(), before);
});

test('Rest cannot activate merely by entering a bed cell or from an unrelated map', async () => {
  const world = home(), event = runner(world, {choose:async () => 0});
  await assert.rejects(event.runRest(), /主动操作床铺/);
  await assert.rejects(event.runTlk({mapId:'M17026', recordId:10}), /主动交互入口/);
  world.transact(draft => {draft.location.map_id='M17029';});
  await assert.rejects(event.runRest({explicitInteraction:true}), /没有已恢复的休息入口/);
});

test('Rest choices reject altered native target bytes rather than silently choosing another branch', () => {
  const record = copy(story.maps.M17026.records[9]);
  const b = Buffer.from(record.raw_hex, 'hex');
  b.writeUInt32LE(14, 0x59b);
  record.raw_hex = b.toString('hex');
  assert.throws(() => chapterRestChoices(record), /原始选择不兼容/);
});
