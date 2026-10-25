// Real source movement plans and renderer, with a recorded Canvas draw order.
// Ground/visual placement remains the declared browser presentation adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {BattleView} from '../web/battle_view.mjs';
import {directSequence} from '../web/core/skill_sequence.mjs';

const web=new URL('../web/',import.meta.url),read=async name=>JSON.parse(await readFile(new URL('data/'+name,web)));
const [commands,ai,reactions]=await Promise.all(['party_skills.json','forest_ai.json','party_reactions.json'].map(read));
function setActors(view,enemyResources,playerResources){
  const roster=[...playerResources.map(id=>({id,resource_id:id,side:'player'})),...enemyResources.map((resource_id,i)=>({id:`enemy-${i}`,resource_id,side:'enemy'}))];
  view.setRoster(roster,{...commands.skills,...Object.fromEntries(enemyResources.map((_,i)=>[`enemy-${i}-skill`,{id:i===0?'eagle':'snow',actor_id:`enemy-${i}`}]))});
  return {actors:roster.map(a=>({...a,hp:{current:1000,maximum:1000},alive:true}))};
}
async function fixture(enemyResources=['011','012'],playerResources=['001','002']){
  const calls=[],ctx={setTransform(){},clearRect(){},fillRect(){},beginPath(){},rect(){},clip(){},ellipse(){},fill(){},save(){},restore(){},fillText(){},
    drawImage(image){calls.push(image.path);}};
  const view=new BattleView({canvas:{width:1280,height:960,getContext:()=>ctx},metadataPath:'/data/party_battle_view.json',stageMetadataPath:'/data/forest_stage.json',
    jsonLoader:path=>read(path.slice('/data/'.length)),assetLoader:async a=>({width:a.width,height:a.height,path:a.path})});
  await view.prepare();
  const snapshot=setActors(view,enemyResources,playerResources);
  const sprite=view._sprite.bind(view);view._sprite=(role,...args)=>{calls.push('actor:'+role.id);return sprite(role,...args);};
  return {view,calls,snapshot};
}

function assertBackgroundFirst(calls,actorCount){
  const background=calls.map((path,i)=>path.includes('/forest_stage/')?i:-1).filter(i=>i>=0);
  const actors=calls.map((path,i)=>path.startsWith('actor:')?i:-1).filter(i=>i>=0);
  assert.equal(background.length,3,'All three scenery layers are drawn');
  assert.equal(actors.length,actorCount);
  assert.ok(Math.max(...background)<Math.min(...actors),'Scenery must finish before any combat actor is drawn');
}

test('Screenshot regression: the first hunter in a three-player, two-enemy battle is above every scenery layer',async()=>{
  const {view,calls,snapshot}=await fixture(['013','012'],['001','002','003']);
  view.draw(snapshot,0);
  assertBackgroundFirst(calls,5);
});

test('All one-to-four enemy arrangements and one-to-three joined players stay above scenery without changing positions',async()=>{
  const {view,calls}=await fixture();let groups=[[]],cases=0;
  for(let count=1;count<=4;count++){
    groups=groups.flatMap(ids=>['011','012','013'].map(id=>[...ids,id]));
    for(const enemies of groups)for(let players=1;players<=3;players++){
      const snapshot=setActors(view,enemies,['001','002','003'].slice(0,players));
      calls.length=0;view.draw(snapshot,0);assertBackgroundFirst(calls,enemies.length+players);cases++;
    }
  }
  assert.equal(cases,360);
});

test('Hunter and the third party member remain above scenery throughout their approach, contact and return',async()=>{
  for(const actor of ['enemy-0','003']){
    const {view,calls,snapshot}=await fixture(['013','012'],['001','002','003']);
    const target=actor==='003'?'enemy-0':'003',skill=actor==='003'?commands.skills['003_21']:ai.roles['013'].skills[15];
    const done=view.playSequence({actor_id:actor,target_id:target,skill_id:actor==='003'?'003_21':'eagle',plan:directSequence(skill)},
      {onRecord(){},onContact:()=>({hit:true,damage:1,remainingHp:999})});
    let frames=0;
    for(let now=0;view.run;now+=65){
      assert.ok(++frames<2000);calls.length=0;view.draw(snapshot,now);assertBackgroundFirst(calls,5);
    }
    await done;assert.ok(frames>1);
  }
});

test('Both players approach the flying target in front of the ridge throughout source approach/return',async()=>{
  for(const [actor,skillId] of [['001','yanci'],['002','kai_mieyan']]){
    const {view,calls,snapshot}=await fixture(),skill=commands.skills[skillId];
    const done=view.playSequence({actor_id:actor,target_id:'enemy-0',skill_id:skillId,plan:directSequence(skill)},
      {onRecord(){},onContact:()=>({hit:true,damage:1,remainingHp:999})});
    let frames=0;
    for(let now=0;view.run;now+=65){
      assert.ok(++frames<2000);calls.length=0;view.draw(snapshot,now);
      assertBackgroundFirst(calls,4);
      assert.ok(view._slots(view.run,true)[actor][1]>view._slots(view.run)[actor][1],'Ground shadows remain separate from visual altitude');
    }
    await done;
  }
});

test('Counter movement uses its own ground path while the parent flying action continues',async()=>{
  const {view,calls,snapshot}=await fixture(),counter=reactions.roles['001'].skills.find(s=>s.original_id_raw===19);
  let contacts=0,counterFrames=0;
  const descriptor={actor_id:'001',target_id:'enemy-0',skill:counter,plan:{...directSequence(counter),allow_no_contacts:true}};
  const done=view.playSequence({actor_id:'enemy-0',target_id:'001',skill_id:'eagle',plan:directSequence(ai.roles['011'].skills[14])},
    {onRecord(){},onContact:()=>({hit:true,damage:1,remainingHp:999,...(++contacts===1?{reaction_descriptor:descriptor}:{})}),
      onReactionRecord(){},onReactionContact:()=>({hit:true,damage:1,remainingHp:999}),onReactionEnd(){}});
  const spritePositions=new Map(),originalSprite=view._sprite.bind(view);
  view._sprite=(role,action,frame,x,y,...rest)=>{spritePositions.set(role.id,[x,y]);return originalSprite(role,action,frame,x,y,...rest);};
  let frames=0;
  for(let now=0;view.run;now+=65){assert.ok(++frames<2000);calls.length=0;view.draw(snapshot,now);
    assertBackgroundFirst(calls,4);
    const [x,y]=spritePositions.get('001'),position=view.actorPositions()['001'];
    assert.deepEqual(position,[(x-120)/1.125,y/1.125],'HUD follows the actual reaction-channel sprite');
    if(view.run?.children.some(c=>!c.done))counterFrames++;
  }
  await done;assert.ok(counterFrames>0);
});

test('HUD actor positions follow native altitude and the displayed resource after a formation exchange',async()=>{
  const {view,snapshot}=await fixture(['013'],['001','002','003']);
  view.roster.find(a=>a.id==='002').party_slot_zero_based=3;
  for(const z of [0,-45,-120,20]){
    snapshot.actors.find(a=>a.id==='002').native_z_raw=z;
    view.draw(snapshot,0);
    assert.deepEqual(view.actorPositions()['002'],[590,290+z]);
    assert.equal(view.actorCursorHeight('002'),110);
    const positions=view.actorPositions();positions['002'][0]=0;
    assert.equal(view.actorPositions()['002'][0],590,'HUD callers cannot mutate the renderer position');
  }
  setActors(view,['013'],['001','002']);
  assert.deepEqual(view.actorPositions()['002'],[540,250],'new rosters discard the previous drawn frame');
});
