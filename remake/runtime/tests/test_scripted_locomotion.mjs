import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {OpeningView}=await import('../web/opening_view.mjs');
const {AnmActions}=await import('../web/core/anm_runtime.mjs');
const read=name=>JSON.parse(readFileSync(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
const resources=read('opening_map_resources'),map=read('maps/m72061');

function fixture({hz=60,sequence=false,axis=false}={}) {
  const role=structuredClone(resources.roles['013']);
  if(sequence)Object.assign(role.actions[1],{uses_sequence:true,logical_count:3,sequence_length_raw:3,
    sequence_raw:[0,2,1,...Array(87).fill(9)]});
  const view=new OpeningView({resources,prepared:new Map(),staging:{M72061:{axis_approach:axis}},log(){}});
  view.scene={data:map};view.mapId=map.id;
  const actor={id:'test',x:100,y:100,role,direction:5,action:0,frame:0};view.actors.set(10,actor);
  const samples=[];let duration=0;
  view.tween=async(ms,update,signal)=>{
    duration=ms;signal?.throwIfAborted();
    for(let time=0;time<ms;time+=1000/hz){update(time/ms);samples.push({time,x:actor.x,y:actor.y,frame:actor.frame});}
    update(1);samples.push({time:ms,x:actor.x,y:actor.y,frame:actor.frame});
  };
  return {view,actor,samples,get duration(){return duration;},move:(x,y,raw=0)=>view.hooks().move({actor:10,x,y,arrivalFacingRaw:raw})};
}

test('ANM33 forwards arrival facing from the low byte and never exposes it as speed',async()=>{
  let payload;
  const actions=new AnmActions({hooks:{move:async p=>payload=p},context:()=>({mapId:map.id}),positions:new Map()});
  await actions.execute({opcode:33,u32_plus5:10,u32_plus13:80,u32_plus17:90,u32_plus25:0x107,byte_plus29:0});
  await actions.flush();assert.equal(payload.arrivalFacingRaw,7);assert.equal('speedRaw' in payload,false);
});

test('arrival-facing changes never affect movement speed; zero preserves travel facing',async()=>{
  for(const raw of [0,1,4,7,8]){
    const f=fixture();await f.move(220,100,raw);
    assert.equal(f.duration,930);assert.equal(f.actor.direction,raw?raw-1:1);
    assert.equal(f.actor.x,220);assert.equal(f.actor.y,100);assert.equal(f.actor.action,0);assert.equal(f.actor.frame,0);
    assert.equal(f.samples.at(-1).frame,5); // 120px / 8px per pose, modulo10.
  }
});

test('scripted gait follows eight pixels per pose across RAF rates, route corners and logical source sequences',async()=>{
  for(const hz of [30,60,120])for(const axis of [false,true])for(const sequence of [false,true]){
    const f=fixture({hz,axis,sequence});await f.move(148,164,4);
    const distance=axis?112:64;assert.equal(f.duration,distance*31/4);
    for(const sample of f.samples){
      const logical=Math.floor(distance*sample.time/f.duration/8+1e-8)%(sequence?3:10);
      assert.equal(sample.frame,sequence?[0,2,1][logical]:logical);
    }
    assert.equal(f.actor.direction,3);
  }
});

test('zero-distance moves only apply arrival facing; short moves have no arbitrary minimum duration',async()=>{
  const f=fixture();await f.move(100,100,7);assert.equal(f.samples.length,0);assert.equal(f.actor.direction,6);
  await f.move(101,100,0);assert.equal(f.duration,7.75);assert.equal(f.actor.frame,0);assert.equal(f.actor.direction,1);
  f.view.dispose();await assert.rejects(f.view.hooks().move({actor:10,x:101,y:100,arrivalFacingRaw:7}),/演出已关闭/);
});
