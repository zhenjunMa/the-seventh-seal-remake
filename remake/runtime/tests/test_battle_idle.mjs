// Regression: snow's ten-record idle must not leave every physical command
// permanently in the first record's class3 rejection gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {initializeScheduler,setIdleSkill,advanceIdleSkill,idlePoseAt} from '../web/core/battle_scheduler.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {BattleView} from '../web/battle_view.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {chapterRoleFromDefinition} from '../web/core/chapter.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {assembleForestSample} from '../web/forest_sample.mjs';
import {resolveAction,applyNativeDamage,createNativeRng} from '../web/core/combat_rules.mjs';
import {directSequence,compileNativeSequence} from '../web/core/skill_sequence.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';

const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name,import.meta.url),'utf8'));
const [seed,attributes,commands,forest,scheduler,meta]=await Promise.all([
  'opening_seed.json','party_combat.json','party_skills.json','forest_combat.json','battle_scheduler.json','party_battle_view.json'].map(read));
const role=meta.roles.find(r=>r.id==='012'),segments=scheduler.idle_skills['012'].segments;
const clone=structuredClone;
const starts=segments.map((_,i)=>segments.slice(0,i).reduce((n,s)=>n+s.frames.length*s.interval_raw,0));
const duration=segments.reduce((n,s)=>n+s.frames.length*s.interval_raw,0);
function sample(){
  const world=clone(seed);world.opening.status='complete';
  world.party.push(chapterRoleFromDefinition(world.source.role_definitions['002']));
  world.party.push(chapterRoleFromDefinition(world.source.role_definitions['003']));
  return {world:new WorldStore(world,['M72061','M70010']),
    sample:assembleForestSample(createPartySample(world,attributes,commands),forest,
      {map_id:'M70010',members:[{id:'012'}]}, {...scheduler,idle_skills:{...scheduler.idle_skills,...commands.idle_skills}})};
}

test('complete snow idle records and each DGP range agree with original files and the shared renderer metadata',async()=>{
  assert.equal(segments.length,10);
  assert.deepEqual(segments.map(s=>Buffer.from(s.raw_hex,'hex')[0x24]),[3,3,0,3,0,0,0,0,3,3]);
  assert.deepEqual(role.idle_sequence.segments,segments);
  const source=await readFile(new URL('../../../Fight_Role/012.CHR',import.meta.url));
  for(const segment of segments){
    const raw=source.subarray(segment.source.offset,segment.source.offset+176);
    assert.equal(raw.toString('hex'),segment.raw_hex);
    assert.equal(createHash('sha256').update(raw).digest('hex'),segment.source.raw_sha256);
    const action=role.actions.find(a=>a.index===segment.action_index),d=Buffer.from(action.native_raw_hex,'hex');
    assert.equal(segment.interval_raw,d.readUInt32LE(1));
    const expected=Array.from({length:raw.readUInt32LE(0x2a)-raw.readUInt32LE(0x26)},(_,i)=>{
      const logical=raw.readUInt32LE(0x26)+i;return d[0xd]&15?logical:d[0x16+logical];
    });
    if(raw[0x1d])expected.reverse();assert.deepEqual(segment.frames,expected);
    const atlas=await readFile(new URL('../web'+action.sheet,import.meta.url));
    assert.equal(createHash('sha256').update(atlas).digest('hex'),action.sha256);
  }
});

test('each record boundary and loop use the source class, including independent enemy instances and idle re-entry',()=>{
  const a=clone(forest.actors['012']),b={...clone(a),id:'other-snow',resource_id:'012'};
  a.resource_id='012';initializeScheduler([a,b],scheduler,0,100);
  setIdleSkill(b,scheduler,100+starts[2]);
  for(let i=0;i<segments.length;i++){
    const now=100+starts[i],expected=Buffer.from(segments[i].raw_hex,'hex')[0x24];
    advanceIdleSkill(a,scheduler,now);assert.equal(a.class_raw,expected);assert.equal(a.idle_pose.chr_record_index,i);
    if(i>0){advanceIdleSkill(a,scheduler,now-1);assert.equal(a.idle_pose.chr_record_index,i-1);}
  }
  advanceIdleSkill(a,scheduler,100+starts[2]);advanceIdleSkill(b,scheduler,100+starts[2]);
  assert.equal(a.class_raw,0);assert.equal(b.class_raw,3);
  assert.deepEqual(idlePoseAt(segments,duration),idlePoseAt(segments,0));
  a.native_active=true;advanceIdleSkill(a,scheduler,100+starts[2]);assert.equal(a.idle_pose,undefined);
  a.native_active=false;setIdleSkill(a,scheduler,90000);assert.equal(a.class_raw,3);
  advanceIdleSkill(a,scheduler,90000+starts[2]);assert.equal(a.class_raw,0);
});

