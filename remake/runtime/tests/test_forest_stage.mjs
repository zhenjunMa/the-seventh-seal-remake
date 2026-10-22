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
