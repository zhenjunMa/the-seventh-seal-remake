// Original terrain identity and complete route checks belong to source audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,webcrypto} from 'node:crypto';
import {MovementMap} from '../web/core/movement.mjs';
import {nativeMapMovement} from '../web/core/map_locomotion.mjs';
import {worldMapEntry} from '../web/core/map_connections.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {chapterRoleFromDefinition} from '../web/core/chapter.mjs';
import {validateChapterAnimation} from '../web/core/chapter_animation.mjs';

globalThis.crypto??=webcrypto;
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-4,`${actual} != ${expected}`);

test('source armor-shop diagonal approach keeps its ray while retaining the original contact endpoint and tangent slide',()=>{
  const data=JSON.parse(readFileSync(new URL('../web/data/maps/m01063.json',import.meta.url),'utf8'));
  const raw=readFileSync(new URL('../../../Map/m01063.dat',import.meta.url)),width=raw.readUInt32LE(0x146);
  assert.equal(createHash('sha256').update(raw).digest('hex'),data.movement.source_sha256);
  for(const [x,y,value]of [[22,14,0],[23,15,0],[22,15,1],[23,14,1]])
    assert.equal(raw[0x172+(y*width+x)*64+0x20],value);
  const map=new MovementMap(data.movement),result=map.moveAndSlide(360,232,80,80);
  near(result.x,379.99999);near(result.y,268.99999);
  assert.equal(result.segments[0].dx,result.segments[0].dy,'skin must not tilt the source diagonal approach ray');
  assert.equal(map.at(368,240).blocked,false);
});

test('real forest point contacts accept off-centre continuous diagonal input at 30/60/120Hz in both directions',()=>{
  const data=JSON.parse(readFileSync(new URL('../web/data/maps/m70060.json',import.meta.url),'utf8'));
  const raw=readFileSync(new URL('../../../Map/m70060.dat',import.meta.url)),width=raw.readUInt32LE(0x146);
  assert.equal(createHash('sha256').update(raw).digest('hex'),data.movement.source_sha256);
  const map=new MovementMap(data.movement);
  for(const [from,to]of [[[23,16],[22,15]],[[22,15],[23,16]]]){
    assert.equal(raw[0x172+(from[1]*width+from[0])*64+0x20],0);
    assert.equal(raw[0x172+(to[1]*width+to[0])*64+0x20],0);
    for(const hz of [30,60,120])for(const offset of [[0,0],[3,-2],[-3,2],[2.7,4.1]]){
      let at={x:from[0]*16+8+offset[0],y:from[1]*16+8+offset[1]},passed=false;
      const dx=Math.sign(to[0]-from[0]),dy=Math.sign(to[1]-from[1]);
      for(let frame=0;frame<hz;frame++){
        at=map.moveAndSlide(at.x,at.y,dx*129/Math.SQRT2/hz,dy*129/Math.SQRT2/hz);
        assert.notEqual(map.at(at.x,at.y).reason,'terrain');
        if(map.at(at.x,at.y).x===to[0]&&map.at(at.x,at.y).y===to[1]){passed=true;break;}
      }
      assert.ok(passed,`${hz}Hz offset${offset}: ${from} -> ${to}`);
    }
  }
});

