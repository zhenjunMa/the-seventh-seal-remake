import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {nextWorldMapDestination, WorldMapView} from '../web/world_map_view.mjs';

const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url)));
const manifest = await json('../web/data/world_map_ui.json');
const data = await json('../web/data/world_map.json');

test('native widget IDs bind both areas to destination order, including reordered forest imagery', () => {
  assert.equal(manifest.areas.length, 2);
  assert.deepEqual(manifest.areas[0].destinations.map(d => d.sensor_value), [24,40,56,72,135,183,104]);
  assert.deepEqual(manifest.areas[1].destinations.map(d => d.sensor_value), [28,38,58,87,119,151,185]);
  for (const area of manifest.areas) for (const destination of area.destinations) {
    assert.equal(destination.map_id, data.areas[area.id].destinations[destination.index].map_id);
    assert.equal(destination.widget_index, destination.index + 1);
  }
  assert.match(manifest.areas[0].destinations[6].normal, /image_010\.png$/);
});

const destinations = [1,1,1,1,0,1,0].map((status,index) => ({index,status,available:status===0}));
test('native arrow order skips hidden destinations and wraps between fire valley and forest', () => {
  for (const step of [-1,1]) {
    assert.equal(nextWorldMapDestination(destinations,4,step),6);
    assert.equal(nextWorldMapDestination(destinations,6,step),4);
  }
  assert.equal(nextWorldMapDestination(destinations.map(d=>({...d,status:1})),4,1),null);
  assert.equal(nextWorldMapDestination(destinations.map(d=>({...d,status:d.index===4?0:2})),4,-1),4);
});

function harness() {
  const calls = [];
  // Exercise the real input methods without DOM/canvas mocks. Rendering is
  // verified separately in the browser; this fixture checks command ownership.
  const view = Object.assign(Object.create(WorldMapView.prototype), {
    snapshot:{phase:'open',destinations},selected:4,hovered:null,armed:false,
    draw(){},cue(name){calls.push(['cue',name]);},select(index){calls.push(['select',index]);},
    close(){calls.push(['close']);},status(message){calls.push(['status',message]);},
  });
  return {view,calls};
}
test('arrival confirmation and held confirm cannot enter the departure or submit twice', () => {
  const {view,calls} = harness();
  view.key(' '); assert.equal(calls.length,0);
  view.key('ArrowDown'); assert.equal(view.selected,6);
  view.key(' ',true); assert.equal(calls.filter(c=>c[0]==='select').length,0);
  view.key('Enter'); assert.deepEqual(calls.at(-1),['select',6]);
  view.snapshot.phase='loading'; view.key('Enter'); view.key('Escape'); view.confirm(4);
  assert.equal(calls.filter(c=>c[0]==='select').length,1);
  assert.equal(calls.filter(c=>c[0]==='close').length,0);
});
test('closed and unconnected destinations never invoke world selection; escape preserves a return path', () => {
  const {view,calls} = harness();
  view.confirm(3); assert.equal(calls.length,0);
  view.snapshot.destinations=destinations.map(d=>({...d,available:false}));
  view.confirm(6); assert.equal(calls.filter(c=>c[0]==='select').length,0);
  assert.equal(calls.at(-1)[0],'status');
  view.key('Escape'); assert.deepEqual(calls.at(-1),['close']);
  view.snapshot.phase='closed'; assert.equal(view.key('ArrowDown'),false);
});
