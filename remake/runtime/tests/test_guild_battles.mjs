// Actual guild/research source records through shared battle boundaries.
// These controlled contacts do not claim a natural campaign or browser draw.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WorldStore} from '../web/core/world/world.mjs';
import {admitPartyMember} from '../web/core/party/party_members.mjs';
import {nativeScriptedBattle} from '../web/core/battle/scripted_battle.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {assembleForestSample} from '../web/forest_sample.mjs';
import {BattleController} from '../web/core/battle/battle_controller.mjs';
import {BattleView} from '../web/battle_view.mjs';
import {battleActorPositions} from '../web/core/battle/battle_layout.mjs';
import {collectEnemyDefeat} from '../web/core/battle/battle_rewards.mjs';
import {applyNativeSupport,nativeSupportSkillSupported} from '../web/core/battle/battle_support.mjs';
import {clearNativeStatuses} from '../web/core/battle/battle_status.mjs';
import {compileNativeSequence,directSequence} from '../web/core/battle/skill_sequence.mjs';
import {createNativeRng,resolveAction,applyNativeDamage} from '../web/core/battle/combat_rules.mjs';
const copy=structuredClone;
const read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [seed,story,attributes,commands,forest,scheduler,ai,rewards,reactions,status,viewMeta]=await Promise.all([
  'opening_seed','chapter_story','party_combat','party_skills','forest_combat','battle_scheduler','forest_ai','party_rewards','party_reactions','forest_status','party_battle_view'].map(read));

function fixture(group){
  const initial=copy(seed);initial.opening.status='complete';
  initial.location={map_id:group.map_id,x:640,y:480,direction:0};
  for(const id of ['002','003','004'])admitPartyMember(initial,id);
  const world=new WorldStore(initial),sample=assembleForestSample(createPartySample(world.snapshot(),attributes,commands),forest,group,
    {...scheduler,idle_skills:{...scheduler.idle_skills,...commands.idle_skills}},ai,rewards,reactions,status);
  const battle=new BattleController({world,id:()=> 'guild-source-battle',now:()=>0,resolveAction,applyDamage:applyNativeDamage,
    playSequence:async(event,hooks)=>{
      const actor=battle.actor(event.actor_id),compiled=compileNativeSequence(viewMeta,actor.resource_id,event.plan);
      for(const step of compiled.steps){
        assert.equal(step.carrier_spawn,undefined,'this source fixture uses waiting carriers');
        hooks.onRecord(step);
        if(step.event)hooks.onContact({...step,contact_key:`${event.action_id}:${step.index}`});
      }
    }});
  battle.start({...sample,rng:createNativeRng(12345)});return {world,sample,battle};
}

test('all65 learned guild enemies skills retain complete source bytes and compile, including085 direct camera controls',async()=>{
  let count=0;
  for(const id of ['021','023','025','027','040','043','060','061','062','063','064','065','082','084','085','088']){
    const role=ai.roles[id],bytes=await readFile(new URL('../../../'+role.source.path,import.meta.url)),learned=[];
    assert.equal(role.skills.length,bytes.readUInt32LE(8));
    let offset=8+0x30b;
    for(const [index,skill]of role.skills.entries()){
      const fixed=bytes.subarray(offset,offset+0x41d),actions=bytes.readUInt32LE(offset+0x15);
      assert.equal(skill.fixed_raw_hex,fixed.toString('hex'));assert.equal(skill.actions.length,actions);
      for(const [actionIndex,action]of skill.actions.entries())assert.equal(action.raw_hex,bytes.subarray(offset+0x41d+actionIndex*0xb0,offset+0x41d+(actionIndex+1)*0xb0).toString('hex'));
      if(fixed[0x23])learned.push(index);
      offset+=0x41d+actions*0xb0;
    }
    assert.deepEqual(role.learned_indices,learned,`${id}: every source learned skill remains admitted`);
    const {battle}=fixture({map_id:'M71080',members:[{id}]});
    for(const index of learned){
      const skill=battle.skills[battle.enemySkillTables['enemy-0'][index]],compiled=compileNativeSequence(viewMeta,id,directSequence(skill));
      assert.deepEqual(skill.actions.map(row=>row.raw_hex),role.skills[index].actions.map(row=>row.raw_hex));
      assert.ok(compiled.steps.length,`${id}:${index}`);count++;
      if(id==='085'&&[20,21].includes(index))assert.ok(compiled.steps.some(step=>step.command_raw===6),`${id}:${index} retains its camera command`);
    }
  }
  assert.equal(count,65);
});

