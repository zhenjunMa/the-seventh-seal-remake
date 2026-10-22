// User-authorized test save only: original game/saves and browser storage stay untouched.
import {readFile,writeFile} from 'node:fs/promises';
import {WorldStore,decodeSave,encodeSave} from '../web/core/world.mjs';
import {withItemQuantity,validateItemInstance} from '../web/core/equipment.mjs';
const runtime=new URL('../',import.meta.url),read=async name=>JSON.parse(await readFile(new URL(name,runtime),'utf8'));
const seed=await read('evidence/chapter_systems_home_save.json'),items=await read('web/data/items.json');
const world=new WorldStore(await decodeSave(seed)),before=world.snapshot(),added=[];
world.transact(draft=>{
  for(const id of [7,145,146,147,148,149,150,156,157,158,159,160,161]){
    const definition=items.definitions[String(id)];
    if(!definition?.initialization.deterministic||definition.type_raw_24!==3||definition.subtype_raw_25!==1)throw new Error('Test crystal lacks deterministic source instance');
    const row=withItemQuantity({instance_id:`socket-test:${id}`,id,name:definition.name,source_raw_hex:definition.initialized_raw_hex},id===156?3:2);
    validateItemInstance(row,definition);draft.inventory.push(row);added.push({id,name:row.name,quantity:row.quantity,source_sha256:definition.initialized_sha256});
  }
});
for(const key of ['source','party','equipment','flags','event_records','leader_id','money','encounters'])if(JSON.stringify(before[key])!==JSON.stringify(world.value[key]))throw new Error('Test setup unexpectedly changed '+key);
await writeFile(new URL('evidence/menu_socket_browser_20261014/crystal-test-save.json',runtime),JSON.stringify(await encodeSave(world.snapshot()),null,2)+'\n');
await writeFile(new URL('evidence/menu_socket_browser_20261014/crystal-test-fixture.json',runtime),JSON.stringify({purpose:'Authorized standalone menu test; does not write original game or browser storage.',seed:'chapter_systems_home_save.json',added,unchanged_fields:['source','party','equipment','flags','event_records','leader_id','money','encounters']},null,2)+'\n');
console.log(JSON.stringify({passed:true,added:added.length,ruby_quantity:3}));
