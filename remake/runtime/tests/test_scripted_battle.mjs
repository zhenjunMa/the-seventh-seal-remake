import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {scriptedBattleSource,nativeScriptedBattle,beginScriptedBattle,commitScriptedBattle} from '../web/core/scripted_battle.mjs';
import {ChapterRunner} from '../web/core/chapter.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {initialEncounterState} from '../web/core/encounters.mjs';
import {admitPartyMember} from '../web/core/party_members.mjs';
const copy=structuredClone;
const read=name=>JSON.parse(readFileSync(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const seed=read('opening_seed'),story=read('chapter_story');
const table=story.maps['M17030-2'],record=table.records.find(row=>row.id===31);
function content(){
  const result=copy(runtimeContent),role=read('library/roles').roles;
  // Source-only registration is local to these parser/transaction tests.
  assert.match(role['032'].source.sha256,/^[a-f0-9]{64}$/);
  result.roles['032']={side:'enemy',source:{path:'Fight_Role/032.CHR',sha256:role['032'].source.sha256}};
  result.stages.stage12={path:'data/stages/stage12.json',schema:'seventh-seal-battle-stage',asset_prefix:'assets/stages/stage12/'};
  return result;
}
function world(){const value=copy(seed);value.opening.status='complete';value.location={map_id:'M17030-2',x:608,y:1408,direction:2};value.encounters=initialEncounterState(value.party,0x13579bdf);return value;}
test('kind5 source retains seven literal NUL-terminated fields, ignoring garbage after each terminator',()=>{
  const source=scriptedBattleSource(record);
  assert.deepEqual(source,{stage_file:'stage12.scn',enemy_files:['032.dgp','','','','','']});
  assert.deepEqual(scriptedBattleSource({kind:5,scripted_battle:source}),source);
  const group=nativeScriptedBattle(table,record,content());
  assert.equal(group.stage,'stage12.scn');assert.deepEqual(group.members.map(row=>[row.id,row.source_slot]),[['032',0]]);
  assert.equal(group.selection_policy,'literal-TLK-six-filenames-no-STG-draw');
  const unknown=content();delete unknown.roles['032'];assert.throws(()=>nativeScriptedBattle(table,record,unknown),/敌人尚未登记/);
  const missing=content();delete missing.stages.stage12;assert.throws(()=>nativeScriptedBattle(table,record,missing),/未登记/);
  const bad=copy(record),raw=Buffer.from(bad.raw_hex,'hex');raw.fill(65,0x37,0x37+20);bad.raw_hex=raw.toString('hex');
  assert.throws(()=>scriptedBattleSource(bad),/NUL边界/);
});
test('scripted battle continues persistent CRT state, does not reset movement counters, and commits only into caller draft',async()=>{
  const draft=world(),before=copy(draft),session=beginScriptedBattle(draft);
  assert.deepEqual(draft,before);assert.equal(session.transitionKind,session.transitionRaw%7);
  session.rng();session.world.transact(next=>{next.party[0].hp.current=7;next.money=(next.money??0)+10;});
  assert.deepEqual(draft,before);
  commitScriptedBattle(draft,session,{outcome:'victory'});
  assert.equal(draft.party[0].hp.current,7);assert.equal(draft.money,(before.money??0)+10);
  assert.equal(draft.revision,before.revision);assert.equal(draft.encounters.rng_state,session.rng.state);
  assert.deepEqual(draft.encounters.counters,before.encounters.counters);assert.deepEqual(draft.encounters.remainders,before.encounters.remainders);
  assert.deepEqual(await decodeSave(await encodeSave(draft)),draft);
});
test('interruption, defeat and concurrent draft changes never merge private battle resources',()=>{
  for(const outcome of ['interrupted','defeat','aborted']){
    const draft=world(),before=copy(draft),session=beginScriptedBattle(draft);
    session.world.transact(next=>{next.party[0].hp.current=0;});
    assert.throws(()=>commitScriptedBattle(draft,session,{outcome}),/正常返回/);assert.deepEqual(draft,before);
  }
  const draft=world(),session=beginScriptedBattle(draft);draft.flags[10]=128;
  assert.throws(()=>commitScriptedBattle(draft,session,{outcome:'victory'}),/草稿已变化/);assert.equal(draft.flags[10],128);
});
test('native kind5 runs through the shared flow and the same world transaction',async()=>{
  const store=new WorldStore(world()),before=store.snapshot();
  const runner=new ChapterRunner({world:store,data:story,content:content(),say:async()=>{},battle:async({group,draft})=>{
    assert.equal(group.stage,'stage12.scn');assert.deepEqual(store.snapshot(),before);
    const session=beginScriptedBattle(draft);session.world.transact(next=>{next.party[0].hp.current=8;});
    commitScriptedBattle(draft,session,{outcome:'escaped'});return {outcome:'escaped'};
  }});
  const result=await runner.runTlk({mapId:'M17030-2',recordId:31});
  assert.deepEqual(result.traversed,[31]);assert.equal(store.value.party[0].hp.current,8);assert.equal(store.value.revision,before.revision+1);
  const snapshot=store.snapshot();runner.battle=async({draft})=>{draft.flags[10]=0xffffffff;throw new Error('media preparation failed');};
  await assert.rejects(runner.runTlk({mapId:'M17030-2',recordId:31}),/media preparation failed/);assert.deepEqual(store.snapshot(),snapshot);
});
test('ANM party and flag callbacks share the TLK draft and roll back all operations after failure',async()=>{
  const extended=content(),definition=seed.source.role_definitions['004'];
  extended.roles['004']={side:'player',native_slot:3,source:{path:definition.path,sha256:definition.sha256}};
  const source=readFileSync(new URL('../../../Animate/m17010-3.anm',import.meta.url));
  const commands=Array.from({length:source.readUInt32LE(2)},(_,index)=>{
    const raw=source.subarray(67+74*index,67+74*(index+1));return {opcode:raw[0],actorSlot:raw.readUInt32LE(5),modeRaw:raw[29]};
  }).slice(0,5);
  const initial=world();initial.location.map_id='M17010';admitPartyMember(initial,'004',{content:extended});
  const store=new WorldStore(initial),before=store.snapshot();let fail=true;
  const runner=new ChapterRunner({world:store,data:story,content:extended,say:async()=>{},animate:async({joinActor,leaveActor,flagCommand,draft,runTlk})=>{
    for(const command of commands){if(command.opcode===36)joinActor(command);if(command.opcode===37)leaveActor(command);}
    const result=flagCommand({command:{opcode:20,u32_plus5:23,u32_plus25:1,byte_plus29:2,u32_plus13:12,u32_plus17:9},mapId:'M17010'});
    assert.equal(result.nextIndex,8);await runTlk({mapId:'M17010',recordId:38});
    assert.equal(draft.flags[10]&2,2);assert.deepEqual(store.snapshot(),before);
    if(fail)throw new Error('late media failed');
  }});
  await assert.rejects(runner.runTlk({mapId:'M17010',recordId:50}),/late media failed/);assert.deepEqual(store.snapshot(),before);
  fail=false;await runner.runTlk({mapId:'M17010',recordId:50});
  assert.deepEqual(store.value.party.map(role=>role.id),['001','005']);assert.equal(store.value.reserve_party[0].role.id,'004');
  assert.equal(store.value.flags[10]&2,2);assert.equal(store.value.revision,before.revision+1);
});