test('actual six-enemy laboratory record keeps all slots through roster, placement and one reward per enemy instance',()=>{
  const table=story.maps['M71078-3-24'],record=table.records.find(row=>row.id===8),group=nativeScriptedBattle(table,record);
  assert.deepEqual(group.members.map(row=>[row.id,row.source_slot]),[['062',0],['061',1],['025',2],['025',3],['061',4],['062',5]]);
  const {sample,battle}=fixture(group),enemies=battle.state.actors.filter(actor=>actor.side==='enemy');
  assert.equal(battle.state.actors.length,10);assert.equal(enemies.length,6);
  const positions=battleActorPositions(battle.state.actors);
  assert.equal(new Set(enemies.map(actor=>positions[actor.id].join(','))).size,6);
  assert.ok(Object.values(positions).every(pair=>pair.length===2&&pair.every(Number.isFinite)));
  const view=new BattleView({canvas:{getContext:()=>({})}});view.ready=true;view.meta=viewMeta;
  view.setRoster(sample.actors,sample.skills);assert.equal(view.roster.length,10);
  const ledger=battle.state.reward_ledger;
  for(const enemy of enemies){enemy.hp.current=0;assert.equal(collectEnemyDefeat(ledger,enemy,{data:rewards}),true);assert.equal(collectEnemyDefeat(ledger,enemy,{data:rewards}),false);}
  assert.deepEqual(ledger.defeated_ids,enemies.map(actor=>actor.id));
  assert.equal(ledger.experience,enemies.reduce((sum,actor)=>sum+rewards.enemies[actor.resource_id].experience,0));
});

test('actual043 and084 Wind Feather apply their allied ID33 source block once and preserve its aggregation on repeat',()=>{
  for(const id of ['043','084']){
    const {battle}=fixture({map_id:'M71080',members:[{id}]}),skill=ai.roles[id].skills[20],fixed=Buffer.from(skill.fixed_raw_hex,'hex');
    assert.equal(skill.battle_handler,'native-support');assert.equal(fixed[0x232],33);assert.equal(fixed[0x23c],0);
    assert.equal(nativeSupportSkillSupported(skill),true);
    const target=clearNativeStatuses(battle.actor('enemy-0'),status),first=applyNativeSupport({target,skill,rng:()=>0,statusData:status});
    assert.equal(first.applied,true);
    const occupied=first.actor.native_status_slots.filter(row=>Buffer.from(row.raw_hex,'hex')[1]===33);
    assert.equal(occupied.length,1);assert.equal(occupied[0].raw_hex,fixed.subarray(0x231,0x2f7).toString('hex'));
    const second=applyNativeSupport({target:first.actor,skill,rng:()=>{throw Error('duplicate must not draw');},statusData:status});
    assert.deepEqual(second.actor.native_status_slots,first.actor.native_status_slots);
    assert.deepEqual(second.actor.status_by_address,first.actor.status_by_address);
  }
});

test('actual061 and063 waiting lightning carriers settle only the selected player in a four-member party',async()=>{
  for(const id of ['061','063']){
    const {world,battle}=fixture({map_id:'M71080',members:[{id}]}),attacker=battle.actor('enemy-0'),target=battle.actor('003'),skill=copy(battle.skills['enemy-0_skill_16']);
    assert.equal(skill.battle_handler,'effect-carrier');assert.equal(Buffer.from(skill.fixed_raw_hex,'hex')[0x24],0);
    const before=world.snapshot();attacker.current_skill=copy(skill);
    await battle.performSequence(attacker,target,skill,directSequence(skill));
    const contacts=battle.state.history.at(-1).contacts;
    assert.ok(contacts.length>0);assert.ok(contacts.every(row=>row.before.target.id==='003'));
    assert.ok(contacts.some(row=>row.source.effect_contact));assert.deepEqual(world.snapshot(),before);
  }
});
