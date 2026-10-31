import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ChapterAnimationRunner,validateChapterAnimation} from '../web/core/chapter_animation.mjs';
import {ChapterRunner} from '../web/core/chapter.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {planRouteExit} from '../web/core/route.mjs';
import {inspectContentReadiness} from '../web/core/content_readiness.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
const story=JSON.parse(await readFile(new URL('../web/data/chapter_story.json',import.meta.url)));
const seed=JSON.parse(await readFile(new URL('../web/data/opening_seed.json',import.meta.url)));
const route=JSON.parse(await readFile(new URL('../web/data/route_events.json',import.meta.url)));
const maps=['M72061','M17020','M17029','M17026','M17010','M70010'];
const hooks=()=>Object.fromEntries(['map','actor','move','camera','wait'].map(key=>[key,async()=>{}]));
test('each bounded chapter animation matches every original byte and rejects an unsupported opcode',async()=>{
  for(const program of Object.values(story.programs)){
    validateChapterAnimation(program);
    const raw=await readFile(new URL(program.source.path,new URL('../../../',import.meta.url)));
    assert.equal(createHash('sha256').update(raw).digest('hex'),program.source.sha256);
    for(const c of program.commands)assert.equal(c.raw_hex,raw.subarray(c.source.offset,c.source.offset+74).toString('hex'));
  }
  // Leave map-loading commands intact so the source-context contract remains
  // valid and this negative case reaches the unsupported-opcode check.
  const bad=structuredClone(story.programs['m17029-1']);bad.commands.find(command=>command.opcode!==10).opcode=254;
  assert.throws(()=>validateChapterAnimation(bad),/未支持/);
});
test('source王厅 animation preserves arrival facing0, nested TLK24 and native actor1 join in source order',async()=>{
  const next=structuredClone(seed);next.opening.status='complete';next.location={map_id:'M17029',x:640,y:592,direction:4};
  const world=new WorldStore(next,maps),trace=[];
  const runner=new ChapterRunner({world,data:story,say:async({record})=>trace.push(`say${record.id}`),
    animate:async({program,draft,runTlk,joinActor})=>{
      const h=hooks();h.move=async p=>trace.push(`move${p.actor}:${p.arrivalFacingRaw}`);
      const result=await new ChapterAnimationRunner({program,hooks:h,runTlk,joinActor:async p=>{
        assert.equal(draft.flags[51]&1,1);trace.push('join');await joinActor(p);
      },initialLocation:draft.location}).run();draft.location={...result.location,direction:4};
    }});
  await runner.runTlk({mapId:'M17029',recordId:25});
  assert.deepEqual(world.value.party.map(p=>p.id),['001','002']);assert.equal(world.value.flags[51]&1,1);
  assert.deepEqual(world.location,{map_id:'M17029',x:596,y:532,direction:4});
  assert.ok(trace.includes('move1:0'));assert.ok(trace.indexOf('say24')<trace.indexOf('join'));
  assert.ok(trace.indexOf('join')<trace.indexOf('say26'));
  world.transact(draft=>{draft.location={map_id:'M17026',x:336,y:192,direction:0};});
  await runner.runObject({mapId:'M17026',objectIndex:9});
  assert.deepEqual(world.value.inventory.map(i=>[i.id,i.quantity]),[[61,1],[51,1],[4,2]]);
  assert.equal(world.value.event_records[48][9].slice(0,2),'03');
  const before=world.snapshot();await runner.runObject({mapId:'M17026',objectIndex:9});assert.deepEqual(world.snapshot(),before);
  assert.equal(planRouteExit(world.value,'M17010',48,route).commands.at(-1).mode,0);
});
test('animation hook failure aborts pending moves and retains the caller world',async()=>{
  const program=story.programs['m17029-1'],h=hooks(),world=new WorldStore(seed,maps),before=world.snapshot();
  h.move=async()=>{throw new Error('move renderer unavailable');};
  const runner=new ChapterAnimationRunner({program,hooks:h,runTlk:async()=>{},joinActor:async()=>{},
    initialLocation:{map_id:'M17029',x:640,y:592,direction:4}});
  await assert.rejects(runner.run(),/move renderer unavailable/);assert.equal(runner.phase,'failed');assert.deepEqual(world.snapshot(),before);
});
test('kind1 hands TLK to the complete source ANM and its explicit callback enters the two temple battles exactly once',async()=>{
  for(const mapId of ['M72063','M72062-2']){
    const next=structuredClone(seed);next.opening.status='complete';next.location={map_id:mapId,x:640,y:480,direction:0};
    const world=new WorldStore(next),before=world.snapshot(),records=[],battles=[],completed=[];
    const runner=new ChapterRunner({world,data:story,say:async()=>{},log:row=>{if(row.type==='chapter-record')records.push(row.recordId);},
      battle:async({group})=>{battles.push(group);assert.deepEqual(world.snapshot(),before);return {outcome:'victory'};},
      animate:async({program,draft,runTlk})=>{
        const result=await new ChapterAnimationRunner({program,hooks:hooks(),runTlk,initialLocation:draft.location}).run();
        completed.push(program.commands.length);draft.location={...result.location};
      }});
    const result=await runner.runTlk({mapId,recordId:1});
    assert.deepEqual(result.traversed,[1,2]);assert.deepEqual(records,[1,2,3]);assert.equal(battles.length,1);
    assert.equal(battles[0].stage,'stage05.scn');assert.equal(world.value.flags[story.maps[mapId].map_flag_index]&1,1);
    assert.deepEqual(completed,[mapId==='M72063'?12:14]);assert.equal(world.value.revision,before.revision+1);
  }
});
test('finishing kind1 presentation alone never resumes its stored next, while a source ANM14 callback still can',async()=>{
  for(const callback of [false,true]){
    const next=structuredClone(seed);next.opening.status='complete';next.location={map_id:'M01031',x:640,y:480,direction:0};
    const world=new WorldStore(next),lines=[];
    const runner=new ChapterRunner({world,data:story,say:async({record})=>lines.push(record.id),
      animate:async({program,mapId,runTlk})=>{
        assert.equal(program.id,'m01031-1');
        const command=program.commands.find(row=>row.opcode===14);assert.equal(command.u32_plus5,9);
        if(callback)await runTlk({mapId,recordId:command.u32_plus5});
      }});
    const result=await runner.runTlk({mapId:'M01031',recordId:8});
    assert.deepEqual(result.traversed,[8]);assert.deepEqual(lines,callback?[9]:[]);
    assert.equal(story.maps.M01031.records.find(row=>row.id===8).next,9,'retain the source continuation bytes');
    assert.ok(runner.data.flows['M01031:tlk'].entries[9],'retain the independent callback entry');
  }
});
test('readiness retains ordinary branches and explicit ANM14 callbacks without inventing kind1 continuation',async()=>{
  const resources=JSON.parse(await readFile(new URL('../web/data/chapter_map_resources.json',import.meta.url)));
  for(const [mapId,slot,recordId,reachable]of [['M01040',20,52,false],['M01040',20,33,true],['M01031',10,9,true]]){
    const table=structuredClone(story.maps[mapId]),data={...story,maps:{...story.maps,[mapId]:table}};
    const content={...runtimeContent,maps:{[mapId]:{...runtimeContent.maps[mapId],entry_record:0,setup_record:0,triggers:[],objects:[],rests:[],routes:[],npcs:[slot]}}};
    assert.equal(inspectContentReadiness(content,data,resources).passed,true);
    table.records.find(row=>row.id===recordId).mutation_type=99;
    const report=inspectContentReadiness(content,data,resources);
    assert.equal(report.errors.some(row=>row.record_id===recordId&&/99/.test(row.message)),reachable,`${mapId}:${recordId}`);
  }
});
