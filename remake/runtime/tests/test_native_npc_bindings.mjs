// DAT bindings are templates. Runtime 469F50 replaces all20 channels from DGP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MapNpcRuntime,decodeNpcBehavior,nativeNpcActionBindings} from '../web/core/map_npcs.mjs';
import {MovementMap} from '../web/core/movement.mjs';
import {nativeMapMovement} from '../web/core/map_locomotion.mjs';
import {OpeningView} from '../web/opening_view.mjs';
import {AnmActions} from '../web/core/anm_runtime.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
const runtime=new URL('../',import.meta.url),root=new URL('../../../',import.meta.url);
const json=async path=>JSON.parse(await readFile(new URL(path,runtime),'utf8'));
const [story,resources,map,assembly]=await Promise.all(['web/data/chapter_story.json','web/data/chapter_map_resources.json',
  'web/data/maps/m17030-2.json','evidence/fire_valley_20261025/npc_bindings_469f50_assembly.json'].map(json));
const digest=value=>createHash('sha256').update(value).digest('hex');
assert.equal(digest(await readFile(new URL('GAME.exe',root))),assembly.subject.digest.sha256);
function native(role,template=Buffer.alloc(1221)){
  const oracle=new NativeAssemblyOracle({'0x469f50':assembly.normalized_result.split(/\r?\n/)},[],()=>{throw Error('469F50 must not draw RNG');});
  const base=0x22000000,id=Number(role.id),table=0x23000000;
  template.forEach((value,i)=>oracle.write(base+i,value,1));oracle.write(base+0x28,id);
  const actions=role.source_actions??role.actions;
  oracle.write(0x51dd91a+(id-1)*235,actions.length,1);oracle.write(0x51dd95b+(id-1)*235,table);
  for(const action of actions)Buffer.from(action.raw_hex,'hex').forEach((value,i)=>oracle.write(table+action.index*172+i,value,1));
  oracle.run(0x469f50,[base]);
  return Array.from({length:20},(_,i)=>{const value=oracle.read(base+0x46+i,1);return value===255?-1:value;});
}

test('all exported source ROLE actions retain exact DGP SHA/bytes and match native469F50 across20 channels',async()=>{
  for(const role of Object.values(resources.roles)){
    const dgp=await readFile(new URL(role.source.path,root));assert.equal(digest(dgp),role.source.sha256);
    const actions=role.source_actions??role.actions;
    assert.equal(dgp[0],9);assert.equal(dgp[2],actions.length);
    for(const action of actions)assert.equal(action.raw_hex,dgp.subarray(67+action.index*172,67+(action.index+1)*172).toString('hex'));
    assert.deepEqual(nativeNpcActionBindings(role),native(role),role.id);
  }
});

test('native channel19 boundary, first-match ordering and missing-walk fallback ignore all DAT template bindings',()=>{
  const original=resources.roles['012'];
  for(const channels of [[0],[0,1],[1,0],[19,0,1,19,20,255],[0,0,1,1,2,19]]){
    const role={...original,actions:channels.map((channel,index)=>{const raw=Buffer.from(original.actions[0].raw_hex,'hex');raw[0x7e]=channel;return {...original.actions[0],index,raw_hex:raw.toString('hex')};})};
    role.actions.reverse();
    const template=Buffer.alloc(1221,7);template.fill(19,0x46,0x5a);
    const actual=nativeNpcActionBindings(role);assert.equal(actual.length,20);assert.deepEqual(actual,native(role,template));
    if(channels.length===1)assert.deepEqual(actual.slice(0,3),[0,0,-1],'native does not turn missing run into walk');
    if(channels[0]===19)assert.equal(actual[19],0);
  }
  const invalid=structuredClone(original);invalid.actions[1].index=4;assert.throws(()=>nativeNpcActionBindings(invalid),/绑定/);
});

