import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateForestStage,forestStageAssets,drawForestStageBackground} from '../web/forest_stage.mjs';
const stage=JSON.parse(await readFile(new URL('../web/data/forest_stage.json',import.meta.url),'utf8'));
test('All forest source frames retain hashes and dimensions; the background pass draws sky, cropped ground and scenery',async()=>{
  validateForestStage(stage);const assets=forestStageAssets(stage),images=new Map();
  assert.equal(assets.length,32);
  for(const a of assets){const raw=await readFile(new URL('../web'+a.path,import.meta.url));
    assert.equal(createHash('sha256').update(raw).digest('hex'),a.sha256);
    assert.equal(raw.readUInt32BE(16),a.width);assert.equal(raw.readUInt32BE(20),a.height);images.set(a.path,a.path);
  }
  const calls=[],ctx={drawImage:(...args)=>calls.push(args)};
  drawForestStageBackground(ctx,stage,images,0);
  assert.ok(calls[0][0].endsWith('frame_028.png'));assert.deepEqual(calls[1].slice(1),[380,95,640,305,120,196.875,720,343.125]);
  assert.equal(calls.length,3);assert.ok(calls[2][0].includes('/FB13A/'));
  assert.deepEqual(calls[2].slice(1),[142,185,640,214,120,0,720,240.75]);
  calls.length=0;drawForestStageBackground(ctx,stage,images,160);assert.ok(calls[0][0].endsWith('frame_000.png'));
});

test('stage02 preserves repeated scenery and advances each indexed light on the source120ms clock',async()=>{
  const stage=JSON.parse(await readFile(new URL('../web/data/stages/stage02.json',import.meta.url),'utf8'));
  validateForestStage(stage);
  const repeated=stage.layers.filter(layer=>layer.source.path.toLowerCase()==='fight_bk/poders.dgp');
  assert.equal(repeated.length,2);assert.notEqual(repeated[0].id,repeated[1].id);
  assert.deepEqual(repeated.map(layer=>layer.scn.position_raw.x),[573,-11]);
  const images=new Map(forestStageAssets(stage).map(asset=>[asset.path,asset.path]));
  const calls=[],stack=[],ctx={globalCompositeOperation:'source-over',
    save(){stack.push(this.globalCompositeOperation);},restore(){this.globalCompositeOperation=stack.pop();},
    drawImage(path,...args){calls.push({path,blend:this.globalCompositeOperation,args});}};
  for(const [time,frame]of [[0,15],[119,15],[120,16],[720,0]]){
    calls.length=0;drawForestStageBackground(ctx,stage,images,time);
    const poder=calls.filter(row=>row.path.includes('/PODER/'));
    assert.equal(poder.length,2);assert.ok(poder[0].path.endsWith(`frame_${String(frame).padStart(3,'0')}.png`));
    assert.equal(poder[0].blend,'source-over');assert.equal(poder[1].blend,'lighter');
    assert.equal(ctx.globalCompositeOperation,'source-over');
    for(const layer of repeated)assert.equal(calls.filter(row=>row.path.includes(`/${layer.id}/`)).length,2);
  }
});
