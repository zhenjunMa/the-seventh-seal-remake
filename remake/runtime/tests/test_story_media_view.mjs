import test from 'node:test';
import assert from 'node:assert/strict';
import {StoryMediaView,validateStoryMedia} from '../web/story_media_view.mjs';
import {StoryPlayback} from '../web/core/story_playback.mjs';
import {createAudioController} from '../web/core/audio.mjs';
import {readFile} from 'node:fs/promises';
const audioManifest=JSON.parse(await readFile(new URL('../web/data/audio.json',import.meta.url)));
const digest='a'.repeat(64),manifest={schema:'seventh-seal-story-media',version:1,
  videos:{'20.bik':{path:'/assets/video/story/20.mp4',sha256:digest,source:{path:'Animate/20.bik',sha256:digest}}},
  sounds:{'manyanshort.wav':{path:'/assets/audio/story/manyanshort.mp3',sha256:digest,source:{path:'sound/MANYANSHORT.wav',sha256:digest}}}};
class Media{
  constructor(){this.listeners=new Map();this.paused=true;this.playCalls=0;this.style={};this.src='';}
  addEventListener(name,fn){this.listeners.set(name,fn);}
  removeEventListener(name,fn){if(this.listeners.get(name)===fn)this.listeners.delete(name);}
  emit(name){this.listeners.get(name)?.();}
  play(){this.playCalls++;this.paused=false;return this.playError?Promise.reject(this.playError):Promise.resolve();}
  pause(){this.paused=true;}
  removeAttribute(name){if(name==='src')this.src='';}
  setAttribute(){}
  load(){}
  remove(){this.removed=true;}
}
function fixture(data=manifest){
  const created=[],timers=new Set(),mounted=[],graphs=[],clock={paused:false},playback=new StoryPlayback({clock});
  let suppressed=false;
  const audio={setStoryMusicSuppressed(value){suppressed=value;},snapshot(){return {story_music_suppressed:suppressed,
    channels:{master:{volume:.8,muted:false},effects:{volume:.5,muted:false}}};}};
  const view=new StoryMediaView({manifest:data,root:{appendChild:media=>mounted.push(media)},audio,playback,
    createMedia:kind=>{const media=new Media();media.kind=kind;created.push(media);return media;},
    setTimer:fn=>{timers.add(fn);return fn;},clearTimer:fn=>timers.delete(fn),createAudioContext:()=>{
      const node=()=>({connections:[],connect(target){this.connections.push(target);},disconnect(){this.disconnected=true;}});
      const graph={destination:{},resumeCalls:0,closeCalls:0,resume(){this.resumeCalls++;return Promise.resolve();},close(){this.closeCalls++;return Promise.resolve();},
        createMediaElementSource(media){this.source=node();this.media=media;return this.source;},createGain(){this.gain={...node(),gain:{value:1}};return this.gain;}};
      graphs.push(graph);return graph;
    }});
  return {view,playback,clock,audio,created,mounted,timers,graphs,h:view.hooks()};
}
const tick=async()=>{await Promise.resolve();await Promise.resolve();};

test('default browser timers retain the global receiver when called by the media owner',async()=>{
  const previous={setInterval:globalThis.setInterval,clearInterval:globalThis.clearInterval},handles=new Set();
  globalThis.setInterval=function(callback,delay){assert.equal(this,globalThis,'Window timer brand');assert.equal(delay,16);handles.add(callback);return callback;};
  globalThis.clearInterval=function(handle){assert.equal(this,globalThis,'Window timer brand');assert.equal(handles.delete(handle),true);};
  const view=new StoryMediaView({manifest,root:{appendChild(){}},audio:{setStoryMusicSuppressed(){},snapshot:()=>({})},createMedia:()=>new Media()});
  try{
    await view.hooks().sound({kind:'play',filename:'manyanshort.wav',persistent:true});
    assert.equal(handles.size,1);view.dispose();assert.equal(handles.size,0);
  }finally{view.dispose();Object.assign(globalThis,previous);}
});

test('movie waits for ended, pauses with the owning playback and retires all listeners on completion',async()=>{
  const f=fixture();let finished=false;
  const running=f.h.media({filename:'20.bik',signal:f.playback.signal}).then(()=>{finished=true;});
  await tick();const movie=f.created[0];assert.equal(f.mounted[0],movie);assert.equal(movie.src,manifest.videos['20.bik'].path);
  assert.equal(finished,false);assert.equal(f.audio.snapshot().story_music_suppressed,true);
  f.clock.paused=true;f.view.sync();assert.equal(movie.paused,true);
  f.clock.paused=false;f.view.sync();await tick();assert.equal(movie.paused,false);assert.equal(movie.playCalls,2);
  movie.emit('ended');await running;assert.equal(finished,true);assert.equal(movie.removed,true);assert.equal(movie.listeners.size,0);
  assert.equal(f.timers.size,0);assert.equal(f.audio.snapshot().story_music_suppressed,false);f.view.dispose();
  assert.equal(f.graphs.length,0,'ordinary gain1 media needs no Web Audio graph');
});

