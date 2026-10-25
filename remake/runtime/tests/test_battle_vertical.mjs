import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {nativeVerticalState,createNativeVertical,advanceNativeVertical,verticalActorPatch} from '../web/core/battle_vertical.mjs';

const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
const [instructions,reactions,game]=await Promise.all([
  read('./fixtures/native_vertical_source.json'),read('../web/data/party_reactions.json'),readFile(new URL('../../../GAME.exe',import.meta.url))]);
const sha=b=>createHash('sha256').update(b).digest('hex');
assert.equal(sha(game),instructions.artifact_sha256);
const initLines=instructions.functions.initialization;
// Two explicit harness returns stop the isolated vertical block where the
// source continues into other animation rules or the function epilogue.
// All vertical arithmetic/branches are the retained native instructions.
const tickLines=instructions.functions.update.concat(['0x51a969: RET','0x51bb6d: RET']);
const id5Actions=id=>reactions.roles[id].skills.find(skill=>skill.original_id_raw===5).actions.map(action=>action.raw_hex);
const fields={z:[0x521a785,4],target_z:[0x524a63a,4],velocity:[0x524a63e,4],counter:[0x524a636,4],wait_raw:[0x524a635,1],
  acceleration_raw:[0x524a642,1],render_z:[0x521a79d,4],delay_ms:[0x521a7b1,4]};
function vaBytes(address,size){
  const pe=game.readUInt32LE(0x3c),optional=pe+24,sections=optional+game.readUInt16LE(pe+20),rva=address-game.readUInt32LE(optional+28);
  for(let i=0;i<game.readUInt16LE(pe+6);i++){
    const at=sections+i*40,start=game.readUInt32LE(at+12),length=Math.max(game.readUInt32LE(at+8),game.readUInt32LE(at+16));
    if(start<=rva&&rva<start+length){const file=game.readUInt32LE(at+20)+rva-start;return game.subarray(file,file+size);}
  }throw Error('Source VA is not mapped');
}
const jumpTable=vaBytes(0x513dd9,13*4);assert.equal(jumpTable.readUInt32LE(3*4),0x51358a);
class VerticalOracle extends NativeAssemblyOracle{
  constructor(code){super({vertical:code},[{raw_by_address:{},status_by_address:{},linked_by_address:{}}],()=>{throw Error('Vertical motion must not draw RNG');});this.camera=[];this.projections=[];this.advances=0;}
  external(target){
    const arg=i=>this.read(this.reg.ESP+i*4);
    if(target===0x5017b0){assert.ok(this.record);for(let i=0;i<this.record.length;i++)this.write(arg(0)+i,this.record[i],1);this.reg.EAX=arg(0);return;}
    if(target===0x5119f0){this.camera.push({x:arg(0),y:arg(1),wait_raw:arg(2)&255,acceleration_raw:arg(3)&255});return;}
    if(target===0x51a240){this.advances++;return;} // Record cursor/51CC00 owned by the caller, outside this arithmetic oracle.
    if(target===0x513fc0){this.projections.push([arg(0),arg(1)]);return;} // Renderer/projection observes the resulting Z.
    return super.external(target);
  }
  load(state){for(const[key,[address,size]]of Object.entries(fields))this.write(address,state[key],size);}
  snapshot(){return Object.fromEntries(Object.entries(fields).map(([key,[address,size]])=>[key,this.read(address,size)]));}
}
function actor(z=0){return {id:'001',native_z_raw:z,native_vertical_render_z_raw:z,native_after_raw:{'0x0521f692':123},hp:{current:0,maximum:100},sentinel:{preserved:true}};}
function sourceCommand(mode,{speed=8,multiplier=10,wait=1,acceleration=1}={}){
  const b=Buffer.alloc(0xb0);b[0]=1;b.writeUInt32LE(3,1);b.writeInt32LE(speed,5);b.writeInt32LE(multiplier,0x1e);b[0x1d]=wait;b[0x23]=acceleration;b[0x47]=mode;return b.toString('hex');
}
function rawState(state){return Object.fromEntries(Object.keys(fields).map(key=>[key,state[key]]));}
function initializationOracle(input,record){
  const oracle=new VerticalOracle(initLines);oracle.record=Buffer.from(record,'hex');oracle.load(nativeVerticalState(input));
  for(let i=0;i<jumpTable.length;i++)oracle.write(0x513dd9+i,jumpTable[i],1);
  oracle.run(0x5130d0,[0]);return oracle;
}
function tickOracle(state){const oracle=new VerticalOracle(tickLines);oracle.load(state);oracle.reg.EBP=0x20000000;oracle.write(oracle.reg.EBP+8,0);return oracle;}

test('real player ID5 command3 bytes initialize the same actor fields as full5130D0 source assembly',async()=>{
  for(const id of ['001','002','003','004','005','006']){
    const source={path:`Fight_Role/${id}.CHR`,sha256:reactions.source_hashes[`Fight_Role/${id}.CHR`]},bytes=await readFile(new URL(`../../../${source.path}`,import.meta.url));assert.equal(sha(bytes),source.sha256);
    for(const raw of id5Actions(id).filter(raw=>Buffer.from(raw,'hex')[0]===1)){
      assert.ok(bytes.includes(Buffer.from(raw,'hex')),'Literal action record must be present in the unchanged original CHR');
      const input=actor(-17),before=structuredClone(input),state=createNativeVertical({actor:input,record:{raw_hex:raw}}),oracle=initializationOracle(input,raw);
      assert.deepEqual(rawState(state),oracle.snapshot());assert.equal(oracle.advances,1);assert.deepEqual(oracle.camera,[]);assert.deepEqual(input,before);
    }
  }
});