test('all registered physical attacks can damage open snow poses and still reject closed poses using the native instruction oracle',async()=>{
  const assembly=JSON.parse(await readFile(new URL('../evidence/turn_rules_assembly_20261011.json',import.meta.url),'utf8'));
  const {sample:party}=sample();
  let count=0;
  for(const skill of Object.values(party.skills).filter(s=>s.actor_id!=='enemy-0'&&s.battle_handler!=='effect-carrier')){
    for(const i of [0,2,3,4,7,8]){
      const attacker=clone(party.actors.find(a=>a.id===skill.actor_id)),target=clone(forest.actors['012']);
      target.resource_id='012';setIdleSkill(target,scheduler,0);advanceIdleSkill(target,scheduler,starts[i]);
      const contact=skill.actions.find(a=>a.contact_u32_raw_0x49);
      attacker.current_skill=clone(skill);attacker.class_raw=contact.class_raw;attacker.action_mask_raw=contact.action_mask_raw;
      const result=resolveAction({attacker,target,skill,rng:createNativeRng(0)});
      const oracle=new NativeAssemblyOracle(assembly.functions,[attacker,target],createNativeRng(0));
      assert.equal(result.native_return,oracle.run(0x41d990,[0,1,0x20000000,0]).eax);
      if([2,4,7].includes(i)){assert.equal(result.hit,true,skill.id);assert.ok(result.damage>0,skill.id);}
      else{assert.equal(result.reason,'action-class-rejected',skill.id);assert.equal(result.damage,0);}
      count++;
    }
  }
  assert.ok(count>=42);
});

test('controller uses the contact timestamp when a slow frame crosses a snow pose boundary',async()=>{
  const {world,sample:party}=sample();let clock=0;
  const compiled=compileNativeSequence(meta,'001',directSequence(commands.skills.yanci));
  const contact=compiled.steps.find(s=>s.event);
  const battle=new BattleController({world,now:()=>clock,resolveAction,applyDamage:applyNativeDamage,
    playSequence:async(_result,hooks)=>{
      // The current render time is closed, but the queued contact was open.
      clock=duration; battle.advanceClock(clock);
      hooks.onRecord(contact);
      hooks.onContact({...contact,contact_key:'first',presentation_time_ms:starts[2]});
      hooks.onPrimaryEnd();return {};
    }});
  battle.start({...party,rng:createNativeRng(0)});battle.running=true;
  const before=battle.actor('enemy-0').hp.current;
  await battle.performSequence(battle.actor('001'),battle.actor('enemy-0'),commands.skills.yanci,directSequence(commands.skills.yanci));
  assert.ok(battle.actor('enemy-0').hp.current<before);
  assert.equal(battle.state.history[0].contacts[0].result.hit,true);
});

test('renderer displays the same complete idle pose used by combat, including the additional snow action',async()=>{
  const drawn=[],ctx={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},ellipse(){},fill(){},save(){},restore(){},fillText(){},drawImage(){},moveTo(){},lineTo(){},stroke(){},createLinearGradient:()=>({addColorStop(){}})};
  const view=new BattleView({canvas:{width:960,height:540,getContext:()=>ctx},metadataPath:'/data/party_battle_view.json',
    jsonLoader:p=>read(p.slice('/data/'.length)),assetLoader:async a=>({width:a.width,height:a.height})});
  await view.prepare();
  const {sample:party}=sample();view.setRoster(party.actors,party.skills);
  view._sprite=(r,action,frame)=>{if(r.id==='012')drawn.push({action,frame});};
  const enemy=party.actors.find(a=>a.id==='enemy-0');setIdleSkill(enemy,scheduler,500);
  for(const at of [0,starts[2],starts[4],duration-1,duration]){
    advanceIdleSkill(enemy,scheduler,500+at);view.draw({actors:party.actors},500+at);
    assert.deepEqual(drawn.at(-1),{action:enemy.idle_pose.action_index,frame:enemy.idle_pose.action_frame});
  }
  assert.ok(drawn.some(p=>p.action===18));
});
