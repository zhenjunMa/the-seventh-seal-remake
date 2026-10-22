import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {validatePartyRewards,createRewardLedger,collectEnemyDefeat,planVictoryRewards,
  progressHeaderForRole,nativeExperienceEligibility} from '../web/core/battle_rewards.mjs';

const runtime=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), root=path.resolve(runtime,'../..');
const read=relative=>JSON.parse(fs.readFileSync(path.join(runtime,relative),'utf8'));
const data=validatePartyRewards(read('web/data/party_rewards.json'));
const proof=read('evidence/party_rewards_instructions.json');
const growthProof=read('evidence/forest_rewards_instructions_20261011.json');
const seed=read('web/data/opening_seed.json'), historical=read('web/data/world_seed.json');
const copy=value=>structuredClone(value),hex=b=>Buffer.from(b).toString('hex');
function roleFor(id) {
  const b=Buffer.from(data.initial_roles[id].header_raw_hex,'hex'),get=at=>b.readInt32LE(at);
  return {id,name:data.initial_roles[id].name,level:get(0x24),
    hp:{current:b.readUInt32LE(0x30),maximum:b.readUInt32LE(0x34)},
    mp:{current:b.readUInt32LE(0x38),maximum:b.readUInt32LE(0x3c)},
    attributes_stored:{attack:{current:get(0x40),base:get(0x44)},defense:{current:get(0x48),base:get(0x4c)}},
    combat_progress:{header_raw_hex:hex(b)}};
}
function worldFor() {return {...copy(seed),party:['001','002'].map(roleFor),opening:{id:'resurrect',status:'complete'}};}
function player(id,hp=1) {return {id,side:'player',side_raw:1,hp:{current:hp},immune_raw:0,state_raw:0};}
function pool(players=[player('001'),player('002')],battleId='party-reward-test') {
  const enemy={id:'enemy-0',resource_id:'012',side:'enemy',side_raw:0,hp:{current:0},immune_raw:0,state_raw:5};
  const actors=[...players,enemy],ledger=createRewardLedger(battleId,actors);
  collectEnemyDefeat(ledger,enemy,{data});return {actors,ledger};
}
function slots({id=43,mode=0,duration=-1,flags=0x20}={}) {
  const raw=Buffer.alloc(0xc6);raw[1]=id;raw[0xb]=mode;raw.writeInt32LE(duration,2);raw.writeUInt32LE(flags,0xb8);
  return [{raw_hex:hex(raw)},...Array.from({length:99},()=>({raw_hex:'00'.repeat(0xc6)}))];
}
const noGrowthRandom=()=>99;

class VictoryOracle extends NativeAssemblyOracle {
  constructor(actors,blocked) {
    super(proof.functions,actors.map(actor=>({...actor,raw_by_address:{'0x0524a701':actor.hp.current},
      status_by_address:{},linked_by_address:{},role_link_raw:0,settled_raw:0,
      reaction_inhibit_raw:0,stance_raw:0,class_raw:0,defense_half_raw:0})),()=>{throw Error('victory distribution RNG');});
    this.rows=[];this.blocked=blocked;this.write(0x55df74c,actors.length);
  }
  external(target) {
    const arg=i=>this.read(this.reg.ESP+i*4);
    if(target===0x50b9a0||target===0x50cc20||target===0x50bb50)return;
    if(target===0x50c560){this.reg.EAX=0;return;}
    if(target===0x50a710){this.reg.EAX=this.blocked[arg(0)]??0;return;}
    if(target===0x50bed0){if(arg(0)===0)this.rows.push({actor_index:arg(1),reward_index:arg(2),experience:arg(3)});return;}
    return super.external(target);
  }
}
class GrowthOracle extends NativeAssemblyOracle {
  external(target){if(target===0x50bb50)return;return super.external(target);}
}

test('party rewards retain untouched source CHR headers and recovered Kai growth row',()=>{
  for(const [relative,digest] of Object.entries(data.source_hashes))
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,relative))).digest('hex'),digest);
  for(const id of ['001','002']) {
    const raw=fs.readFileSync(path.join(root,data.initial_roles[id].source.path));
    assert.equal(data.initial_roles[id].header_raw_hex,raw.subarray(8,8+0x30b).toString('hex'));
    assert.equal(data.initial_roles[id].growth_row,Number(id)-1);
  }
  assert.deepEqual(data.tables.growth_rows[1],[90,90,4,4,6,6,3,3,4,4]);
  assert.equal(data.initial_roles['001'].experience,5950);assert.equal(data.initial_roles['002'].experience,4690);
  assert.equal(data.distribution.split,false);
});

test('each participating player receives the full native pool in battle actor order',()=>{
  const {actors,ledger}=pool([player('002'),player('001')]);
  const oracle=new VictoryOracle(actors,[0,0,0]);oracle.write(0x55ede7c,ledger.experience);oracle.run(0x50d1c0,[]);
  const plan=planVictoryRewards({world:worldFor(),ledger,data,rng:noGrowthRandom,actors});
  assert.deepEqual(oracle.rows.map(r=>r.experience),[84,84]);
  assert.deepEqual(plan.summary.experience.map(r=>r.role_id),['002','001']);
  assert.deepEqual(plan.summary.experience.map(r=>r.experience),oracle.rows.map(r=>r.experience));
  assert.deepEqual(plan.summary.experience.map(r=>r.total_experience),[4774,6034]);
});

