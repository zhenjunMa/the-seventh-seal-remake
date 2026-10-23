// UI-only entries. These are explicit relocations from a new-game seed, not
// evidence of a continuous walk through the chapter or original execution.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {encodeSave} from '../web/core/world.mjs';
import {MovementMap} from '../web/core/movement.mjs';
const root=new URL('../',import.meta.url),read=async name=>JSON.parse(await readFile(new URL('web/data/'+name+'.json',root),'utf8'));
const seed=await read('opening_seed'),folder=new URL('evidence/map_effects_20261021/',root);await mkdir(folder,{recursive:true});
const positions={entrance:{map_id:'M17010',x:1072,y:1168,direction:3},
  savepoint:{map_id:'M17010',x:1280,y:1440,direction:1},
  forest_left:{map_id:'M70010',x:256,y:592,direction:5},
  forest_right:{map_id:'M70010',x:784,y:688,direction:1}};
for(const [name,position] of Object.entries(positions)){
  const data=await read('maps/'+position.map_id.toLowerCase()),movement=new MovementMap(data.movement);
  if(movement.at(position.x,position.y).blocked)throw new Error(name+': fixture position is blocked');
  const world=structuredClone(seed);world.opening.status='complete';world.location=position;
  await writeFile(new URL('controlled_'+name+'_save.json',folder),JSON.stringify(await encodeSave(world),null,2)+'\n');
}
