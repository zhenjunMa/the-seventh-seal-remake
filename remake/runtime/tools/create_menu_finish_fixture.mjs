// Standalone UI fixture: no original save or browser progress is written.
import {readFile,writeFile,access} from 'node:fs/promises';
import {WorldStore,decodeSave,encodeSave} from '../web/core/world.mjs';
import {withItemQuantity,validateItemInstance} from '../web/core/equipment.mjs';
const runtime=new URL('../',import.meta.url),read=async path=>JSON.parse(await readFile(new URL(path,runtime),'utf8'));
const output=new URL('evidence/menu_finish_browser_20261014/menu-test-save.json',runtime);
try{await access(output);throw new Error('UI fixture already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
const seed=await read('evidence/menu_socket_browser_20261014/crystal-test-save.json'),items=await read('web/data/items.json');
const world=new WorldStore(await decodeSave(seed)),before=world.snapshot(),added=[];
const heads=Object.values(items.definitions).filter(d=>d.type_raw_24===2&&d.subtype_raw_25===1&&d.id!==61).slice(0,10).map(d=>d.id);
const ids=[...heads,61,3,77,4,92,5,107,124,8,12];
world.transact(draft=>{
  for(const id of ids){
    const definition=items.definitions[String(id)];
    if(![2,5].includes(definition?.type_raw_24)||!definition.initialized_raw_hex)throw new Error('Test item lacks original initialization template');
    const row=withItemQuantity({instance_id:`menu-finish-test:${id}`,id,name:definition.name,source_raw_hex:definition.initialized_raw_hex},1);
    validateItemInstance(row,definition);draft.inventory.push(row);
    added.push({id,name:row.name,subtype:definition.subtype_raw_25,source_sha256:definition.initialized_sha256});
  }
});
const unchanged=['source','party','equipment','flags','event_records','leader_id','money','encounters'];
for(const key of unchanged)if(JSON.stringify(before[key])!==JSON.stringify(world.value[key]))throw new Error('Fixture changed '+key);
await writeFile(output,JSON.stringify(await encodeSave(world.snapshot()),null,2)+'\n');
await writeFile(new URL('evidence/menu_finish_browser_20261014/menu-test-fixture.json',runtime),JSON.stringify({
  purpose:'Authorized isolated menu fixture; original source initialization templates with one quantity; no acquisition flow is claimed.',
  seed:'menu_socket_browser_20261014/crystal-test-save.json',added,unchanged_fields:unchanged,
  raw_initialization_boundary:'Definition-derived templates represent source minima for testing; randomized formal item acquisition remains separate.'},null,2)+'\n');
console.log(JSON.stringify({passed:true,added:added.length,inventory:world.value.inventory.length}));
