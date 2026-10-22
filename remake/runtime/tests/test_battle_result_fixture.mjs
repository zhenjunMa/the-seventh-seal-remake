// A deliberately controlled saved input, followed by actual terrain movement,
// original numeric rules and complete exported contact/lifecycle playback.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {decodeSave,encodeSave} from '../web/core/world.mjs';
import {progressHeaderForRole} from '../web/core/battle_rewards.mjs';
import {BattleResultSequence} from '../web/core/battle_result.mjs';
import {replayFixture} from '../evidence/battle_result_20261020/fixtures/replay_fixture.mjs';
const read=async path=>JSON.parse(await readFile(new URL('../'+path,import.meta.url),'utf8'));

test('controlled report input retains source, inventory, encounter stream and all non-party world fields',async()=>{
  const before=await decodeSave(await read('evidence/battle_alignment_20261015/controlled_entry_save.json'));
  const input=await decodeSave(await read('evidence/battle_result_20261020/fixtures/multi_notice_entry_save.json'));
  const data=await read('web/data/party_rewards.json');
  for(const key of Object.keys(before).filter(key=>key!=='party'))assert.deepEqual(input[key],before[key],key);
  for(const role of input.party){const bytes=progressHeaderForRole(role,data),v=new DataView(bytes.buffer);assert.equal(v.getInt32(0x28,true),v.getInt32(0x2c,true)-1);assert.equal(v.getInt32(0x64,true),1);}
  assert.deepEqual(input.party.map(r=>r.level),[12,10]);
  assert.deepEqual(input.party[0].skill_progress,{version:2,learned_indices:[],records:[{index:22,level:1,experience:799},{index:37,level:1,experience:949}]});
  assert.deepEqual(await decodeSave(await encodeSave(input)),input);
});

test('actual original-parameter win emits rank, learning and role notices that require distinct confirmations',async()=>{
  const save=await read('evidence/battle_result_20261020/fixtures/multi_notice_entry_save.json');
  const result=await replayFixture(save);
  assert.equal(result.final.outcome,'victory');assert.equal(result.final.rewards_applied,true);assert.equal(result.original_configuration.mode,'original');assert.deepEqual(result.original_configuration.differences,[]);
  assert.deepEqual(result.movement.encounter.members.map(m=>m.id),['011','012']);assert.equal(result.movement.steps,1);
  assert.ok(result.commands.some(c=>c.skill_id==='yantu'));assert.ok(result.commands.some(c=>c.skill_id==='yancui'));
  assert.deepEqual(result.summary.experience.map(row=>[row.role_id,row.experience,row.level_before,row.level_after]),[['001',144,12,13],['002',144,10,11]]);
  const notices=result.summary.notifications;
  assert.ok(Array.isArray(notices)&&notices.length>=5);
  for(const [type,id,index]of [['role-level-up','001',undefined],['role-level-up','002',undefined],['skill-level-up','001',22],['skill-level-up','001',37],['skill-learned','001',26]])
    assert.ok(notices.some(n=>n.type===type&&n.actor_id===id&&(index===undefined||n.skill_index===index)),JSON.stringify({type,id,index,notices}));
  const actorResult=result.party_after.find(role=>role.id==='001');assert.ok(actorResult.skill_progress.learned_indices.includes(26));
  assert.equal(actorResult.skill_progress.records.find(row=>row.index===22).level,2);assert.equal(actorResult.skill_progress.records.find(row=>row.index===37).level,2);
  const actors=result.party_after.map(role=>({...role,side:'player'})),sequence=new BattleResultSequence({battleId:result.final.battle_id,summary:result.summary,actors});
  const before=JSON.stringify(result.summary),visible=new Set();let now=0,presses=0;
  while(!sequence.done){
    assert.ok(++presses<=notices.length+5,'Bounded result input');const step=sequence.advance({now});
    for(const notice of sequence.snapshot().notifications.filter(n=>n.active))visible.add(notice.id);
    const held=sequence.snapshot();assert.deepEqual(sequence.advance({repeat:true,now}),{kind:'ignored'});assert.deepEqual(sequence.snapshot(),held);
    sequence.release();now+=100;
    if(step.kind==='complete')break;
  }
  assert.ok(presses>=5,'Several notification rows cannot close on a single Space');assert.equal(visible.size,notices.length);assert.equal(JSON.stringify(result.summary),before,'Acknowledgement does not recalculate reward/progress');
});
