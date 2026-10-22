// Explicit source-seed entries for UI-only NPC behavior verification.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {encodeSave} from '../web/core/world.mjs';
import {MovementMap} from '../../prototype/web/movement.mjs';
const base=new URL('../',import.meta.url),read=async name=>JSON.parse(await readFile(new URL('web/data/'+name+'.json',base),'utf8'));
const seed=await read('opening_seed'),map=await read('maps/m17020'),movement=new MovementMap(map.movement);
const folder=new URL('evidence/npc_motion_20261021/',base);await mkdir(folder,{recursive:true});
for(const [name,at] of Object.entries({valley:{x:1092,y:986,direction:3},talk:{x:944,y:960,direction:1}})){
  if(movement.at(at.x,at.y).blocked)throw new Error('Fixture position is blocked');
  const world=structuredClone(seed);world.opening.status='complete';world.location={map_id:'M17020',...at};
  await writeFile(new URL('controlled_'+name+'_save.json',folder),JSON.stringify(await encodeSave(world),null,2)+'\n');
}
