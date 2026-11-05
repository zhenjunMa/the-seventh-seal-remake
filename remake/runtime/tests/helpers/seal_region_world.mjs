// Continue the earned tablet chains through all six trials and the complete
// cross-map finale. Battles are declared victory callbacks, not rendered wins.
import assert from 'node:assert/strict';
import {WorldStore} from '../../web/core/world/world.mjs';
import {chapterObjectState} from '../../web/core/story/chapter_runner.mjs';
import {changeEquipment} from '../../web/core/items/items.mjs';
import {innerWhiteForestRunner} from './inner_white_forest_world.mjs';
import {sealTabletsComplete} from './seal_tablets_world.mjs';
import {sealWindComplete} from './seal_wind_world.mjs';

export async function sealRegionComplete(source,{checkpoint=async()=>{},battle=async()=>({outcome:'victory'}),verifyFailures=true}={}){
  const earned=await sealTabletsComplete(source,{checkpoint,battle,verifyFailures});
  const {world,runner,trace,go,object,save,setChoices}=earned;
  const quantity=id=>world.value.inventory.filter(row=>row.id===id).reduce((n,row)=>n+row.quantity,0);
  const firstBattle=trace.battles.length;
  const trigger=async(mapId,triggerId)=>{await go(mapId);return runner.runTrigger({mapId,triggerId});};
  const sourceObject=async(mapId,recordId)=>{
    const row=source.story.maps[mapId].objects.find(row=>row.interaction_record_raw_f6===recordId);
    assert.ok(row,`${mapId} source object for TLK ${recordId}`);
    return object(mapId,row.index);
  };
  await go('REBIRTH-B04');await save('seal_region_entry');

  // The admission choice can be declined without consuming its tablet.
  await go('REBIRTH-A04');const beforeCancel=world.snapshot();
  setChoices({'REBIRTH-A04:3':1});await runner.runTrigger({mapId:'REBIRTH-A04',triggerId:2});setChoices({});
  assert.deepEqual({...world.snapshot(),revision:beforeCancel.revision},beforeCancel);
  await save('seal_trial_fire_before');await runner.runTrigger({mapId:'REBIRTH-A04',triggerId:2});
  assert.equal(world.location.map_id,'HELLWAY-B01');
  for(const mapId of ['HELLWAY-M01','HELLWAY-N01','HELLWAY-M02','HELLWAY-N02','HELLWAY-M03','HELLWAY-N03'])
    await trigger(mapId,3);
  await go('HELLWAY-J04');await save('seal_trial_fire_guardian_before');await runner.runTrigger({mapId:'HELLWAY-J04',triggerId:3});
  assert.equal(quantity(299),1);const afterFire=trace.battles.length;
  await runner.runTrigger({mapId:'HELLWAY-J04',triggerId:3});assert.equal(trace.battles.length,afterFire);
  await go('REBIRTH-A04');await save('seal_trial_fire_complete');

  await go('REBIRTH-D01');await save('seal_trial_sun_before');await runner.runTrigger({mapId:'REBIRTH-D01',triggerId:2});
  assert.equal(world.location.map_id,'JUDGELIGH-S01');
  const beforeSunAttempt=world.snapshot();
  await sourceObject('JUDGELIGH-A01',2);await sourceObject('JUDGELIGH-C02',2);
  const beforeWrongSun=trace.battles.length;await sourceObject('JUDGELIGH-S01',2);
  assert.equal(quantity(303),0);assert.equal(trace.battles.length,beforeWrongSun);
  assert.equal(world.value.flags[source.story.maps['JUDGELIGH-S01'].map_flag_index]&255,0);
  assert.equal(chapterObjectState(world.value,'JUDGELIGH-A01',8,source.story),3,
    'TLK mode1 on another map retains40C5C0 arg3=1; it must not clear the event to0');
  assert.equal(world.value.flags[source.story.maps['JUDGELIGH-C02'].map_flag_index]&1,1,
    'The original failure branch retains the touched base flag; retry from the saved handoff');
  trace.sun_failed_attempt={global_flags:world.value.flags[195],retained_base_flags:world.value.flags[source.story.maps['JUDGELIGH-C02'].map_flag_index],
    first_base_object_state:chapterObjectState(world.value,'JUDGELIGH-A01',8,source.story),
    continuation:'Explicit reload of the world saved before the wrong attempt; not a natural puzzle reset.'};
  world.replace(beforeSunAttempt);
  for(const mapId of ['JUDGELIGH-A01','JUDGELIGH-C01','JUDGELIGH-C02','JUDGELIGH-B01',
    'JUDGELIGH-D02','JUDGELIGH-B02','JUDGELIGH-D01','JUDGELIGH-A02'])await sourceObject(mapId,2);
  await go('JUDGELIGH-S01');await save('seal_trial_sun_guardian_before');await sourceObject('JUDGELIGH-S01',2);
  assert.equal(quantity(303),1);await sourceObject('JUDGELIGH-S01',2);assert.equal(quantity(303),1);
  await go('REBIRTH-D01');await save('seal_trial_sun_complete');

  await trigger('REBIRTH-A03',2);assert.equal(world.location.map_id,'YEARN-A01');await save('seal_trial_water_before');
  await sourceObject('YEARN-C01',1);await sourceObject('YEARN-D01',1);
  assert.equal(chapterObjectState(world.value,'YEARN-C01',8,source.story),3);
  assert.equal(chapterObjectState(world.value,'YEARN-D01',7,source.story),3);
  await trigger('YEARN-B02',2);assert.equal(world.location.map_id,'YEARN-A02');
  await go('YEARN-S01');await save('seal_trial_water_guardian_before');await runner.runTrigger({mapId:'YEARN-S01',triggerId:5});
  for(const [mapId,index]of [['YEARN-C02',8],['YEARN-D02',7]]){
    await go(mapId);await save(`seal_water_${mapId.slice(-3).toLowerCase()}_pad_before`);
    await object(mapId,index);assert.equal(chapterObjectState(world.value,mapId,index,source.story),3);
    await object(mapId,index);assert.equal(chapterObjectState(world.value,mapId,index,source.story),3);
  }
  await sourceObject('YEARN-L02',1);assert.equal(quantity(301),1);
  await trigger('YEARN-B01',2);assert.equal(world.location.map_id,'REBIRTH-A03');await save('seal_trial_water_complete');

  await trigger('REBIRTH-B03',2);assert.equal(world.location.map_id,'RUINOUSLY-A01');await save('seal_trial_earth_before');
  for(const mapId of ['RUINOUSLY-A02','RUINOUSLY-B01','RUINOUSLY-C01','RUINOUSLY-D01'])await sourceObject(mapId,1);
  await sourceObject('RUINOUSLY-B02',1);await sourceObject('RUINOUSLY-B02',1);
  assert.equal(world.location.map_id,'RUINOUSLY-D02');
  await go('RUINOUSLY-C02');await save('seal_trial_earth_guardian_before');await sourceObject('RUINOUSLY-C02',1);
  await sourceObject('RUINOUSLY-C02',1);assert.equal(quantity(302),1);
  await runner.runTrigger({mapId:'RUINOUSLY-C02',triggerId:2});assert.equal(world.location.map_id,'REBIRTH-C01');await save('seal_trial_earth_complete');

  await runner.runTrigger({mapId:'REBIRTH-C01',triggerId:2});assert.equal(world.location.map_id,'SILENCE-B13');await save('seal_trial_moon_before');
  for(const mapId of ['SILENCE-A03','SILENCE-A04','SILENCE-A06']){
    await trigger(mapId,3);assert.equal(quantity(304),0);await go('SILENCE-B13');
  }
  // The original maze is directed: B04 can return through A04 to B13, while
  // the B05/A02 branch cannot. Collect the western chest before that branch.
  for(const [mapId,id]of [['SILENCE-B04',119],['SILENCE-B05',118]]){
    const before=quantity(id);await object(mapId,8);assert.equal(quantity(id),before+1);
    await object(mapId,8);assert.equal(quantity(id),before+1);
    const slotId=source.items.definitions[id].slot_id,instanceId=world.value.inventory.find(row=>row.id===id).instance_id;
    changeEquipment(world,source.attributes,source.items,{roleId:'001',slotId,instanceId});await save(`seal_reward_${id}_equipped`);
    changeEquipment(world,source.attributes,source.items,{roleId:'001',slotId});await save(`seal_reward_${id}_removed`);
    changeEquipment(world,source.attributes,source.items,{roleId:'001',slotId,instanceId});await save(`seal_reward_${id}_reequipped`);
  }
  await go('SILENCE-A02');await save('seal_trial_moon_guardian_before');await runner.runTrigger({mapId:'SILENCE-A02',triggerId:3});
  assert.equal(quantity(304),1);
  await go('REBIRTH-C01');await save('seal_trial_moon_complete');

  await sealWindComplete(source,earned,{checkpoint});
  for(const id of [299,300,301,302,303,304])assert.equal(quantity(id),1,`earned energy proof ${id}`);
  await go('REBIRTH-D02');await save('seal_combine_before');await sourceObject('REBIRTH-D02',1);
  for(const id of [9,290,291,292,293,294])assert.equal(quantity(id),0,`combined tablet ${id}`);
  assert.equal(quantity(387),1);await sourceObject('REBIRTH-D02',1);assert.equal(quantity(387),1);await save('seal_combine_complete');

  await trigger('REBIRTH-A02',2);assert.equal(world.location.map_id,'REBIRTH-B01');await go('REBIRTH-A01');await save('seal_finale_before');
  if(verifyFailures){
    const failed=new WorldStore(world.snapshot(),source.mapIds),before=failed.snapshot();let battles=0;
    const attempt=innerWhiteForestRunner(source,failed,{battle:async()=>{
      if(++battles===2)throw Error('seal second guardian defeat');return {outcome:'victory'};
    }});
    await assert.rejects(attempt.runner.runTrigger({mapId:'REBIRTH-A01',triggerId:2}),/seal second guardian defeat/);
    assert.equal(battles,2);assert.deepEqual(failed.snapshot(),before);
  }
  const finalStart=trace.battles.length;await runner.runTrigger({mapId:'REBIRTH-A01',triggerId:2});
  assert.equal(world.location.map_id,'REBIRTH-A01');assert.equal(quantity(135),1);
  assert.deepEqual(trace.battles.slice(finalStart).map(row=>row.members.map(member=>member.id)),[['033'],['034'],['077']]);
  assert.ok(world.value.flags[215]&1);await runner.runTrigger({mapId:'REBIRTH-A01',triggerId:2});assert.equal(quantity(135),1);
  await save('seal_finale_complete');
  const merit={roleId:'001',slotId:source.items.definitions[135].slot_id},meritInstance=world.value.inventory.find(row=>row.id===135).instance_id;
  changeEquipment(world,source.attributes,source.items,{...merit,instanceId:meritInstance});await save('seal_merit_equipped');
  changeEquipment(world,source.attributes,source.items,merit);await save('seal_merit_removed');
  changeEquipment(world,source.attributes,source.items,{...merit,instanceId:meritInstance});await save('seal_merit_reequipped');
  await go('REBIRTH-S01');await save('seal_return_complete');
  trace.seal_region={scripted_battles:trace.battles.slice(firstBattle),finale_battles:trace.battles.slice(finalStart),
    scope:'Earned source-rule continuation; original DAT routes, TLK/ANM, puzzles and rewards. Battle victories are callbacks; no original GAME or rendered fight was observed.'};
  return earned;
}
