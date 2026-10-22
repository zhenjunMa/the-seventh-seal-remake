import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {validateForestRewards,createRewardLedger,collectEnemyDefeat,recordNativeContact,resetNativeChain,planVictoryRewards,progressHeaderForRole} from '../web/core/battle_rewards.mjs';

const runtime=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), root=path.resolve(runtime,'../..');
const read=relative=>JSON.parse(fs.readFileSync(path.join(runtime,relative),'utf8'));
const data=validateForestRewards(read('web/data/forest_rewards.json'));
const instructions=read('evidence/forest_rewards_instructions_20261011.json');
const seed=read('web/data/world_seed.json');
const copy=value=>structuredClone(value);
const roster=keys=>[{id:'001',side:'player',side_raw:1,hp:{current:1056},immune_raw:0,state_raw:0},
  ...keys.map((key,i)=>({id:`enemy-${i}`,resource_id:key,side:'enemy',side_raw:0,hp:{current:0},state_raw:5,immune_raw:0}))];
function pool(keys,battleId='reward-test'){
  const actors=roster(keys),ledger=createRewardLedger(battleId,actors);
  actors.slice(1).forEach(actor=>collectEnemyDefeat(ledger,actor,{data}));return {actors,ledger};
}
function rngSequence(values){let index=0;const rng=()=>{assert.ok(index<values.length,'unexpected random call');return values[index++];};rng.count=()=>index;return rng;}
function bit(b,at){return new DataView(b.buffer,b.byteOffset,b.byteLength).getInt32(at,true);}
function put(b,at,value){new DataView(b.buffer,b.byteOffset,b.byteLength).setInt32(at,value,true);}

class RewardsOracle extends NativeAssemblyOracle {
  constructor(functions,rng){super(functions,[],rng);this.items=[];}
  external(target){const arg=i=>this.read(this.reg.ESP+i*4);
    if(target===0x4023d3){this.items.push(arg(1)+1);return;} // Native item init is deterministic for the six exported forest definitions.
    if(target===0x50bb50)return; // Display record only.
    return super.external(target);
  }
}
class ChainOracle extends NativeAssemblyOracle {
  regRead(s){const register={AX:'EAX',CX:'ECX',DX:'EDX'}[s];return register?(this.reg[register]&65535):super.regRead(s);}
  regWrite(s,v){const register={AX:'EAX',CX:'ECX',DX:'EDX'}[s];if(register)this.reg[register]=(this.reg[register]&~65535)|(v&65535);else super.regWrite(s,v);}
  value(s){const word=s.match(/^word ptr \[(.*)\]$/);return word?this.read(this.address(word[1]),2):super.value(s);}
}
function dropOracle(ledger,rolls){
  const rng=rngSequence(rolls),o=new RewardsOracle(instructions.functions,rng),pointer=0x20000000;
  o.write(0x503b7e8,pointer);o.write(0x55ede78,ledger.chain.maximum);o.write(0x55ede84,ledger.candidates.length);
  ledger.candidates.forEach((row,i)=>{o.write(0x55ede88+i*8,row.id);o.write(0x55ede8c+i*8,row.count);});
  for(const item of Object.values(data.items)){const b=Buffer.from(item.source.definition_raw_hex,'hex');for(let j=0;j<b.length;j++)o.write(pointer+(item.id-1)*0x3bf+j,b[j],1);}
  o.run(0x50cc20,[]);return {items:o.items,calls:rng.count(),practice:o.read(0x55edf28)};
}

test('reward export anchors exact untouched CHR, ITM and verified save inputs',()=>{
  for(const [relative,digest] of Object.entries(data.source_hashes))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,relative))).digest('hex'),digest);
  const save=fs.readFileSync(path.join(root,'save_analysis_20261010/verified_level12_SaveGame0.Dat'));assert.equal(data.initial_money,save.readUInt32LE(0x81));assert.equal(data.initial_money,50);
  for(const enemy of Object.values(data.enemies)){
    const b=fs.readFileSync(path.join(root,enemy.source.path));assert.equal(enemy.experience,b.readInt32LE(8+0x28));assert.deepEqual(enemy.reward_slots,Array.from({length:6},(_,i)=>b.readInt32LE(8+0xe8+i*4)));
    assert.equal(enemy.reward_slots.filter(v=>v<0).length,0,'forest money must stay zero');
  }
  assert.deepEqual(Object.values(data.enemies).map(e=>e.experience),[60,84,50]);
  assert.equal(Buffer.from(data.initial_roles['001'].header_raw_hex,'hex').readInt32LE(0x28),7450);
});

test('death pool preserves first occurrence order and duplicate forest hunters without double counting',()=>{
  const {actors,ledger}=pool(['012','013','013']);assert.equal(ledger.experience,184);assert.equal(ledger.money,0);
  assert.deepEqual(ledger.candidates,[{id:331,count:3},{id:241,count:1},{id:242,count:2},{id:348,count:2}]);
  const before=copy(ledger);assert.equal(collectEnemyDefeat(ledger,actors[2],{data}),false);assert.deepEqual(ledger,before);
  assert.throws(()=>collectEnemyDefeat(ledger,{...actors[1],hp:{current:1}},{data}),/死亡入口/);
});

