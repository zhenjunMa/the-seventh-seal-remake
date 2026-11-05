// Continue an earned ruins world through the original musical questions,
// pads, guardian roots and return markers. Instant battle callbacks remain
// rule checks; they do not prove movement, rendered fights or heard audio.
import assert from 'node:assert/strict';
import {nativeOwnedQuantity} from '../../web/core/native_economy.mjs';

export async function sealWindComplete(source,earnedActions,{checkpoint=async()=>{}}={}){
  const {world,runner,go,object,setChoices,save}=earnedActions;
  const trace={floors:[],checkpoints:[],scope:'Earned shared world; source DAT routes, object TLK roots, sequence commands and guardian battle callbacks. No flag, answer or reward injection.'};
  const quantity=id=>nativeOwnedQuantity(world.value,id),rewardBefore=quantity(300);
  const mark=async name=>{await save(name);trace.checkpoints.push({name,location:world.location});await checkpoint(name,world,trace);};
  assert.ok(quantity(290)>0,'风之石版须由自然前置链取得');
  await go('REBIRTH-B02');setChoices({'REBIRTH-B02:3':0});
  await runner.runTrigger({mapId:'REBIRTH-B02',triggerId:2});setChoices({});
  assert.equal(world.location.map_id,'WING-C01-A');
  await mark('seal_wind_start');
  for(const floor of ['A','B','C']){
    const questionMap=`WING-A01-${floor}`,answerMap=`WING-B01-${floor}`,guardianMap=`WING-D01-${floor}`;
    const question=source.story.maps[questionMap],answer=source.story.maps[answerMap],guardian=source.story.maps[guardianMap];
    await object(questionMap,7);
    assert.ok(world.value.flags[question.map_flag_index]&128,'原出题物件必须先选题');
    const selected=answer.records.find(record=>record.condition_type===0&&record.condition_index===question.map_flag_index
      &&record.condition_bit>=1&&record.condition_bit<=7&&(world.value.flags[question.map_flag_index]&(1<<(record.condition_bit-1)))
      &&answer.records.some(target=>target.id===record.if_true&&target.mutation_type===7));
    assert.ok(selected,'原出题旗标须对应加载入口的目标序列');
    const target=answer.records.find(record=>record.id===selected.if_true);
    assert.match(target.text_raw,/^[1-7]{7}$/);
    const rng=world.value.encounters.rng_state;
    await object(questionMap,7);assert.equal(world.value.encounters.rng_state,rng,'重听原题不得重新抽题');
    await go(answerMap);
    assert.equal(world.value.native_sequence.target,target.text_raw,'正式进图必须运行源 setup，不能手填答案状态');
    assert.equal(world.value.native_sequence.input_count,0);
    if(floor==='A'){
      const wrong=String(Number(target.text_raw[0])%7+1)+target.text_raw.slice(1);
      for(const digit of wrong)await object(answerMap,7+Number(digit));
      assert.equal(world.value.flags[answer.map_flag_index]&1,0);
      assert.equal(world.value.native_sequence.input_count,0,'原错误答案必须清空计数以允许重试');
      assert.equal(world.value.native_sequence.target,target.text_raw,'错误不得重新抽题');
    }
    let result;
    for(const [index,digit]of [...target.text_raw].entries()){
      result=await object(answerMap,7+Number(digit));
      if(index===2){assert.equal(world.value.native_sequence.input_count,3);await mark(`seal_wind_${floor.toLowerCase()}_partial`);}
    }
    assert.ok(world.value.flags[answer.map_flag_index]&1);
    assert.ok(result.traversed.includes(11),'七个原音符物件必须经条件6→5到源开门记录');
    await go(guardianMap);await mark(`seal_wind_${floor.toLowerCase()}_guardian_before`);
    await runner.runTrigger({mapId:guardianMap,triggerId:3});
    assert.ok(world.value.flags[guardian.map_flag_index]&1);
    if(floor==='C')assert.equal(quantity(300),rewardBefore+1);
    const before=world.snapshot();await runner.runTrigger({mapId:guardianMap,triggerId:3});
    assert.deepEqual(world.value.flags,before.flags);assert.deepEqual(world.value.inventory,before.inventory,'重访守护战不得再给证明奖励');
    trace.floors.push({floor,question_map:questionMap,question_flag_index:question.map_flag_index,
      selected_bit:selected.condition_bit,answer_source:target.source,answer_record:target.id,
      guardian_map:guardianMap,guardian_flag_index:guardian.map_flag_index});
    await mark(`seal_wind_${floor.toLowerCase()}_complete`);
    await runner.runTrigger({mapId:guardianMap,triggerId:2});
    assert.equal(world.location.map_id,floor==='A'?'WING-C01-B':floor==='B'?'WING-C01-C':'REBIRTH-B02');
  }
  assert.equal(quantity(300),rewardBefore+1);await mark('seal_wind_complete');
  return {world,trace};
}
