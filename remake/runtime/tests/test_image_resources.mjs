import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageResources} from '../web/core/image_resources.mjs';

function cache() {
  const images = [];
  const resources = new ImageResources({createImage:() => {
    const image = {width:32, height:16}; images.push(image); return image;
  }});
  return {resources, images};
}
test('concurrent owners share one decode, and shared pixels survive scene release', async () => {
  const {resources, images} = cache();
  const first = resources.load('actor.png', 'map:A');
  const second = resources.load('actor.png', 'map:B');
  assert.equal(first, second); assert.equal(images.length, 1);
  images[0].onload(); await first;
  assert.equal(resources.retainScopes(['map:B']), 0);
  assert.equal(resources.peek('actor.png'), images[0]);
  assert.equal(resources.snapshot().estimatedDecodedBytes, 32 * 16 * 4);
  assert.equal(resources.retainScopes([]), 1);
  assert.equal(resources.peek('actor.png'), null);
});
test('failed image loads can retry without keeping a rejected cache entry', async () => {
  const {resources, images} = cache();
  const first = resources.load('missing.png', 'map:A');
  const rejection = assert.rejects(first, /missing.png/);
  images[0].onerror(); await rejection;
  assert.equal(resources.snapshot().entries, 0);
  const second = resources.load('missing.png', 'map:A');
  images[1].onload(); assert.equal(await second, images[1]);
});
test('a late failure from a released scene cannot remove a newer load', async () => {
  const {resources, images} = cache();
  const old = resources.load('map.png', 'map:A');
  const rejection = assert.rejects(old, /map.png/);
  resources.retainScopes([]);
  const current = resources.load('map.png', 'map:B');
  images[0].onerror(); await rejection;
  images[1].onload(); await current;
  assert.equal(resources.peek('map.png'), images[1]);
  assert.deepEqual(resources.snapshot().scopes, ['map:B']);
});
test('release does not let a late success resurrect an unused scene', async () => {
  const {resources, images} = cache();
  const pending = resources.load('old.png', 'map:A');
  resources.retainScopes(['shared']); images[0].onload(); await pending;
  assert.equal(resources.snapshot().entries, 0);
});
test('a late actor decode cannot reattach pixels after its ownership was released', async () => {
  const {resources, images} = cache();
  const action = {};
  const pending = resources.attach(action, 'actor.png', 'role:old');
  resources.retainScopes([]);
  images[0].onload(); await pending;
  assert.equal(action.bitmap, undefined);
  const current = resources.attach(action, 'actor.png', 'role:current');
  images[1].onload(); await current;
  assert.equal(action.bitmap, images[1]);
});
