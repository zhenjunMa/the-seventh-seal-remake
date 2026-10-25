import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WorldStore} from '../web/core/world.mjs';
import {admitPartyMember} from '../web/core/party_members.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {assembleForestSample} from '../web/forest_sample.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {BattleMenuView} from '../web/battle_menu_view.mjs';
import {nativeReactionTargetAvailability,selectNativeNormalReaction} from '../web/core/battle_reactions.mjs';
const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name+'.json',import.meta.url),'utf8')),copy=structuredClone;
const [seed,attributes,commands,forest,scheduler,ai,reactions,status]=await Promise.all(['opening_seed','party_combat','party_skills','forest_combat','battle_scheduler','forest_ai','party_reactions','forest_status'].map(read));
function fixture(ids){
 const worldState=copy(seed);admitPartyMember(worldState,'004');
 const world=new WorldStore(worldState,['M72061','M17020','M70010']),party=createPartySample(world.snapshot(),attributes,commands);
 assert.ok(party.skills['004_33']);assert.ok(party.skills['004_38'],'allied support skills must enter the actual party sample');
 const input=assembleForestSample(party,forest,{map_id:'M70010',members:ids.map(id=>({id}))},{...scheduler,idle_skills:{...scheduler.idle_skills,...commands.idle_skills}},ai,null,reactions,status);
 let draws=0,played=0;
 const battle=new BattleController({world,now:()=>0,id:()=> 'source-reaction-gate',resolveAction(){throw Error('preflight reached damage');},applyDamage(){throw Error('preflight reached HP');},
  playSequence(){played++;throw Error('preflight reached animation');}});
 battle.start({...input,rng:()=>{draws++;return 0;}});battle.scheduleReady=()=>null;
 battle.state.player_id='004';battle.actor('004').charge.gauge=battle.state.scheduler.threshold;
 return {battle,world,draws:()=>draws,played:()=>played};
}
test('recovered source vertical reactions admit staff against every original target before consuming resources',async()=>{
 for(const id of ['011','012','013','032']){
  const f=fixture([id]),beforeMp=f.battle.actor('004').mp.current;
  assert.deepEqual(f.battle.targetIdsForSkill('004_18'),['enemy-0']);assert.equal(f.battle.canChoose('004_18'),true);
  await f.battle.choose('004_18','enemy-0');assert.equal(f.battle.state.scheduler.pending.target_id,'enemy-0');
  assert.equal(f.battle.actor('004').mp.current,beforeMp);assert.equal(f.draws(),0);assert.equal(f.played(),0);
  const source=f.battle.skills['004_18'];assert.equal(Buffer.from(source.actions.find(a=>a.contact_u32_raw_0x49).raw_hex,'hex')[0x62],5);
 }
});

function unsupportedCameraFixture(){
 const f=fixture(['012']);f.battle.reactionData=copy(reactions);
 // Deliberate source perturbation tests admission of an unimplemented camera
 // mode, without editing a registered source record or substituting id1.
 const selected=f.battle.reactionData.roles['012'].skills.find(s=>s.original_id_raw===5);
 for(const action of selected.actions){const b=Buffer.from(action.raw_hex,'hex');if(b[0]===1&&b.readUInt32LE(1)===3){b[0x47]=0;action.raw_hex=b.toString('hex');}}
 return f;
}

test('unimplemented camera-mode source rejects before queue without MP RNG or world mutations',async()=>{
 const f=unsupportedCameraFixture(),before=copy(f.battle.snapshot()),world=f.world.snapshot();
 assert.deepEqual(f.battle.targetIdsForSkill('004_18'),[]);assert.equal(f.battle.canChoose('004_18'),false);
 await assert.rejects(f.battle.choose('004_18','enemy-0'),/击退效果暂不可用/);
 assert.deepEqual(f.battle.snapshot(),before);assert.deepEqual(f.world.snapshot(),world);assert.equal(f.draws(),0);assert.equal(f.played(),0);
});

test('wheel and skills list explain the source reaction restriction before target selection',()=>{
 const f=unsupportedCameraFixture(),messages=[],view=Object.create(BattleMenuView.prototype);
 Object.assign(view,{battle:f.battle,stage:'wheel',snapshot:{player_id:'004'},commandSlots:[{type:0,skill:f.battle.skills['004_18']}],available:()=>true,remember(){},reject:message=>messages.push(message)});
 view.activateWheel(0);assert.match(messages.pop(),/击退效果暂不可用/);assert.equal(view.draft,undefined);
 view.stage='skills';view.entries=[{id:'004_18',available:false,skill:f.battle.skills['004_18']}];view.selectEntry(0);assert.match(messages.pop(),/击退效果暂不可用/);assert.equal(view.draft,undefined);
});
test('source stage12 current-ID closure never selects an airborne ID5 response',()=>{
 const f=fixture(['032']),boss=f.battle.actor('enemy-0'),role=reactions.roles['032'];
 assert.deepEqual(ai.roles['032'].learned_indices.map(index=>Buffer.from(ai.roles['032'].skills[index].fixed_raw_hex,'hex')[0]),[43,44,45,46,47]);
 assert.ok(role.skills.every(skill=>![2,3,5,6,8].includes(skill.original_id_raw)));
 for(const current of role.skills)for(const ident of [0,1,2,5,8]){
  const target={...copy(boss),native_active:false,native_z_raw:0,reaction_special_gate_raw:0,current_target_id:null,current_skill:copy(current)};
  const response=selectNativeNormalReaction({actor:target,ident,data:reactions,rng:()=>0});
  assert.notEqual(response?.skill?.original_id_raw,5);
 }
 for(const id of ['001','002','003','004','005','006']){
  const playerRole=reactions.roles[id];assert.ok(playerRole.skills.some(skill=>skill.original_id_raw===2));assert.ok(playerRole.skills.some(skill=>skill.original_id_raw===3));
  for(const current of playerRole.skills){
   const actor={...copy(f.battle.actor('004')),id,resource_id:id,native_active:false,native_z_raw:0,reaction_special_gate_raw:0,current_target_id:null,current_skill:copy(current)};
   assert.notEqual(selectNativeNormalReaction({actor,ident:1,data:reactions,rng:()=>0})?.skill?.original_id_raw,5);
  }
 }
});
