// Full regional enumeration is explicit phase/release coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {story,regional,world,runner} from './helpers/fire_valley_case.mjs';

test('all 21 admitted Fire Valley maps retain native identities and every NPC entry executes under three source flag states',async()=>{
  assert.equal(regional.length,21);let checks=0;
  for(const phase of [{},{returnVisit:true},{returnVisit:true,arrivalComplete:true}])for(const mapId of regional){
    const binding=runtimeContent.maps[mapId],table=story.maps[mapId];
    assert.ok(Array.isArray(binding.npcs),`${mapId} must explicitly admit its dialogue slots`);
    for(const slot of binding.npcs){
      const entry=table.index_nonzero.find(row=>row.slot===slot);assert.ok(entry,`${mapId}:${slot}`);
      const value=world(mapId,phase);
      await assert.doesNotReject(runner(value).runTlk({mapId,recordId:entry.record,context:{steps:0,explicitInteraction:true}}),`${mapId} NPC ${slot} ${JSON.stringify(phase)}`);
      checks++;
    }
  }
  assert.ok(checks>=150,'all admitted NPC entries must be exercised in each phase');
});
