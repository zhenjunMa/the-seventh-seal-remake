import test from 'node:test';
import assert from 'node:assert/strict';
import {StartupSequence} from '../web/core/startup.mjs';
import {StartupView} from '../web/startup_view.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

test('startup source, export identity and indexed frames remain reproducible',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../web/data/startup_menu.json',import.meta.url)));
  const media=JSON.parse(readFileSync(new URL('../web/data/startup_media.json',import.meta.url)));
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  assert.equal(manifest.assets.menubtn.frames.length,36);
  assert.equal(manifest.assets.menuback.frames.length,6);
  assert.deepEqual(manifest.menu.stable_frames,{read:1,start:10,special:19,exit:28});
  assert.deepEqual(manifest.layout.movies.gametitle,{x:0,y:90,width:640,height:300});
  assert.equal(manifest.audio.gallery.length,30);
  for(const asset of Object.values(manifest.assets)){
    assert.equal(digest(readFileSync(new URL('../../../'+asset.source.path,import.meta.url))),asset.source.sha256);
    for(const [index,frame] of asset.frames.entries()){
      assert.equal(frame.index,index);assert.equal(digest(readFileSync(new URL('../web'+frame.path,import.meta.url))),frame.sha256);
    }
  }
  for(const clip of Object.values(media.media)){
    assert.equal(digest(readFileSync(new URL('../../../'+clip.source,import.meta.url))),clip.source_sha256);
    assert.equal(digest(readFileSync(new URL('../web'+clip.url,import.meta.url))),clip.sha256);
  }
});

test('startup preserves natural movie order and indefinite press wait',()=>{
  const flow=new StartupSequence();flow.start();assert.equal(flow.stage,'gametitle');
  assert.equal(flow.key('Enter'),true);assert.equal(flow.stage,'gametitle');
  flow.pointer(0);assert.equal(flow.stage,'gametitle');
  flow.complete();assert.equal(flow.stage,'preopenpress');
  flow.key('Escape');flow.pointer(2);assert.equal(flow.stage,'preopenpress');
  flow.complete();assert.equal(flow.stage,'openpress');
  assert.equal(flow.complete(),false);assert.equal(flow.stage,'openpress');
  flow.key(' ');assert.equal(flow.stage,'menu');
});

test('skip, held key, obsolete completion and close do not cross state boundaries',()=>{
  const flow=new StartupSequence();flow.start();const old=flow.epoch;
  flow.key('Escape');assert.equal(flow.stage,'preopenpress');
  assert.equal(flow.complete(old),false);assert.equal(flow.stage,'preopenpress');
  flow.complete();flow.key('Escape',true);assert.equal(flow.stage,'openpress');
  flow.pointer(2);assert.equal(flow.stage,'menu');
  flow.start();const pending=flow.epoch;flow.close();
  assert.equal(flow.complete(pending),false);assert.equal(flow.stage,'closed');
});

function setup({save=null,onNew=async()=>{},onLoad=async()=>{},getPreview}={}){
  const nodes=new Map();
  const draws=[];
  const make=()=>({hidden:false,style:{setProperty(){}},dataset:{},setAttribute(){},addEventListener(){},focus(){},replaceChildren(){},append(){},
    getBoundingClientRect:()=>({width:800,height:600}),getContext:()=>({clearRect(){},fillRect(){},drawImage:(...args)=>draws.push(args)}),
    pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();},removeAttribute(){},load(){}});
  const $=id=>{if(!nodes.has(id))nodes.set(id,make());return nodes.get(id);};
  globalThis.ResizeObserver=class {observe(){}};
  globalThis.document={createElement:make};
  const view=new StartupView({manifest:{assets:{},timing:{button_frame_ms:10},audio:{music:'title',cues:{}}},media:{media:{gametitle:{url:'title.mp4',source:'title.bik'}}},$,
    audio:{setMusic(){},suspend(){},snapshot:()=>({unlocked:false,channels:{master:{volume:1},music:{volume:1}}})},
    onNew,onLoad,onResume(){},onStage(){},getSave:()=>save,getPreview,status(){},log(){}});
  return {view,$,draws};
}
const settle=view=>view.tick(view.lastTick+1000);

test('menu confirmation cannot launch a second world replacement while the first is pending',async()=>{
  let calls=0,resolve;const {view}=setup({onNew:()=>{calls++;return new Promise(done=>resolve=done);}});
  view.showMenu();settle(view);view.selected=1;const pending=view.confirm();await view.confirm();
  assert.equal(calls,1);assert.equal(view.pending,true);resolve();await pending;assert.equal(view.pending,false);
});

test('empty read and cancellation do not load, and a rejected load leaves a usable menu',async()=>{
  let loads=0;const empty=setup({onLoad:()=>loads++}).view;empty.showMenu();settle(empty);await empty.confirm();settle(empty);await empty.confirm();
  assert.equal(loads,0);empty.key('Escape');assert.equal(empty.submenu,null);
  const loaded=setup({save:{world:{}},onLoad:async()=>{loads++;throw new Error('invalid save');}}).view;
  loaded.showMenu();settle(loaded);await loaded.confirm();settle(loaded);await loaded.confirm();assert.equal(loads,1);assert.equal(loaded.pending,false);
  loaded.key('Escape');assert.equal(loaded.submenu,null);
});

test('leaving startup retires playback and old movie completion cannot reopen the screen',()=>{
  const {view,$}=setup();view.start();const completion=$('startupVideo').onended;
  view.hide();completion();assert.equal(view.sequence.stage,'closed');assert.equal($('startMenu').hidden,true);
  assert.equal($('startupVideo').paused,true);assert.equal($('startupVideo').onended,null);
});

test('menu rotation includes source frame zero and music groups do not mix at their boundary',()=>{
  const {view}=setup();view.showMenu();settle(view);view.frame=28;view.selected=3;view.select(0);
  // Test exact frame boundaries against an integer virtual origin. Adding 80
  // to a fractional performance.now() can otherwise round just below step8.
  view.rotation.started=Math.ceil(view.rotation.started);
  view.tick(view.rotation.started+80);assert.equal(view.frame,0);
  view.tick(view.rotation.started+90);assert.equal(view.frame,1);assert.equal(view.rotation,null);
  assert.equal(view.galleryTop(17),11);assert.equal(view.galleryTop(18),18);assert.equal(view.galleryTop(29),23);
});

test('read preview uses the native thumbnail rectangle and ignores completion after Esc',async()=>{
  const image={name:'saved-scene'};let resolve;
  const {view,$,draws}=setup({save:{sha256:'save',payload:'{}'},getPreview:()=>new Promise(done=>resolve=done)});
  view.showMenu();settle(view);await view.confirm();settle(view);
  resolve({image,source:'reconstructed',map_id:'M01010'});await new Promise(done=>setImmediate(done));
  assert.equal($('startMenu').dataset.preview,'reconstructed');
  assert.ok(draws.some(args=>args[0]===image&&args.slice(1).join(',')==='17,97,104,76'));
  view.previewCache=null;view.requestPreview(view.getSave());await Promise.resolve();
  view.previewImage=null;view.key('Escape');resolve({image,source:'stored'});await new Promise(done=>setImmediate(done));
  assert.equal(view.submenu,null);assert.equal(view.previewImage,null);
});