test('drop order and strict thresholds match original 0x50CC20 instruction execution',()=>{
  for(const maximum of [0,5,10,20,40,95,200]){
    const {actors,ledger}=pool(['011','012','013','013']);ledger.chain.maximum=maximum;
    const rolls=[0,9,10,99,19,20,4,5,55,60,65];
    const oracle=dropOracle(ledger,rolls),rng=rngSequence(rolls);
    const plan=planVictoryRewards({world:seed,ledger,data,rng,actors});
    const fromPort=plan.trace.filter(t=>t.type==='drop-roll'&&t.success).map(t=>t.id);
    assert.deepEqual(fromPort,oracle.items,`max-chain ${maximum}`);assert.equal(rng.count(),oracle.calls);assert.equal(oracle.practice,data.skill_practice_bonuses[Math.trunc(maximum/5)]);
    assert.equal(plan.summary.money,0);assert.equal(plan.summary.money_after,50);
  }
});

test('drop rate zero consumes RNG and succeeds; minus one skips RNG; stack caps at 99',()=>{
  const fixture=copy(data);fixture.items['331'].drop_rate=0;fixture.items['241'].drop_rate=-1;
  const {actors,ledger}=pool(['012']);const world=copy(seed),item=fixture.items['331'];
  const raw=Uint8Array.from(Buffer.from(item.instance_raw_hex,'hex'));put(raw,4,99);
  world.inventory.push({instance_id:'existing-stone',id:331,name:item.name,quantity:99,source_raw_hex:Buffer.from(raw).toString('hex')});
  const rng=rngSequence([99]);const plan=planVictoryRewards({world,ledger,data:fixture,rng,actors});
  assert.equal(rng.count(),1);assert.deepEqual(plan.summary.drops,[{id:331,name:item.name,quantity:1}]);
  const old=plan.world_patch.inventory.find(v=>v.instance_id==='existing-stone');assert.equal(old.quantity,99);assert.equal(Buffer.from(old.source_raw_hex,'hex').readUInt32LE(4),99);
});

test('original chain only counts repeat settled contacts and resets at dispatch or idle',()=>{
  const {actors,ledger}=pool(['012']),skill={fixed_raw_hex:'00'.repeat(0x41d)},attacker=actors[0],target=actors[1];
  assert.equal(recordNativeContact(ledger,{attacker,target,skill,hit:true,settledBefore:0}),false);
  assert.equal(recordNativeContact(ledger,{attacker,target,skill,hit:false,settledBefore:1}),false);
  for(let i=0;i<4;i++)recordNativeContact(ledger,{attacker,target,skill,hit:true,settledBefore:1});
  assert.equal(ledger.chain.maximum,5);assert.equal(resetNativeChain(ledger,attacker.id),false);assert.equal(resetNativeChain(ledger,target.id),true);assert.equal(ledger.chain.count,0);
  recordNativeContact(ledger,{attacker:target,target:attacker,skill,hit:true,settledBefore:1});assert.equal(ledger.chain.count,2);assert.equal(ledger.chain.maximum,5);
  const changed=Buffer.alloc(0x41d);changed[0x24]=1;assert.equal(recordNativeContact(ledger,{attacker,target,skill:{fixed_raw_hex:changed.toString('hex')},hit:true,settledBefore:1}),false);
});

test('chain count, side switches and dispatch resets match original 0x504B80 instructions',()=>{
  const actors=roster(['012']);const ledger=createRewardLedger('chain-oracle',actors),skill={fixed_raw_hex:'00'.repeat(0x41d)};
  const fixture=actors.map(a=>({...a,raw_by_address:{},status_by_address:{},linked_by_address:{},role_link_raw:0,settled_raw:0,reaction_inhibit_raw:0,stance_raw:0,class_raw:0,defense_half_raw:0}));
  const oracle=new ChainOracle(instructions.functions,fixture,()=>{throw Error('chain must not use RNG');});
  const commands=[[1,1,0],[1,1,0],[1,1,0],[0,0,0],[1,1,0],[0,1,0],[1,0,1],[1,1,0],[1,1,0]];
  for(const [mode,target,attacker] of commands){
    oracle.write(0x521f69d+target*0x30274,1,1);oracle.run(0x504b80,[mode,target,attacker]);
    if(mode)recordNativeContact(ledger,{attacker:actors[attacker],target:actors[target],skill,hit:true,settledBefore:1});else resetNativeChain(ledger,actors[target].id);
    assert.equal(ledger.chain.count,oracle.read(0x55e037c));assert.equal(ledger.chain.maximum,oracle.read(0x55ede78));
  }
});

