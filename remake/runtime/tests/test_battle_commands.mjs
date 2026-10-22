import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dispatchDefend,clearCommandDefense,dispatchEscapeFailure,resolveNativeEscape,dispatchEscapeSuccess} from '../web/core/battle_commands.mjs';
import {initializeScheduler} from '../web/core/battle_scheduler.mjs';
import {buildEffectiveAttributes,createNativeRng} from '../web/core/combat_rules.mjs';
import {createForestSample} from '../web/forest_sample.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name,import.meta.url)));
const [seed,base,forest,skills,data]=await Promise.all(['route_seed.json','combat_sample.json','forest_combat.json','skills.json','battle_scheduler.json'].map(read));
const asm=JSON.parse(await readFile(new URL('../evidence/forest_scheduler_instructions_20261011.json',import.meta.url)));
const numeric=JSON.parse(await readFile(new URL('../evidence/turn_rules_assembly_20261011.json',import.meta.url)));
const escapeAssembly=JSON.parse(await readFile(new URL('../evidence/battle_alignment_20261015/native_41f070_assembly.json',import.meta.url)));
function fixture(){
  const sample=createForestSample(seed,base,forest,{map_id:'M70010',members:[{id:'012'}]},skills,data);
  const scheduler=initializeScheduler(sample.actors,data);return {...sample,scheduler,player:sample.actors[0]};
}
test('defend retains gauge overflow and existing debt without changing actor state or skill',()=>{
  for(const extra of [0,1,51,10401]){
    const {player,scheduler}=fixture();player.charge.gauge=scheduler.threshold+extra;player.charge.delay=17;player.charge.recovery=3;player.charge.recovery_ticks=2;
    const before=structuredClone(player),event=dispatchDefend(player,scheduler);
    assert.equal(player.charge.gauge,extra);assert.equal(player.defense_half_raw,1);
    assert.deepEqual({...player.charge,gauge:before.charge.gauge},before.charge);
    assert.equal(player.state_raw,before.state_raw);assert.deepEqual(player.current_skill,before.current_skill);
    assert.equal(event.animation_type_raw,9);assert.equal(scheduler.active_actor_id,null);
  }
});
test('defend feeds the existing original effective-defense rule and command consumption clears it',()=>{
  const {player,scheduler}=fixture(),original=buildEffectiveAttributes(player,player.current_skill,createNativeRng(1));
  player.charge.gauge=scheduler.threshold;dispatchDefend(player,scheduler);
  const defended=buildEffectiveAttributes(player,player.current_skill,createNativeRng(1));
  assert.ok(defended.defense>original.defense);assert.equal(defended.attack,original.attack);assert.equal(defended.term4,original.term4);
  assert.deepEqual(clearCommandDefense(player).after,0);
  assert.equal(buildEffectiveAttributes(player,player.current_skill,createNativeRng(1)).defense,original.defense);
});
test('retained native ready scan clears defense before a pending player command exists',()=>{
  for(const gaugeOffset of [-1,0,1])for(const pending of [0,1]){
    const {actors,player,scheduler}=fixture();player.defense_half_raw=1;player.charge.gauge=scheduler.threshold+gaugeOffset;
    class ScanOracle extends NativeAssemblyOracle {
      external(target){
        if(target===0x504b80)throw stop;
        return super.external(target);
      }
    }
    const stop={},oracle=new ScanOracle(asm.functions,actors,()=>{throw Error('Scan must not draw');});
    oracle.write(0x55df74c,actors.length);oracle.write(0x679c6c,0);oracle.write(0x679c74,scheduler.threshold);oracle.write(0x55df75c,0);
    actors.forEach((a,i)=>{const o=i*0x30274;oracle.write(0x521a770+o,1);oracle.write(0x521a7b9+o,a.charge.gauge);oracle.write(0x521a7c5+o,a===player?pending:0,1);});
    try{oracle.run(0x5036d0,[]);}catch(error){if(error!==stop)throw error;}
    const expected=gaugeOffset<0?1:0;assert.equal(oracle.read(0x521f684,1),expected);
    if(gaugeOffset>=0)clearCommandDefense(player);assert.equal(player.defense_half_raw,expected);
  }
});
test('failed individual escape zeros gauge and clears FF defense marker without spending skill debt',()=>{
  const {player,scheduler}=fixture();player.charge.gauge=scheduler.threshold+77;player.defense_half_raw=1;player.charge.delay=9;
  const before=structuredClone(player),event=dispatchEscapeFailure(player);
  assert.equal(player.charge.gauge,0);assert.equal(player.defense_half_raw,0);assert.equal(player.charge.delay,9);
  assert.equal(player.state_raw,before.state_raw);assert.deepEqual(player.hp,before.hp);assert.equal(event.success,false);
});
test('invalid command scalar input is rejected before mutation',()=>{
  const {player,scheduler}=fixture(),before=structuredClone(player);
  assert.throws(()=>dispatchDefend(player,{...scheduler,threshold:0}));assert.deepEqual(player,before);
});
test('escape decision, effective-attribute RNG, and repeated per-actor division match retained x86',()=>{
  const functions={...numeric.functions,...asm.functions,'0x41f070':escapeAssembly.normalized_result.trim().split(/\r?\n/)};
  for(let index=0;index<96;index++){
    const {player,actors}=fixture(),enemy=actors[1];
    const copyEnemy=(n)=>({...structuredClone(enemy),id:`enemy-${n}`}),copyPlayer={...structuredClone(player),id:'other-player'};
    const members=[player,copyEnemy(0),copyEnemy(1),copyPlayer,copyEnemy(2)];
    for(let i=0;i<members.length;i++){
      const a=members[i];a.raw_by_address['0x0524a711']=30;a.raw_by_address['0x0524a715']=40;
      a.raw_by_address['0x0524a719']=20;a.raw_by_address['0x0524a71d']=29;
      a.raw_by_address['0x0524a729']=index%4?45+i*5:1;a.raw_by_address['0x0524a72d']=index%4?55+i*5:2;
      if(i===2){if(index%3===0)a.state_raw=4;if(index%3===1)a.status_flags_raw=0x20;if(index%3===2)a.charge.recovery=1;}
    }
    const seed=index*214013,portedRng=createNativeRng(seed),oracleRng=createNativeRng(seed);
    const before=structuredClone(members),actual=resolveNativeEscape({actor:player,actors:members,rng:portedRng});
    const oracle=new NativeAssemblyOracle(functions,members,oracleRng);
    oracle.write(0x55df74c,members.length);members.forEach((a,i)=>{oracle.write(0x521f52a+i*0x30274,a.status_flags_raw);oracle.write(0x521f69e+i*0x30274,a.charge.recovery||a.reaction_inhibit_raw);});
    const native=oracle.run(0x41f070,[0]);assert.equal(actual.native_return,native.eax,`native decision ${index}`);
    assert.deepEqual(actual.trace.filter(row=>row.kind==='rng').map(row=>row.raw),native.rng_calls,`native RNG ${index}`);
    assert.deepEqual(members,before);assert.equal(portedRng.state,oracleRng.state);
  }
});
test('escape threshold comparison preserves equality failure and strict greater success',()=>{
  for(const roll of [0,70,71,99]){
    const {player,actors}=fixture();
    for(const member of actors){const speed=member===player?1:1000;member.raw_by_address['0x0524a729']=speed;member.raw_by_address['0x0524a72d']=speed;member.current_skill={fixed_raw_hex:'00'.repeat(0x41d)};}
    const actual=resolveNativeEscape({actor:player,actors,rng:()=>roll});
    assert.equal(actual.threshold,70);assert.equal(actual.success,roll>70);
  }
});
test('escape global gate succeeds with no attribute reads or random draws; exit affects one actor',()=>{
  const {player,actors}=fixture(),before=structuredClone(actors[1]);
  const decision=resolveNativeEscape({actor:player,actors,rng:()=>{throw Error('No RNG on global escape gate');},global_055ee004:1});
  assert.equal(decision.success,true);assert.deepEqual(decision.trace,[]);
  const hp=structuredClone(player.hp),mp=structuredClone(player.mp),event=dispatchEscapeSuccess(player);
  assert.equal(player.state_raw,11);assert.equal(player.escaped,true);assert.equal(player.charge.gauge,0);
  assert.deepEqual(player.hp,hp);assert.deepEqual(player.mp,mp);assert.deepEqual(actors[1],before);assert.equal(event.animation_type_raw,10);
});
test('escape preserves native threshold90 cap and reports the original zero-divisor boundary',()=>{
  for(const roll of [90,91]){
    const {player,actors}=fixture();
    for(const member of actors){const speed=member===player?100000:1;member.raw_by_address['0x0524a729']=speed;member.raw_by_address['0x0524a72d']=speed;member.current_skill={fixed_raw_hex:'00'.repeat(0x41d)};}
    const decision=resolveNativeEscape({actor:player,actors,rng:()=>roll});assert.equal(decision.threshold,90);assert.equal(decision.success,roll===91);
  }
  const {player,actors}=fixture();actors[1].state_raw=4;const before=structuredClone(actors);
  assert.throws(()=>resolveNativeEscape({actor:player,actors,rng:()=>0}),/x86 IDIV exception/);assert.deepEqual(actors,before);
});
