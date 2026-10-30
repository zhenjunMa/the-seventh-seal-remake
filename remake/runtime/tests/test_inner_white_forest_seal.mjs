// YC-04 continues the shared, naturally earned YC-03 rules endpoint through
// production TLK/ANM runners. Bounded battle callbacks verify story transactions;
// this does not claim browser walking or a real 041/024 combat victory.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {innerWhiteForestSource,innerWhiteForestOriginal} from './helpers/inner_white_forest_world.mjs';
import {innerWhiteForestSealComplete} from './helpers/inner_white_forest_seal_world.mjs';

const source=await innerWhiteForestSource();
const deepMaps=['M70077','M70077-1','M70077-2','M70077-3','M70077-4',
  'M70078-1_1','M70078-2_1','M70078-3_1','M70078_2'];
test('YC-04 admits the complete Tabas, three-artifact and seal source bytes',async()=>{
  for(const id of ['M01019',...deepMaps]){
    assert.ok(source.content.maps[id],id);const table=source.story.maps[id];
    for(const provenance of [table.map_source,...(table.source?[table.source]:[])]){
      const bytes=await innerWhiteForestOriginal(provenance.path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'),provenance.sha256,provenance.path);
      for(const row of provenance===table.map_source?table.objects:table.records)
        assert.equal(bytes.subarray(row.source.offset,row.source.offset+row.raw_hex.length/2).toString('hex'),row.raw_hex);
    }
  }
  for(const [id,count]of [['m01010-1',75],['m01042-1',55],['m70078-1',52]]){
    const program=source.story.programs[id],bytes=await innerWhiteForestOriginal(program.source.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),program.source.sha256);
    assert.equal(program.commands.length,count);assert.equal(bytes.length,67+count*74);
    for(const command of program.commands)
      assert.equal(bytes.subarray(command.source.offset,command.source.offset+74).toString('hex'),command.raw_hex);
  }
  const device=source.story.maps.M70078_2.objects.find(row=>row.index===23),raw=Buffer.from(device.raw_hex,'hex');
  assert.equal(raw[0xcf],3);assert.equal(raw.readUInt32LE(0xf6),1);
  assert.equal(source.content.maps.M70078_2.objects.find(row=>row.index===23).handler,'stationary-chest');
});

test('natural Jute handoff earns three artifacts, synthesizes298, seals107:1 and revisits Tabas without replay rewards',async()=>{
  await innerWhiteForestSealComplete(source);
});
