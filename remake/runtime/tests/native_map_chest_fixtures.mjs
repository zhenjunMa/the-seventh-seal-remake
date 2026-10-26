// Derive chest fixtures from current exported source bindings and original
// DAT/DGP bytes. No ignored investigation bundle is required by these tests.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
export const WHITE_FOREST_MAPS=['M70010','M70020','M70030','M70040','M70050','M70060'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const originalPath=path=>new URL(`../../../${path}`,import.meta.url);
const read=path=>JSON.parse(fs.readFileSync(new URL(path,import.meta.url),'utf8'));
function normalizeAction(raw,version){
  if(version===9)return raw;
  assert.equal(version,8,'DGP action source version');
  const out=Buffer.alloc(0xac);raw.copy(out,0,0,0x20);
  for(const [from,to,capacity]of [[0x20,0x2a,0x14],[0x2f,0x3e,0x14],[0x42,0x56,0x14]]){
    const end=raw.indexOf(0,from),text=raw.subarray(from,end<0?raw.length:end);
    assert.ok(text.length<capacity);text.copy(out,to);
  }
  for(const [from,to,size]of [[0x3e,0x52,4],[0x56,0x6a,4],[0x5a,0x72,4],[0x62,0x7a,4],
    [0x66,0x7e,1],[0x67,0x7f,1],[0x68,0x80,4],[0x6c,0x84,3],[0x73,0x87,1],
    [0x74,0x88,4],[0x78,0x8c,8],[0x80,0x94,4]])raw.copy(out,to,from,from+size);
  return out;
}
export function readNativeChestFixtures(){
  const story=read('../web/data/chapter_story.json'),resources=read('../web/data/chapter_map_resources.json');
  const chests=[],missing=[],source_hashes={};
  for(const id of WHITE_FOREST_MAPS){
    const table=story.maps[id];
    if(!table){missing.push(`exported source table ${id}`);continue;}
    const path=originalPath(table.map_source.path);
    if(!fs.existsSync(path)){missing.push(table.map_source.path);continue;}
    const dat=fs.readFileSync(path);source_hashes[table.map_source.path]=hash(dat);
    assert.equal(hash(dat),table.map_source.sha256,`${id} DAT fingerprint`);
    assert.equal(dat.readUInt32LE(0x14),6);assert.equal(dat.readUInt32LE(0x92),table.map_flag_index);
    for(const object of table.objects){
      const raw=dat.subarray(object.source.offset,object.source.offset+0x112);
      assert.equal(raw.toString('hex'),object.raw_hex,`${id}/${object.index} DAT record`);
      if(raw[0xcf]!==4)continue;
      const animation=resources.object_animations[id]?.find(row=>row.object_index_zero_based===object.index);
      if(!animation){missing.push(`exported source animation ${id}/${object.index}`);continue;}
      const dgpPath=originalPath(animation.source.path);
      if(!fs.existsSync(dgpPath)){missing.push(animation.source.path);continue;}
      const dgp=fs.readFileSync(dgpPath);source_hashes[animation.source.path]=hash(dgp);
      assert.equal(hash(dgp),animation.source.sha256,`${id}/${object.index} DGP fingerprint`);
      const actionBytes=dgp[0]===9?0xac:0x90,actionCount=dgp[2];
      assert.equal(animation.actions.length,actionCount);
      const actions=animation.actions.map((action,index)=>{
        const raw=normalizeAction(dgp.subarray(0x43+index*actionBytes,0x43+(index+1)*actionBytes),dgp[0]);
        assert.equal(raw.toString('hex'),action.raw_hex,`${id}/${object.index} DGP action${index}`);
        assert.equal(action.interval_raw,raw.readUInt32LE(1));
        return {...action,raw_hex:raw.toString('hex')};
      });
      const frameCount=dgp.readUInt32LE(0x43+actionCount*actionBytes+4);
      assert.equal(animation.frames.length,frameCount);
      chests.push({map_id:id,map_flag_index:table.map_flag_index,map_source:table.map_source,
        object:{...object,raw_hex:raw.toString('hex')},animation:{...animation,actions}});
    }
  }
  return {story,resources,chests,source_hashes,missing,
    skip:missing.length?`Original/exported chest materials unavailable: ${missing.join(', ')}`:chests.length!==13?'Outer White Forest thirteen-chest source set has not been built':false};
}
