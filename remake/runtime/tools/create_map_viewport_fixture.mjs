// Controlled visual regression entry for the reported first visit to Kai.
// Keeps the source opening seed and conditions; only location/status are set.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {encodeSave} from '../web/core/world.mjs';
const root=new URL('../',import.meta.url),read=async path=>JSON.parse(await readFile(new URL(path,root),'utf8'));
const world=await read('web/data/opening_seed.json');
world.opening.status='complete';world.location={map_id:'M17029',x:648,y:632,direction:1};
const folder=new URL('evidence/map_viewport_20261021/',root);await mkdir(folder,{recursive:true});
await writeFile(new URL('controlled_kai_entry_save.json',folder),JSON.stringify(await encodeSave(world),null,2)+'\n');
await writeFile(new URL('fixture_scope.json',folder),JSON.stringify({
  scope:'Controlled first-visit royal-hall entry, imported through the real UI; not a continuous walk from the valley.',
  source:'web/data/opening_seed.json',changes:{opening_status:'complete',location:world.location},
  original_game_execution_observed:false,browser_storage_written:false
},null,2)+'\n');
