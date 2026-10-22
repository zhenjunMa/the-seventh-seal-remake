import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {partyFormationSlots,validateFormationSlots,exchangeFormationSlots,admitFormationMember} from '../web/core/party_formation.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {createPartyActors} from '../web/core/party_attributes.mjs';
import {ChapterRunner} from '../web/core/chapter.mjs';
const world=JSON.parse(JSON.parse(readFileSync(new URL('../evidence/chapter_systems_home_save.json',import.meta.url),'utf8')).payload);

test('legacy new-game formation replays initializer and first-empty admission, independent of leader and roster order',()=>{
  const before=JSON.stringify(world);assert.deepEqual(partyFormationSlots(world),['001','002',null,null]);assert.equal(JSON.stringify(world),before);
  const reordered={...world,leader_id:'002',party:[...world.party].reverse()};assert.deepEqual(partyFormationSlots(reordered),['001','002',null,null]);
});

test('native four-slot exchange permits empty destinations without changing roles, actor resources or leader',()=>{
  const before=JSON.stringify(world),slots=partyFormationSlots(world),next=exchangeFormationSlots(slots,world.party,0,3);assert.deepEqual(next,[null,'002',null,'001']);assert.deepEqual(slots,['001','002',null,null]);assert.equal(JSON.stringify(world),before);
  assert.deepEqual(partyFormationSlots({...world,formation_slots:next}),next);assert.deepEqual(exchangeFormationSlots(next,world.party,1,1),next);
});

test('new admission takes first empty slot and duplicate admission is a no-op',()=>{
  assert.deepEqual(admitFormationMember([null,null,null,'001'],world.party,'002'),['002',null,null,'001']);assert.deepEqual(admitFormationMember(['001','002',null,null],world.party,'002'),['001','002',null,null]);
  assert.throws(()=>validateFormationSlots(['001','001',null,null],world.party),/重复/);assert.throws(()=>validateFormationSlots(['001',null,null,null],world.party),/缺少/);assert.throws(()=>exchangeFormationSlots(['001','002',null,null],world.party,0,4),/位置/);
});

test('formation survives the real world save boundary and actor reconstruction without modifying original CHR or resources',async()=>{
  const store=new WorldStore(world),before=store.snapshot(),attributes=JSON.parse(readFileSync(new URL('../web/data/party_combat.json',import.meta.url),'utf8'));
  store.transact(draft=>{draft.formation_slots=exchangeFormationSlots(partyFormationSlots(draft),draft.party,0,3);});
  const restored=await decodeSave(await encodeSave(store.snapshot()));
  assert.deepEqual(restored.formation_slots,[null,'002',null,'001']);
  const items=JSON.parse(readFileSync(new URL('../web/data/items.json',import.meta.url),'utf8'));
  assert.deepEqual(createPartyActors(restored,attributes,{},items).map(actor=>[actor.id,actor.party_slot_zero_based]),[['001',3],['002',1]]);
  for(const key of Object.keys(before))if(key!=='revision')assert.deepEqual(restored[key],before[key],key);
});

test('Kai admission fills the first empty formation position after a saved queue edit',()=>{
  const seed=JSON.parse(readFileSync(new URL('../web/data/opening_seed.json',import.meta.url),'utf8')),story=JSON.parse(readFileSync(new URL('../web/data/chapter_story.json',import.meta.url),'utf8'));
  const store=new WorldStore(seed),runner=new ChapterRunner({world:store,data:story,say:async()=>{}}),draft=store.snapshot();
  draft.formation_slots=[null,null,null,'001'];runner.joinActor({actorSlot:1,modeRaw:0,draft});
  assert.deepEqual(draft.formation_slots,['002',null,null,'001']);assert.equal(draft.leader_id,seed.leader_id);
  assert.deepEqual(draft.party[0],seed.party[0]);
});