test('character experience and multiple level growth match original 0x50E070/0x518B60 assembly',()=>{
  for(const amount of [50,84,184,1649,1650,8000,2_000_000]){
    const {actors,ledger}=pool(['012']);ledger.experience=amount;
    const o=new RewardsOracle(instructions.functions,()=>{throw Error('heroine deterministic growth consumed RNG');});
    const b=progressHeaderForRole(seed.party.find(r=>r.id==='001'),data),header=0x524a6d1,table=Buffer.from(instructions.table.bytes_hex,'hex');
    b.forEach((value,i)=>o.write(header+i,value,1));table.forEach((value,i)=>o.write(0x679c78+i,value,1));
    o.write(0x55ee1f8,0,1);o.write(0x55ee1f9,0);o.write(0x55ee201,amount);o.run(0x50e070,[0]);
    const rng=rngSequence([99,99]);const plan=planVictoryRewards({world:seed,ledger,data,rng,actors});const role=plan.world_patch.party.find(r=>r.id==='001');
    const port=Buffer.from(role.combat_progress.header_raw_hex,'hex'),native=Buffer.alloc(0x30b);for(let i=0;i<native.length;i++)native[i]=o.read(header+i,1);
    assert.deepEqual(port,native,`experience ${amount}`);assert.equal(o.read(0x55ee201),0);assert.equal(o.read(0x55ee205),amount);assert.equal(rng.count(),2);
    assert.deepEqual(plan.world_patch.party.find(r=>r.id==='002'),seed.party.find(r=>r.id==='002'),'nonparticipant receives no experience');
  }
});

test('level up restores original base HP/MP and persists raw attack defense and speed for future fights',()=>{
  const {actors,ledger}=pool(['012']);ledger.experience=1650;const world=copy(seed),role=world.party.find(r=>r.id==='001');role.hp.current=100;role.mp.current=2;
  const plan=planVictoryRewards({world,ledger,data,rng:rngSequence([99,99]),actors});const next=plan.world_patch.party.find(r=>r.id==='001');
  assert.equal(next.level,13);assert.equal(next.hp.current,next.hp.maximum);assert.equal(next.hp.maximum,1040);assert.equal(next.mp.current,78);assert.equal(next.mp.maximum,78);
  assert.deepEqual(next.attributes_stored.attack,{current:65,base:65});assert.deepEqual(next.attributes_stored.defense,{current:46,base:46});
  const b=Buffer.from(next.combat_progress.header_raw_hex,'hex');assert.equal(b.readInt32LE(0x58),54);assert.equal(b.readInt32LE(0x28),9100);assert.equal(b.readInt32LE(0x2c),11020);assert.equal(b.readInt32LE(0x64),1920);
  assert.deepEqual(world,({...copy(seed),party:world.party}),'pure plan does not mutate its input');
});

test('victory record makes duplicate planning and saved/reloaded replay consume no RNG and no reward',()=>{
  const {actors,ledger}=pool(['012']);const world=copy(seed),rng=rngSequence([0,0]);world.inventory=world.inventory.filter(item=>![331,241].includes(item.id));const plan=planVictoryRewards({world,ledger,data,rng,actors});
  assert.equal(rng.count(),2);assert.equal(plan.world_patch.inventory.filter(r=>r.id===331).length,1);
  const saved=JSON.parse(JSON.stringify({...world,...plan.world_patch,reward_records:[plan.reward_record]}));
  const repeat=planVictoryRewards({world:saved,ledger:copy(ledger),data,rng:()=>{throw Error('repeated reward RNG');},actors});
  assert.equal(repeat.applied,false);assert.equal(repeat.world_patch,null);assert.deepEqual(repeat.summary,plan.summary);
  const raw=Buffer.from(plan.world_patch.inventory.find(r=>r.id===241).source_raw_hex,'hex');assert.equal(raw.length,0xe5);assert.equal(raw.readUInt32LE(0),241);assert.equal(raw.readUInt32LE(4),1);assert.equal(raw[8],0xcc);assert.equal(raw[0x0c],0);
});

test('partial defeat, player defeat, incompatible progress and overflowing chain table fail before random rolls',()=>{
  const {actors,ledger}=pool(['012']);const failRng=()=>{throw Error('invalid plan consumed RNG');};
  assert.throws(()=>planVictoryRewards({world:seed,ledger:{...ledger,defeated_ids:[]},data,rng:failRng,actors}),/尚未胜利/);
  assert.throws(()=>planVictoryRewards({world:seed,ledger,data,rng:failRng,actors:actors.map(a=>a.side==='player'?{...a,hp:{current:0}}:a)}),/倒下/);
  assert.throws(()=>planVictoryRewards({world:seed,ledger:{...ledger,chain:{...ledger.chain,maximum:205}},data,rng:failRng,actors}),/超出原局部表/);
  const wrong=copy(seed.party.find(r=>r.id==='001'));wrong.level++;assert.throws(()=>progressHeaderForRole(wrong,data),/成长来源/);
});
