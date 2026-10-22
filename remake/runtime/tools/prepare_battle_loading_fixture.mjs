// Explicitly controlled local QA world. Does not touch browser storage or original saves.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
const base=new URL('../',import.meta.url),source=new URL('evidence/battle_alignment_20261015/controlled_entry_save.json',base);
const target=new URL('web/tests/fixtures/battle_loading_save.json',base),bytes=await readFile(source);
await mkdir(new URL('web/tests/fixtures/',base),{recursive:true});
await writeFile(target,bytes);
console.log(target.pathname);
