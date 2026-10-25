import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ChapterAnimationRunner,validateChapterAnimation} from '../web/core/chapter_animation.mjs';
import {ChapterRunner} from '../web/core/chapter.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {planRouteExit} from '../web/core/route.mjs';
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
