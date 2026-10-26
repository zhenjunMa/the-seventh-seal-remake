// Replay exported source-backed rules in our runtime. These checks do not run GAME.exe.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {EventRunner,validateProgram} from '../web/core/events.mjs';
import {MovementMap} from '../web/core/movement.mjs';
import {nativeMapMovement} from '../web/core/map_locomotion.mjs';
import {chapterRouteExits} from '../web/core/map_connections.mjs';
import {runtimeContent,storyBindings} from '../web/core/content_registry.mjs';

const runtime=new URL('../',import.meta.url),root=new URL('../../../',import.meta.url);
const read=async path=>JSON.parse(await readFile(new URL(path,runtime),'utf8'));
const hash=data=>createHash('sha256').update(data).digest('hex');
const seed=await read('web/data/world_seed.json'),catalog=await read('web/data/catalog.json');
const [event]=await read('web/data/events.json');
const source=await readFile(new URL(event.source.path,root));
const checks=[];
test('real detective source bytes, first/repeat state, map round trip and save reload',async()=>{
  assert.equal(hash(source),event.source.sha256);
  validateProgram(event);
  const decoder=new TextDecoder('gbk');
  for(const command of event.program.filter(c=>c.op==='say')){
    const start=command.source.offset,end=source.indexOf(0,start);
    assert.ok(end>=start&&end<start+1592);
    assert.equal(command.text,decoder.decode(source.subarray(start,end)));
  }
  const mutate=event.program.find(c=>c.op==='set_flag_bit');
  const record=mutate.source.record_offset;
  assert.equal(source[record+0x23],0);
  assert.equal(source.readUInt32LE(record+0x27),0); // zero selects current map's flag index
  assert.equal(source.readUInt32LE(record+0x2b),3); // one-based bit
  const world=new WorldStore(seed,catalog.maps.map(m=>m.id));
  world.transact(next=>{next.location={map_id:'M01030',x:1680,y:480,direction:3};});
  const spoken=[],logs=[];
  const runner=new EventRunner({world,say:async(speaker,text)=>{
    const command=event.program.find(c=>c.op==='say'&&c.text===text);
    spoken.push(command.source.record_id);
    if(command.source.record_id===25)assert.ok(world.value.flags[3]&4,'native entry mutation precedes dialogue25');
  },wait:async()=>{},log:entry=>logs.push(entry)});
  await runner.run(event);assert.deepEqual(spoken,[19,20,21,22,23,24,25]);assert.ok(world.value.flags[3]&4);
  const firstFlags=world.snapshot().flags;
  world.transact(next=>{next.location={map_id:'M01010',x:1152,y:1248,direction:5};});
  assert.deepEqual(world.value.flags,firstFlags);
  world.transact(next=>{next.location={map_id:'M01030',x:1680,y:480,direction:3};});
  const restored=new WorldStore(await decodeSave(await encodeSave(world.snapshot()),catalog.maps.map(m=>m.id)),catalog.maps.map(m=>m.id));
  spoken.length=0;const repeat=new EventRunner({world:restored,say:async(speaker,text)=>spoken.push(event.program.find(c=>c.op==='say'&&c.text===text).source.record_id),wait:async()=>{}});
  await repeat.run(event);assert.deepEqual(spoken,[26]);assert.deepEqual(restored.value.flags,firstFlags);
  for(const index of [426,107,5]){
    const blocked=new WorldStore(seed,catalog.maps.map(m=>m.id));
    blocked.transact(next=>{if(index===5){next.flags[3]|=4;next.flags[5]|=0x40000000;}else next.flags[index]|=1;});
    const before=blocked.snapshot();let said=false;
    await assert.rejects(new EventRunner({world:blocked,say:async()=>{said=true;},wait:async()=>{}}).run(event),/尚未恢复/);
    assert.equal(said,false);assert.deepEqual(blocked.snapshot(),before);
  }
  checks.push({name:'source-backed-detective-replay',passed:true,first:[19,20,21,22,23,24,25],repeat:[26],flag_index:3,mask:4,unknown_branches_rejected:[83,65,28]});
});
test('real map descriptors, entry markers and runtime coverage gates',async()=>{
  const [story,resources]=await Promise.all(['chapter_story','chapter_map_resources'].map(name=>read(`web/data/${name}.json`)));
  const blockedNativeLandings=[];let physicalExits=0,registeredTriggers=0;
  for(const id of ['M01010','M01030'])assert.ok(catalog.maps.some(map=>map.id===id),`${id} original slice retained`);
  for(const item of catalog.maps){
    const scene=await read('web/'+item.path),bytes=await readFile(new URL(scene.source.path,root));
    assert.equal(hash(bytes),scene.source.sha256);
    // The formal map controller overlays current source physical exits and
    // registered story triggers on maps retained by legacy asset producers.
    const extraExits=[...(resources.exits_by_map[scene.id]??[]),...chapterRouteExits(scene.id,story,resources,runtimeContent)];
    const exits=[...(scene.exits??[]).filter(exit=>!extraExits.some(extra=>extra.id===exit.id)),...extraExits];
    const triggers=(resources.trigger_regions[scene.id]??[]).filter(row=>storyBindings(scene.id).triggers.includes(row.id));
    const readyCells=new Set([...exits.filter(exit=>exit.state==='ready').flatMap(e=>e.cells.map(c=>`${c.x},${c.y}`)),
      ...triggers.flatMap(trigger=>trigger.cells.map(c=>`${c.x},${c.y}`))]);
    const nativeMovement=nativeMapMovement(scene.movement,story.maps[scene.id]);
    const movement=new MovementMap({...nativeMovement,triggers:nativeMovement.triggers.map(t=>({...t,path_gate:!readyCells.has(`${t.x},${t.y}`)}))});
    const recordBytes=bytes.readUInt32LE(0x18)===1?0x42:0x2b;
    const checkExitCells=exit=>{
      assert.ok(exit.cells.some(cell=>!movement.cell(cell.x,cell.y).blocked),`${scene.id} exit${exit.id} has a usable source cell`);
      for(const cell of exit.cells){
        const hit=movement.cell(cell.x,cell.y),terrain=scene.movement.terrain_rows[cell.y][cell.x];
        assert.equal(hit.blocked,terrain==='1',`${scene.id} exit${exit.id} keeps native terrain`);
        if(hit.blocked)assert.equal(hit.reason,'terrain');
      }
    };
    for(const exit of exits){
      if(exit.kind==='world-map-event'){
        const q=exit.source.offset;assert.equal(bytes[q],2);assert.equal(bytes.readUInt32LE(q+0x26),exit.record_id);
        checkExitCells(exit);continue;
      }
      const q=exit.source.descriptor_offset;
      assert.equal(bytes[q],0);
      assert.equal(bytes.subarray(q+0x11,q+0x26).toString('ascii').split('\0')[0].toUpperCase().replace('.DAT',''),exit.target_map);
      assert.equal(recordBytes===0x42?bytes.readUInt32LE(q+0x26):bytes[q+0x26],exit.source.target_entry_marker);
      assert.equal(recordBytes===0x42?bytes.readUInt32LE(q+0x2a):bytes[q+0x27],exit.source.entry_sort_code);
      checkExitCells(exit);
      const target=await read(`web/data/maps/${exit.target_map.toLowerCase()}.json`);
      const targetBytes=await readFile(new URL(target.source.path,root));
      const cell=exit.entry.cell_y*target.movement.width+exit.entry.cell_x;
      assert.equal(targetBytes[0x172+cell*64+0x21],exit.source.target_entry_marker);
      const targetMovement=new MovementMap(nativeMapMovement(target.movement,story.maps[exit.target_map]));
      const terrain=targetBytes[0x172+cell*64+0x20];
      assert.equal(target.movement.terrain_rows[exit.entry.cell_y][exit.entry.cell_x],String(terrain));
      assert.equal(targetMovement.at(exit.entry.x,exit.entry.y).blocked,terrain===1);
      assert.equal(targetMovement.validEntry(exit.entry.x,exit.entry.y),true);
      if(terrain===1)blockedNativeLandings.push({from:scene.id,to:exit.target_map,marker:exit.source.target_entry_marker,x:exit.entry.x,y:exit.entry.y});
      physicalExits++;
    }
    for(const trigger of triggers){
      const sourceDescriptor=story.maps[scene.id].descriptors.find(row=>row.id===trigger.id);assert.ok(sourceDescriptor);
      assert.equal(sourceDescriptor.state_raw,2);assert.ok(runtimeContent.maps[scene.id].triggers.includes(trigger.id));
      for(const cell of trigger.cells){
        assert.equal(bytes.readUInt32LE(0x172+(cell.y*scene.movement.width+cell.x)*64+0x38),trigger.id);
        assert.equal(movement.cell(cell.x,cell.y).blocked,scene.movement.terrain_rows[cell.y][cell.x]==='1');
      }
      registeredTriggers++;
    }
    for(const t of scene.movement.triggers){if(!readyCells.has(`${t.x},${t.y}`))assert.equal(movement.cell(t.x,t.y).blocked,true);}
  }
  assert.deepEqual(blockedNativeLandings,[{from:'M70020',to:'M70010',marker:2,x:288,y:288}]);
  checks.push({name:'source-backed-map-entry-and-coverage-guard',passed:true,maps:catalog.maps.map(m=>m.id),ready_exits:catalog.scope.ready_exits,
    physical_exits_checked:physicalExits,registered_story_triggers_checked:registeredTriggers,blocked_native_landings:blockedNativeLandings});
});
test.after(async()=>{
  await writeFile(new URL('evidence/current_slice_verification.json',runtime),JSON.stringify({schema:'seventh-seal-source-slice-verification',version:1,checks,
    authority:'original resource bytes plus recovered static rules replayed by the reconstruction',original_game_execution_observed:false,
    source_sha256:event.source.sha256,seed_sha256:hash(await readFile(new URL('web/data/world_seed.json',runtime)))},null,2));
});