test('all four actor modes, signed product/velocity and camera requests match the original initialization instructions',()=>{
  for(const mode of [0,1,2,3])for(const acceleration of [0,1,255])for(const wait of [0,1,7])for(const [speed,multiplier,z]of [[8,10,0],[3,7,-50],[-3,7,-50],[0,10,-8],[2147483647,3,-9]]){
    const raw=sourceCommand(mode,{speed,multiplier,wait,acceleration}),input=actor(z),state=createNativeVertical({actor:input,record:raw}),oracle=initializationOracle(input,raw);
    assert.deepEqual(rawState(state),oracle.snapshot(),JSON.stringify({mode,acceleration,wait,speed,multiplier,z}));
    assert.deepEqual(oracle.camera,state.camera_request?[Object.fromEntries(Object.entries(state.camera_request).filter(([key])=>key!=='procedure'))]:[]);
  }
});

test('51A4F0 native instruction oracle agrees tick by tick on positive/negative motion, acceleration, clamps and early guards',()=>{
  const cases=[];
  for(const mode of [0,1,2,3])for(const acceleration of [0,1,255])for(const wait of [0,1])for(const z of [0,-1,-17,-80])cases.push(createNativeVertical({actor:actor(z),record:sourceCommand(mode,{speed:8,multiplier:10,wait,acceleration})}));
  for(const [z,target_z,velocity,counter,acceleration_raw,wait_raw]of [[-10,-80,-1,0,1,1],[-20,-80,8,0,1,1],[-5,0,2147483647,4,1,1],[-80,-80,8,7,1,1],[3,-80,0,7,1,1],[-80,0,3,2147483647,1,255]]){
    cases.push({...nativeVerticalState(actor(z)),target_z,velocity,counter,acceleration_raw,wait_raw});
  }
  for(const start of cases){let state=start;const oracle=tickOracle(state);
    for(let tick=0;tick<40;tick++){oracle.run(0x51a622,[]);state=advanceNativeVertical(state,20);assert.deepEqual(rawState(state),oracle.snapshot(),JSON.stringify({start,tick}));}
  }
});

test('real nonwait ascent and landing wait preserve KO resources and expose grounding to the lifecycle owner',()=>{
  const [up,,down]=id5Actions('001'),input=actor(0),before=structuredClone(input);
  let rising=createNativeVertical({actor:input,record:up});assert.equal(rising.wait_raw,0);assert.equal(rising.waiting,false);assert.equal(rising.velocity,-40);assert.equal(rising.target_z,-80);
  const z=[];for(let i=0;i<3;i++){rising=advanceNativeVertical(rising,20);z.push(rising.z);}assert.deepEqual(z,[-40,-75,-80]);assert.equal(rising.reached,true);assert.equal(rising.landed,false);
  const airborne={...input,...verticalActorPatch(rising,input)},saved=structuredClone(airborne);assert.equal(airborne.native_after_raw['0x0521f692'],123);assert.equal(airborne.hp.current,0);assert.equal(airborne.native_z_raw,-80);
  let falling=createNativeVertical({actor:airborne,record:down});assert.equal(falling.waiting,true);assert.equal(falling.velocity,1);assert.equal(falling.target_z,0);
  for(let i=1;i<=11;i++){falling=advanceNativeVertical(falling,20);assert.equal(falling.landed,i===11);assert.equal(falling.waiting,i<11);}
  assert.equal(falling.z,0);assert.equal(falling.velocity,0);assert.equal(falling.acceleration_raw,0);assert.equal(falling.wait_raw,0);
  assert.deepEqual(input,before);assert.deepEqual(airborne,saved);
  const landed={...airborne,...verticalActorPatch(falling,airborne)};assert.equal(landed.native_z_raw,0);assert.equal(landed.hp.current,0);
  landed.native_after_raw['0x0521a7b1']=777;
  const idle=advanceNativeVertical(falling,20),patch=verticalActorPatch(idle,landed);assert.equal(patch.native_vertical_delay_raw,undefined);assert.equal(patch.native_after_raw['0x0521a7b1'],777);
});

test('fractional frame ownership, zero-speed stale wait, validation and restore from source dispatcher fields remain pure',()=>{
  const initial=createNativeVertical({actor:actor(-80),record:sourceCommand(3)}),a=advanceNativeVertical(advanceNativeVertical(initial,19),1),b=advanceNativeVertical(initial,20);assert.deepEqual(a,b);
  const four=advanceNativeVertical(initial,80);let once=initial;for(let i=0;i<4;i++)once=advanceNativeVertical(once,20);assert.deepEqual(four,once);
  const stopped=createNativeVertical({actor:actor(-10),record:sourceCommand(3,{speed:0,acceleration:0})});assert.equal(stopped.wait_raw,1);assert.equal(stopped.waiting,false);assert.equal(advanceNativeVertical(stopped,20).z,-10);
  const resumed=nativeVerticalState({native_z_raw:-30,native_after_raw:{'0x0524a63a':0,'0x0524a636':4,'0x0524a63e':8,'0x0524a642':1,'0x0524a635':0}});
  assert.equal(advanceNativeVertical(resumed,20).z,-22);
  assert.throws(()=>createNativeVertical({actor:actor(),record:sourceCommand(4)}),/camera executor/);
  assert.throws(()=>createNativeVertical({actor:{},record:sourceCommand(2)}),/actor Z/);
  assert.throws(()=>advanceNativeVertical(initial,-1),/elapsed/);assert.throws(()=>createNativeVertical({actor:actor(),record:'00'}),/bytes/);
});