test('continuous small steps traverse the forest/lake routes and armor-shop entry to its diagonal passage without altering source terrain',()=>{
  const read=name=>JSON.parse(readFileSync(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
  const resources=read('chapter_map_resources'),story=read('chapter_story'),definition=read('runtime_content'),worldMap=read('world_map');
  const physical=(id,target)=>resources.exits_by_map[id].find(row=>row.target_map===target);
  const lakeEntry=worldMapEntry({},worldMap.areas[0].destinations[2],story);
  const firstLake=worldMapEntry({},{map_id:'M71011',entry_marker:1,sort_code:0},story);
  const links=[
    {id:'M70060',start:physical('M70040','M70060').entry,trigger:2},
    {id:'M71014',start:lakeEntry,trigger:2},
    {id:'M71011',start:firstLake,trigger:physical('M71011','M71012').id},
    {id:'M71012',start:physical('M71011','M71012').entry,trigger:physical('M71012','M71012-1').id},
    {id:'M71012-1',start:physical('M71012','M71012-1').entry,trigger:physical('M71012-1','M71012-2').id},
    {id:'M71012-2',start:physical('M71012-1','M71012-2').entry,trigger:physical('M71012-2','M71013').id},
    {id:'M71013',start:physical('M71012-2','M71013').entry,trigger:1},
    {id:'M01063',start:physical('M01060','M01063').entry,target_cell:{x:22,y:14}}
  ];
  for(const link of links){
    const data=read('maps/'+link.id.toLowerCase()),raw=readFileSync(new URL(`../../../Map/${link.id.toLowerCase()}.dat`,import.meta.url));
    assert.equal(createHash('sha256').update(raw).digest('hex'),data.movement.source_sha256);
    const sourceRows=[...data.movement.terrain_rows],ready=new Set([...(resources.exits_by_map[link.id]??[]).map(row=>row.id),...(definition.maps[link.id]?.triggers??[])]);
    const movement={...nativeMapMovement(data.movement,story.maps[link.id]),triggers:data.movement.triggers.map(row=>({...row,path_gate:!ready.has(row.id)}))};
    const map=new MovementMap(movement),npcs=(resources.npcs_by_map[link.id]??[]).filter(row=>!row.hidden),obstacles=map.actorObstacles(npcs);
    const goal=new Set(link.target_cell?[`${link.target_cell.x},${link.target_cell.y}`]:data.movement.triggers.filter(row=>row.id===link.trigger).map(row=>`${row.x},${row.y}`));
    const origin={x:Math.floor(link.start.x/16),y:Math.floor(link.start.y/16)},queue=[origin],previous=new Map([[`${origin.x},${origin.y}`,null]]);let found;
    for(let cursor=0;cursor<queue.length;cursor++){
      const at=queue[cursor];if(goal.has(`${at.x},${at.y}`)){found=at;break;}
      for(const [dx,dy]of [[0,-1],[1,0],[0,1],[-1,0],[-1,-1],[1,-1],[1,1],[-1,1]]){
        const x=at.x+dx,y=at.y+dy,key=`${x},${y}`,cell=map.cell(x,y);
        if(previous.has(key)||cell.blocked||cell.trigger&&cell.trigger.id!==link.trigger&&!(definition.maps[link.id]?.triggers??[]).includes(cell.trigger.id))continue;
        if(npcs.some(npc=>Math.abs(npc.x-(x*16+8))<14&&Math.abs(npc.y-(y*16+8))<12))continue;
        previous.set(key,at);queue.push({x,y});
      }
    }
    assert.ok(found,`${link.id} original target has no source path`);const path=[];
    while(found){path.push(found);found=previous.get(`${found.x},${found.y}`);}path.reverse();
    // Advance only through continuous keyboard-sized vectors. No teleport,
    // tile-centre snap or world/terrain mutation is used between waypoints.
    for(const hz of [30,60,120])for(const speed of [129,250]){
      let at={x:link.start.x,y:link.start.y},frames=0;
      for(const target of path.slice(1)){
        let attempts=0;
        while(map.at(at.x,at.y).x!==target.x||map.at(at.x,at.y).y!==target.y){
          assert.ok(++attempts<hz*3,`${link.id} ${hz}Hz speed${speed} stuck at${at.x},${at.y} toward${target.x},${target.y}`);
          const dx=Math.sign(target.x*16+8-at.x),dy=Math.sign(target.y*16+8-at.y),length=Math.hypot(dx,dy);
          at=map.moveAndSlide(at.x,at.y,dx/length*speed/hz,dy/length*speed/hz,{obstacles});frames++;
          assert.notEqual(map.at(at.x,at.y).reason,'terrain',link.id);
        }
      }
      if(link.target_cell)assert.deepEqual({x:map.at(at.x,at.y).x,y:map.at(at.x,at.y).y},link.target_cell,`${link.id} target at ${hz}Hz`);
      else assert.equal(map.at(at.x,at.y).trigger?.id,link.trigger,`${link.id} target at ${hz}Hz`);
      assert.ok(frames>0);
    }
    assert.deepEqual(data.movement.terrain_rows,sourceRows);
    for(let y=0;y<map.height;y++)for(let x=0;x<map.width;x++)assert.equal(Number(sourceRows[y][x]),raw[0x172+(y*map.width+x)*64+0x20],link.id);
  }
});

test('actual source ANM bed placement saves and restores unchanged, permits escape and never opens ordinary terrain entry',async()=>{
 const read=name=>JSON.parse(readFileSync(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
 const map=read('maps/m03039'),packed=read('story/maps/m03039'),program=packed.programs['m03039-1'];
 validateChapterAnimation(program);
 const original=readFileSync(new URL('../../../Animate/m03039-1.anm',import.meta.url)),command=program.commands[26];
 assert.equal(createHash('sha256').update(original).digest('hex'),program.source.sha256);
 assert.equal(original.subarray(command.source.offset,command.source.offset+74).toString('hex'),command.raw_hex);
 assert.deepEqual([command.opcode,command.u32_plus1,command.u32_plus5,command.u32_plus13,command.u32_plus17],[35,0,3,197,89]);
 const dat=readFileSync(new URL('../../../Map/m03039.dat',import.meta.url)),cell=0x172+(11*map.movement.width+24)*64;
 assert.equal(dat[cell+0x20],1);assert.equal(new MovementMap(map.movement).validEntry(394,178),false);
 const prepare=()=>new MovementMap(nativeMapMovement(map.movement,packed.chapter,packed.programs));
 const movement=prepare();assert.equal(movement.at(394,178).reason,'terrain');assert.equal(movement.validEntry(394,178),true);
 const initial=read('opening_seed');initial.opening.status='complete';initial.leader_id='004';
 initial.party=[chapterRoleFromDefinition(initial.source.role_definitions['004'])];initial.location={map_id:'M03039',x:394,y:178,direction:0};
 const world=new WorldStore(initial),loaded=await decodeSave(await encodeSave(world.snapshot()));
 assert.deepEqual(loaded.location,initial.location);assert.equal(prepare().validEntry(loaded.location.x,loaded.location.y),true);
 for(const [dx,dy]of [[16,0],[0,24]]){
  const left=movement.moveAndSlide(394,178,dx,dy);assert.equal(left.moved,true);assert.equal(movement.at(left.x,left.y).blocked,false);
 }
 const returnToBed=movement.moveAndSlide(410,178,-16,0);assert.equal(returnToBed.blocked,true);assert.ok(returnToBed.x>=400);
 assert.equal(movement.validEntry(344,136),false,'no source player placement makes this other terrain1 cell an entrance');
 assert.equal(new MovementMap(nativeMapMovement(map.movement,packed.chapter)).validEntry(394,178),false,'without the verified ANM the bed cell remains inadmissible');
 assert.equal(map.movement.terrain_rows[11][24],'1','derivation never rewrites source terrain');
});
