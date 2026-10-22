import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createAudioController} from '../web/core/audio.mjs';
import {createMenuSettings} from '../web/core/menu_settings.mjs';

const manifest = JSON.parse(readFileSync(new URL('../web/data/audio.json', import.meta.url)));
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const store = initial => {
  const values = new Map(Object.entries(initial ?? {}));
  return {getItem:key => values.get(key) ?? null, setItem:(key,value) => values.set(key,value)};
};
const mediaSetup = storage => {
  const voices = [];
  const audio = createAudioController(manifest, {storage, createMedia:path => {
    const media = {path, paused:true, currentTime:0, play(){this.paused=false; return Promise.resolve();},
      pause(){this.paused=true;}, removeAttribute(){}, load(){}};
    voices.push(media); return media;
  }});
  audio.setScene({mapId:'M17010'}); audio.unlock();
  return {audio, voices};
};

test('master/music/effects change live voices independently and persist all controls', async () => {
  const storage = store(), {audio, voices} = mediaSetup(storage);
  await tick();
  audio.setVolume(.8); audio.setChannelVolume('music',.5); audio.setChannelVolume('effects',.25);
  audio.playCue('menuConfirm'); await tick();
  assert.equal(voices[0].volume,51/127); assert.equal(voices[1].volume,25/127);
  audio.setChannelMuted('music',true);
  assert.equal(voices[0].muted,true); assert.equal(voices[1].muted,false);
  audio.setChannelMuted('effects',true);
  assert.equal(audio.snapshot().effects.length,0); assert.equal(voices[1].paused,true);
  assert.equal(audio.playCue('menuConfirm'),false);
  audio.setChannelMuted('effects',false); audio.playCue('menuConfirm'); await tick();
  audio.setMuted(true); assert.equal(audio.snapshot().effects.length,0);
  audio.setMuted(false); assert.equal(voices[0].muted,true);
  const reload = createAudioController(manifest,{storage});
  assert.deepEqual(reload.snapshot().channels, audio.snapshot().channels);
  assert.equal(reload.snapshot().volume,.8); assert.equal(reload.snapshot().muted,false);
  const copy=audio.snapshot(); copy.channels.master.volume=0;
  assert.equal(audio.snapshot().volume,.8);
  assert.throws(()=>audio.setChannelVolume('unknown',.5));
  assert.throws(()=>audio.setChannelVolume('music',NaN));
  audio.dispose(); reload.dispose();
});

test('legacy audio preferences migrate to all channels and native integer mixer', async () => {
  const storage=store({'seventh-seal-audio-v1':JSON.stringify({volume:.3,muted:false})});
  const {audio,voices}=mediaSetup(storage); await tick();
  assert.deepEqual(audio.snapshot().channels,{master:{volume:.3,muted:false},music:{volume:1,muted:false},effects:{volume:1,muted:false}});
  audio.playCue('menuConfirm'); await tick();
  assert.equal(voices[0].volume,38/127); assert.equal(voices[1].volume,38/127);
  audio.setChannelVolume('effects',0); audio.playCue('menuConfirm'); await tick();
  assert.equal(voices[2].volume,1/127);
  audio.dispose();
});

test('battle cursor preference survives sessions and handles invalid or unavailable storage', () => {
  const storage=store(), settings=createMenuSettings({storage});
  assert.equal(settings.snapshot().battleCursor,'memory');
  settings.setBattleCursor('memory');
  assert.equal(createMenuSettings({storage}).snapshot().battleCursor,'memory');
  settings.setBattleCursor('initial');
  assert.equal(createMenuSettings({storage}).snapshot().battleCursor,'initial');
  assert.throws(()=>settings.setBattleCursor('other'));
  assert.equal(settings.snapshot().battleCursor,'initial');
  assert.equal(createMenuSettings({storage:store({'seventh-seal-menu-settings-v1':'invalid'})}).snapshot().battleCursor,'memory');
  const inaccessible={getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}};
  assert.equal(createMenuSettings({storage:inaccessible}).setBattleCursor('memory').battleCursor,'memory');
});
