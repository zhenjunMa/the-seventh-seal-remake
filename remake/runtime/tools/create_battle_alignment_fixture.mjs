// Independent UI scene; no original input or existing browser save is changed.
import {readFile,writeFile} from 'node:fs/promises';
import {WorldStore,decodeSave,encodeSave} from '../web/core/world.mjs';
import {restorePartyAfterRest} from '../web/core/recovery.mjs';
const root=new URL('../',import.meta.url),read=async p=>JSON.parse(await readFile(new URL(p,root),'utf8'));
const world=new WorldStore(await decodeSave(await read('evidence/chapter_systems_win_save.json')));
const before=world.snapshot();let resources;
world.transact(draft=>{resources=restorePartyAfterRest(draft);});
const output='evidence/battle_alignment_20261015/independent_scene_save.json';
await writeFile(new URL(output,root),JSON.stringify(await encodeSave(world.snapshot()),null,2)+'\n');
await writeFile(new URL('evidence/battle_alignment_20261015/fixture.json',root),JSON.stringify({
  kind:'independent-browser-fixture',seed:'evidence/chapter_systems_win_save.json',
  resources,location:world.location,changes:'Source rest resource restoration only; existing forest location, source equipment, skills, inventory and flags retained.',
  natural_acquisition_or_story_replayed:false,existing_browser_save_modified:false,
  unchanged:['source','inventory','equipment','flags','event_records','money','encounters'].every(k=>JSON.stringify(before[k])===JSON.stringify(world.value[k]))},null,2)+'\n');
console.log(output);
// A separate explicitly controlled entry makes repeatable UI checks immediate.
// The ordinary seed above remains available for unmodified encounter replay.
let state=world.value.encounters.rng_state,steps=0;
for(;steps<10000;steps++){const next=(Math.imul(state,214013)+2531011)>>>0;if(((next>>>16)&32767)%1000>=998)break;state=next;}
if(steps===10000)throw new Error('No controlled encounter seed found');
world.transact(draft=>{draft.encounters.rng_state=state;draft.encounters.counters[draft.leader_id]=40;draft.encounters.remainders[draft.leader_id]=0;});
await writeFile(new URL('evidence/battle_alignment_20261015/controlled_entry_save.json',root),JSON.stringify(await encodeSave(world.snapshot()),null,2)+'\n');
await writeFile(new URL('evidence/battle_alignment_20261015/controlled_entry_fixture.json',root),JSON.stringify({kind:'controlled-encounter-entry',rng_draws_skipped:steps,counter:40,normal_rng_sequence_claimed:false,original_inputs_modified:false},null,2)+'\n');