test('documented video headroom is restored with a scoped GainNode on play, pause and abort',async()=>{
  const data=structuredClone(manifest);data.videos['20.bik'].audio={playback_gain:2};
  for(const cancel of [false,true]){
    const f=fixture(data),running=f.h.media({filename:'20.bik',signal:f.playback.signal});await tick();await tick();
    const movie=f.created[0],graph=f.graphs[0];assert.equal(graph.gain.gain.value,2);
    assert.deepEqual(graph.source.connections,[graph.gain]);assert.deepEqual(graph.gain.connections,[graph.destination]);
    assert.equal(movie.volume,.8);assert.equal(movie.paused,false);
    f.clock.paused=true;f.view.sync();assert.equal(movie.paused,true);f.clock.paused=false;f.view.sync();await tick();await tick();assert.equal(movie.paused,false);
    if(cancel){f.playback.cancel();await assert.rejects(running,{name:'AbortError'});}else {movie.emit('ended');await running;}
    assert.equal(graph.source.disconnected,true);assert.equal(graph.gain.disconnected,true);f.view.dispose();assert.equal(graph.closeCalls,1);
  }
});

test('source sound modes restore music, mute music, release ordinary voices and defer persistent cleanup until actual end',async()=>{
  const f=fixture();await f.h.sound({kind:'release',modeRaw:1});assert.equal(f.audio.snapshot().story_music_suppressed,true);
  await f.h.sound({kind:'play',filename:'MANYANSHORT.wav',persistent:true,signal:f.playback.signal});
  const voice=f.created[0];assert.equal(voice.loop,false);assert.equal(voice.src,manifest.sounds['manyanshort.wav'].path);
  await f.h.sound({kind:'release',modeRaw:2});assert.equal(voice.removed,undefined,'63 must not interrupt the persistent narration');
  await f.h.sound({kind:'restore-music'});assert.equal(f.audio.snapshot().story_music_suppressed,false);
  voice.emit('ended');assert.equal(voice.removed,true);assert.equal(f.view.entries.size,0);assert.equal(f.timers.size,0);
  await f.h.sound({kind:'play',filename:'manyanshort.wav',persistent:false,signal:f.playback.signal});
  await f.h.sound({kind:'release',modeRaw:0});assert.equal(f.created[1].removed,true);f.view.dispose();
});

test('movie load failure and cancellation reject the waiting instruction and cannot advance on stale ended events',async()=>{
  for(const cancel of [false,true]){
    const f=fixture(),running=f.h.media({filename:'20.bik',signal:f.playback.signal});await tick();const movie=f.created[0];
    if(cancel)f.playback.cancel();else {movie.error=new Error('media decode failed');movie.emit('error');}
    await assert.rejects(running,cancel?{name:'AbortError'}:/media decode failed/);
    assert.equal(movie.listeners.size,0);assert.equal(movie.removed,true);assert.equal(f.timers.size,0);movie.emit('ended');
    assert.equal(f.playback.phase,cancel?'cancelled':'failed');f.view.dispose();
  }
});

test('late sound errors abort the owning transaction; manifest filenames and paths stay confined',async()=>{
  const f=fixture();await f.h.sound({kind:'play',filename:'manyanshort.wav',persistent:true,signal:f.playback.signal});
  f.created[0].error=new Error('late audio failure');f.created[0].emit('error');assert.equal(f.playback.phase,'failed');assert.equal(f.playback.signal.aborted,true);
  f.view.dispose();assert.equal(f.timers.size,0);assert.equal(f.created[0].listeners.size,0);
  const bad=structuredClone(manifest);bad.videos['20.bik'].path='/assets/video/story/../20.mp4';assert.throws(()=>validateStoryMedia(bad),/路径无效/);
  bad.videos['20.bik'].path=manifest.videos['20.bik'].path;bad.videos['20.bik'].source.path='Animate/24.bik';assert.throws(()=>validateStoryMedia(bad),/文件名不匹配/);
});

test('temporary ANM music gain never rewrites saved audio preferences or stops playback time',async()=>{
  const media=[],writes=[],audio=createAudioController(audioManifest,{storage:{getItem(){return null;},setItem(...args){writes.push(args);}},
    createMedia:()=>{const row=new Media();media.push(row);return row;}});
  audio.setScene({mapId:'M17010'});audio.unlock();await tick();audio.setChannelVolume('music',.6);
  const before=audio.snapshot(),count=writes.length,voice=media[0];voice.currentTime=23;
  audio.setStoryMusicSuppressed(true);assert.equal(voice.volume,0);assert.equal(voice.paused,false);
  audio.setChannelVolume('master',.7);const edited=audio.snapshot();audio.setStoryMusicSuppressed(false);
  assert.ok(voice.volume>0);assert.equal(voice.currentTime,23);assert.deepEqual(audio.snapshot().channels,edited.channels);
  assert.equal(audio.snapshot().channels.music.volume,before.channels.music.volume);assert.equal(writes.length,count+1,'only explicit user volume edit persists');audio.dispose();
});
