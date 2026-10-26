import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nativeMapMovement} from '../web/core/map_locomotion.mjs';
import {MovementMap} from '../web/core/movement.mjs';

const read=name=>JSON.parse(readFileSync(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));

test('M70020 returns to the exact blocked M70010 marker; terrain remains blocked to ordinary paths',()=>{
  const source=readFileSync(new URL('../../../Map/m70010.dat',import.meta.url));
  const map=read('maps/m70010'),story=read('chapter_story'),table=story.maps.M70010;
  const entry=read('chapter_map_resources').exits_by_map.M70020.find(exit=>exit.id===1);
  const offset=0x172+(18*66+18)*64;
  assert.equal(source[offset+0x21],2);
  assert.equal(source[offset+0x20],1);
  assert.deepEqual(entry.entry,{x:288,y:288,direction:1,cell_x:18,cell_y:18,native_x:144,native_y:144});
  const movement=new MovementMap(nativeMapMovement(map.movement,table));
  assert.equal(movement.at(288,288).blocked,true);
  assert.equal(movement.validEntry(288,288),true);
  assert.equal(movement.validEntry(0,0),false);
  const leave=movement.move(288,288,0,16);
  assert.equal(leave.blocked,false);
  assert.deepEqual([leave.x,leave.y],[288,304]);
  assert.equal(movement.move(288,304,0,-16).blocked,true);
  assert.equal(movement.move(288,288,0,-16).blocked,true);
  assert.equal(movement.move(0,0,0,16).moved,false);
  assert.equal(map.movement.terrain_rows[18][18],'1');
});