test('actual M17030-2 丁多 rawFF template initializes ROLE012 idle0/walk1 without changing source bytes or flags',async()=>{
  const data=await readFile(new URL('Map/m17030-2.dat',root)),npc=resources.npcs_by_map['M17030-2'].find(row=>row.slot_zero_based===58),table=story.maps['M17030-2'];
  assert.equal(npc.source.offset,605578);assert.equal(digest(data),npc.source.sha256);
  const raw=data.subarray(npc.source.offset,npc.source.offset+1221),record=table.npc_records.find(row=>row.slot_zero_based===58);
  assert.equal(raw.toString('hex'),record.raw_hex);assert.equal(raw.subarray(0x46,0x5a).toString('hex'),'ff'.repeat(20));
  const before=structuredClone({record,npc,role:resources.roles['012']});
  const scene={data:map,movement:new MovementMap(map.movement),npcs:[structuredClone(npc)]};
  const model=new MapNpcRuntime({scene,table,roles:resources.roles,random:()=>0}),actor=model.actors.get(npc.id);
  assert.deepEqual(decodeNpcBehavior(record).bindings,Array(20).fill(-1));
  assert.equal(actor.source.bindings_initialized,true);assert.equal(actor.source.raw_hex,record.raw_hex);
  assert.deepEqual(actor.source.bindings_raw,Array(20).fill(-1));assert.deepEqual(actor.source.bindings,native(resources.roles['012'],raw));
  assert.deepEqual(actor.source.bindings.slice(0,3),[0,1,-1]);assert.equal(actor.source.fixed,true);
  assert.deepEqual({record,npc,role:resources.roles['012']},before);
});

test('actual finale ANM73/78 actor58 completes real OpeningView movement with initialized bindings and source arrival facing',async()=>{
  const npc=structuredClone(resources.npcs_by_map['M17030-2'].find(row=>row.slot_zero_based===58));
  const data=structuredClone(map);data.movement=nativeMapMovement(data.movement,story.maps['M17030-2']);
  const scene={data,movement:new MovementMap(data.movement),npcs:[npc]};
  scene.npcRuntime=new MapNpcRuntime({scene,table:story.maps['M17030-2'],roles:resources.roles,random:()=>0});
  const view=new OpeningView({resources,prepared:new Map([['M17030-2',scene]]),install(){},camera(){}});
  await view.hooks().map({mapId:'M17030-2'});
  const program=story.programs['m17030-1'],bytes=await readFile(new URL(program.source.path,root));
  assert.equal(digest(bytes),program.source.sha256);
  const positions=new Map(),engine=new AnmActions({hooks:view.hooks(),positions,context:()=>({mapId:'M17030-2'}),nativeMetadata:true});
  const actions=[];view.tween=async(duration,update)=>{assert.ok(duration>0);update(.5);actions.push(view.getActor(58).action);update(1);};
  try{
    for(const index of [73,78]){
      const command=program.commands[index],before=structuredClone(story.maps['M17030-2'].npc_records.find(row=>row.slot_zero_based===58));
      assert.equal(command.opcode,33);assert.equal(command.u32_plus5,58);assert.equal(command.byte_plus29,0);
      assert.equal(command.raw_hex,bytes.subarray(command.source.offset,command.source.offset+74).toString('hex'));
      await engine.execute(command);await engine.flush();
      const actor=view.getActor(58);assert.equal(actor.action,0);assert.equal(actor.frame,0);
      assert.equal(actor.direction,(command.u32_plus25&255)-1);
      assert.deepEqual([actor.x,actor.y],[command.u32_plus13*2,command.u32_plus17*2]);
      assert.deepEqual(story.maps['M17030-2'].npc_records.find(row=>row.slot_zero_based===58),before);
    }
    assert.deepEqual(actions,[1,1]);assert.equal(scene.npcRuntime.actors.get(npc.id).source.fixed,true);
  }finally{engine.dispose();view.dispose();}
});
