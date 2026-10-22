// Independent controlled saves, never edit an original or browser save.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {WorldStore,decodeSave,encodeSave} from '../web/core/world.mjs';
const base=new URL('../',import.meta.url),dir=new URL('evidence/battle_lifecycle_20261015/',base);
const seed=JSON.parse(await readFile(new URL('evidence/battle_alignment_20261015/controlled_entry_save.json',base),'utf8'));
await mkdir(dir,{recursive:true});
for(const [name,hp,learned]of [['entry',900,false],['revival',0,true],['incoming_death',1,true]]){
 const world=new WorldStore(await decodeSave(seed));
 world.transact(draft=>{const kai=draft.party.find(r=>r.id==='002');kai.hp.current=hp;const caster=draft.party.find(r=>r.id==='001');if(learned)caster.skill_progress={version:1,learned_indices:[43]};});
 await writeFile(new URL(`${name}_save.json`,dir),JSON.stringify(await encodeSave(world.snapshot()),null,2)+'\n',{flag:'wx'});
}
await writeFile(new URL('fixture.json',dir),JSON.stringify({kind:'independent-controlled-lifecycle-fixtures',source:'evidence/battle_alignment_20261015/controlled_entry_save.json',changes:{entry:'Kai raw_hp=900; source learned flags untouched',revival:'Kai raw_hp=0 and explicit saved learned index43 on001',incoming_death:'Kai raw_hp=1 and explicit saved learned index43 on001'},natural_unlock_claimed:false,natural_rng_sequence_claimed:false,original_inputs_modified:false,browser_progress_modified:false},null,2)+'\n',{flag:'wx'});
console.log('Created independent lifecycle fixtures');
