// Original M17027 gift and native scheduler/item contacts. Playback is an
// explicit callback boundary; source item effect pixels are independently
// tested by test_item_presentation_export.py and the real BattleView test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {WorldStore} from '../web/core/world.mjs';
import {ChapterRunner} from '../web/core/chapter.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {BattleMenuView} from '../web/battle_menu_view.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {assembleForestSample} from '../web/forest_sample.mjs';
import {createNativeRng,resolveAction,applyNativeDamage} from '../web/core/combat_rules.mjs';
import {partyResourcesForWorld,consumePartyMp} from '../web/core/party_attributes.mjs';
import {compileItemConfiguration,upgradeItemConfiguration} from '../web/core/item_registry.mjs';
const json=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8')),copy=structuredClone,ZERO='00'.repeat(0xc6);
const [seed,story,attributes,skills,forest,scheduler,ai,rewards,reactions,statusData,published,overrides]=await Promise.all([
  'opening_seed','chapter_story','party_combat','party_skills','forest_combat','battle_scheduler','forest_ai','party_rewards','party_reactions','forest_status','items','config/items'].map(json));
const source=process.env.SEVENTH_SEAL_ITEM_TEST_CATALOG?JSON.parse(await readFile(process.env.SEVENTH_SEAL_ITEM_TEST_CATALOG,'utf8')):published;
const items=compileItemConfiguration(source,upgradeItemConfiguration(source,overrides),'original').data;
const freezeSource=await readFile(new URL('../../../Fight_Role/022.CHR',import.meta.url));
assert.equal(createHash('sha256').update(freezeSource).digest('hex'),'1d993fbcd562db44c2f515f3b9e3e1bfa4d2ad99924ad543b62ca8226b3f4455');
let offset=8+779;for(let i=0;i<19;i++)offset+=0x41d+freezeSource.readUInt32LE(offset+0x15)*0xb0;
const freeze=freezeSource.subarray(offset+0x16b,offset+0x231);assert.equal(freeze[1],5);assert.equal(freeze[0xb],0);
async function fixture(mode){
  const value=copy(seed);value.opening.status='complete';value.location={map_id:'M17027',x:400,y:320,direction:0};
  const world=new WorldStore(value),chapter=new ChapterRunner({world,data:story,say:async()=>{},choose:async()=>0});
  world.transact(draft=>chapter.joinActor({actorSlot:1,modeRaw:0,draft}));
  const result=await chapter.runTlk({mapId:'M17027',recordId:7,context:{explicitInteraction:true,steps:0}});
  assert.deepEqual(result.traversed,[7,8,9,10,11,12]);const item=world.value.inventory.find(row=>row.id===272);assert.equal(item.quantity,3);
  const sample=assembleForestSample(createPartySample(world.snapshot(),attributes,skills,null,items),forest,{map_id:'M70010',members:[{id:'013'}]},
    {...scheduler,idle_skills:{...scheduler.idle_skills,...skills.idle_skills}},ai,rewards,reactions,statusData);
  const events=[],contacts=[],rng=createNativeRng(12345);let draws=0,battle;
  const next=()=>{draws++;return rng.next();};
  battle=new BattleController({world,itemData:items,resolveAction,applyDamage:applyNativeDamage,resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,
    log:event=>events.push(event),playSequence:async()=>assert.fail('this item-contact fixture does not dispatch an ordinary attack'),playItem:async(event,{onUse})=>{
      assert.equal(event.item_id,272);const target=battle.actor('002');
      if(mode==='dies')target.state_raw=4;
      if(mode==='immune')target.immune_raw=1;
      const before=draws,first=onUse();assert.equal(draws,before,'mode1 contact draws no RNG');
      const after=copy({actor:target,inventory:battle.state.inventory});assert.deepEqual(onUse(),first);
      assert.equal(draws,before);assert.deepEqual({actor:target,inventory:battle.state.inventory},after,'repeated logical contact cannot consume or apply twice');
      contacts.push(first);
    }});
  battle.start({...sample,rng:next});
  const target=battle.actor('002');
  if(mode!=='absent'){
    target.native_status_slots[2]={raw_hex:freeze.toString('hex')};
    target.status_flags_raw=freeze.readUInt32LE(0xb8)&0x3ff;target.status_by_address['0x0521f52a']=target.status_flags_raw;
  }
  if(mode==='duplicate')target.native_status_slots[99]={raw_hex:items.definitions[272].status_cure.effect_raw_hex};
  if(mode==='display-zero'){target.raw_hp=-target.resource_bonuses.hp_current;target.raw_by_address['0x0524a701']=target.raw_hp;target.hp.current=0;}
  // Only arbitration timing is fixed: original charge/debt and item dispatch
  // still execute, while enemy combat is covered by its own complete suite.
  for(const actor of battle.state.actors)actor.charge.gauge=actor.id==='001'?battle.state.scheduler.threshold:0;
  battle.state.phase='command';battle.selectPlayer('001');
  return {world,battle,item,events,contacts,draws:()=>draws,target};
}

test('naturally awarded272 uses one native action, cures once without MP/RNG, and only successful mode1 contact consumes a unit',async()=>{
  assert.equal(items.definitions[272].behavior.kind,'status-cure');
  for(const mode of ['frozen','absent','duplicate','dies','immune','display-zero']){
    const f=await fixture(mode),before=f.world.snapshot(),resources=copy({hp:f.target.hp,mp:f.target.mp,raw_hp:f.target.raw_hp,raw_mp:f.target.raw_mp}),n=f.draws();
    const menu=Object.create(BattleMenuView.prototype);Object.assign(menu,{battle:f.battle,draft:{kind:'item',instanceId:f.item.instance_id},snapshot:f.battle.presentationSnapshot()});
    assert.ok(menu.targetActors().some(actor=>actor.id==='002'),'the native target category includes displayHP0');
    await f.battle.chooseItem(f.item.instance_id,'002');
    const used=['frozen','display-zero'].includes(mode),effect=!['dies','immune'].includes(mode);
    assert.equal(f.contacts.length,1);assert.equal(f.contacts[0].item_used,used,mode);assert.equal(f.contacts[0].item_effect,effect,mode);assert.equal(f.contacts[0].native_return,Number(used));
    assert.equal(f.battle.state.inventory.find(row=>row.id===272).quantity,used?2:3);assert.equal(f.battle.state.action_count,1);assert.equal(f.battle.state.round,2);
    assert.equal(f.battle.actor('001').charge.gauge,-f.battle.state.scheduler.threshold);assert.equal(f.draws(),n);
    assert.deepEqual({hp:f.target.hp,mp:f.target.mp,raw_hp:f.target.raw_hp,raw_mp:f.target.raw_mp},resources);
    assert.equal(f.target.native_status_slots[2].raw_hex,used||mode==='absent'?ZERO:freeze.toString('hex'));
    assert.equal(f.events.filter(event=>event.type==='battle-item-used').length,1);assert.ok(!f.events.some(event=>event.type==='battle-interrupted'));
    assert.deepEqual(f.world.snapshot(),before,'a battle action does not independently publish the world');
    f.battle.finish();assert.equal(f.world.value.inventory.find(row=>row.id===272).quantity,used?2:3);
    assert.equal(f.world.value.revision,before.revision+Number(used));
  }
});