test('native zero-XP rows cover KO, immunity, state11 and blocked permanent status independently',()=>{
  for(const [blocked,changes] of [[0,{hp:{current:0},state_raw:5}],[0,{immune_raw:1}],
    [0,{state_raw:11}],[1,{native_status_slots:slots()}]]) {
    const players=[player('001'),{...player('002'),...changes}],{actors,ledger}=pool(players);
    const oracle=new VictoryOracle(actors,[0,blocked,0]);oracle.write(0x55ede7c,ledger.experience);oracle.run(0x50d1c0,[]);
    const plan=planVictoryRewards({world:worldFor(),ledger,data,rng:noGrowthRandom,actors});
    assert.deepEqual(oracle.rows.map(r=>r.experience),[84,0]);
    assert.deepEqual(plan.summary.experience.map(r=>r.experience),[84,0]);
    assert.equal(plan.summary.experience[1].total_experience,4690);
  }
});

test('0x50A710 gate requires active non-mode6 negative-duration status with bit5,6 or7',()=>{
  for(const bit of [0x20,0x40,0x80])assert.equal(nativeExperienceEligibility({...player('002'),native_status_slots:slots({flags:bit})}),false);
  for(const changes of [{id:0},{mode:6},{duration:0},{duration:10},{flags:0x10},{flags:0x100}])
    assert.equal(nativeExperienceEligibility({...player('002'),native_status_slots:slots(changes)}),true);
  assert.equal(nativeExperienceEligibility({...player('002'),state_raw:5}),true,'state5 alone is not the native XP exclusion');
  assert.throws(()=>nativeExperienceEligibility({...player('002'),native_status_slots:[]}),/状态槽/);
});

test('new-game two-player growth matches 0x50E070 and 0x518B60 for each raw header',()=>{
  for(const amount of [1260,1500,8000]) {
    const world=worldFor(),{actors,ledger}=pool();ledger.experience=amount;
    world.party[0].hp.current=123;world.party[0].mp.current=4;
    world.party[1].hp.current=234;world.party[1].mp.current=2;
    const expected=[];
    for(const [index,role] of world.party.entries()) {
      const oracle=new GrowthOracle(growthProof.functions,[],()=>{throw Error('deterministic party growth RNG');});
      const header=0x524a6d1+index*0x30274,b=progressHeaderForRole(role,data),table=Buffer.from(growthProof.table.bytes_hex,'hex');
      b.forEach((v,i)=>oracle.write(header+i,v,1));table.forEach((v,i)=>oracle.write(0x679c78+i,v,1));
      const row=index*0x21;oracle.write(0x55ee1f8+row,0,1);oracle.write(0x55ee1f9+row,index);
      oracle.write(0x55ee201+row,amount);oracle.run(0x50e070,[index]);
      expected.push(Buffer.from(Array.from({length:0x30b},(_,i)=>oracle.read(header+i,1))).toString('hex'));
    }
    let rolls=0;const plan=planVictoryRewards({world,ledger,data,rng:()=>{rolls++;return 99;},actors});
    assert.equal(rolls,2,'only original two candidate drop rolls consume RNG');
    assert.deepEqual(plan.world_patch.party.map(r=>r.combat_progress.header_raw_hex),expected,`pool ${amount}`);
  }
});

test('planning preserves all actor raw HP/MP and commits zero-XP KO without restoring it',()=>{
  const world=worldFor();world.party[0].hp.current=42;world.party[0].mp.current=3;
  world.party[1].hp.current=0;world.party[1].mp.current=0;
  const before=copy(world),{actors,ledger}=pool([player('001',42),player('002',0)]);
  const plan=planVictoryRewards({world,ledger,data,rng:noGrowthRandom,actors});
  assert.deepEqual(world,before,'plan stays pure until controller transaction');
  assert.deepEqual(plan.world_patch.party.map(r=>[r.hp.current,r.mp.current]),[[42,3],[0,0]]);
  assert.deepEqual(plan.summary.experience.map(r=>r.experience),[84,0]);
});

test('new-party victory save/reload duplicate applies no XP, items, money or RNG',()=>{
  const world=worldFor(),{actors,ledger}=pool(),plan=planVictoryRewards({world,ledger,data,rng:()=>0,actors});
  const saved=JSON.parse(JSON.stringify({...world,...plan.world_patch,reward_records:[plan.reward_record]}));
  const before=copy(saved),repeat=planVictoryRewards({world:saved,ledger,data,actors,rng:()=>{throw Error('duplicate reward RNG');}});
  assert.equal(repeat.applied,false);assert.equal(repeat.world_patch,null);assert.deepEqual(saved,before);
  assert.deepEqual(repeat.summary,plan.summary);assert.deepEqual(repeat.trace,[]);
});

test('absent party members receive no experience and source/state mismatches fail before RNG',()=>{
  const world=worldFor(),{actors,ledger}=pool([player('001')]);
  const plan=planVictoryRewards({world,ledger,data,rng:noGrowthRandom,actors});
  assert.deepEqual(plan.world_patch.party[1],world.party[1]);
  const noRng=()=>{throw Error('invalid plan RNG');},wrong=copy(world);wrong.source.sha256='0'.repeat(64);
  assert.throws(()=>planVictoryRewards({world:wrong,ledger,data,rng:noRng,actors}),/来源不匹配/);
  assert.throws(()=>planVictoryRewards({world:historical,ledger,data,rng:noRng,actors}),/来源不匹配/);
  const missing=copy(world);missing.party[1].level++;
  const pair=pool();assert.throws(()=>planVictoryRewards({world:missing,...pair,data,rng:noRng}),/成长与世界/);
  const dead=pool([player('001',0),player('002',0)]);
  assert.throws(()=>planVictoryRewards({world,...dead,data,rng:noRng}),/倒下/);
});
