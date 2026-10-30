import test from 'node:test';
import assert from 'node:assert/strict';
import {StartupSequence} from '../web/core/startup.mjs';
import {StartupView} from '../web/startup_view.mjs';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {attachSavePreview} from '../web/core/save_preview.mjs';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGgAAABMCAIAAAAOQ2XWAAAAuUlEQVR4nO3SMREAIAADMUASclCCfDTwc7J3+evc5w7+rbBBuM7jIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhRvMAV4QBnCTMUicAAAAASUVORK5CYII=';

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

function setup({save=null,onNew=async()=>{},onLoad=async()=>{},getSaves,refreshSaves,isBusy}={}){
  const nodes=new Map();
  const draws=[];
  const make=()=>{const node={hidden:false,children:[],listeners:{},attributes:{},style:{setProperty(){}},dataset:{},
    setAttribute(name,value){this.attributes[name]=value;},addEventListener(name,listener){this.listeners[name]=listener;},focus(){},replaceChildren(){this.children=[];},append(child){this.children.push(child);},
    getBoundingClientRect:()=>({width:800,height:600}),getContext:()=>({clearRect(){},fillRect(){},drawImage:(...args)=>draws.push(args)}),
    pause(){this.paused=true;},play(){this.paused=false;return Promise.resolve();},removeAttribute(){},load(){}};
    node.classList={contains:name=>(node.className??'').split(' ').includes(name)};return node;};
  const $=id=>{if(!nodes.has(id))nodes.set(id,make());return nodes.get(id);};
  globalThis.ResizeObserver=class {observe(){}};
  globalThis.document={createElement:tag=>Object.assign(make(),{tagName:tag.toUpperCase()})};
  const view=new StartupView({manifest:{assets:{},timing:{button_frame_ms:10},audio:{music:'title',cues:{}}},media:{media:{gametitle:{url:'title.mp4',source:'title.bik'}}},$,
    audio:{setMusic(){},suspend(){},snapshot:()=>({unlocked:false,channels:{master:{volume:1},music:{volume:1}}})},
    onNew,onLoad,onResume(){},onStage(){},getSave:()=>save,getSaves,refreshSaves,isBusy,status(){},log(){}});
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

test('read preview is an inline image created with the row and removed on Esc',async()=>{
  const save=attachSavePreview({sha256:'save',payload:'{}'},png);
  const {view,$}=setup({save});
  view.showMenu();settle(view);const opening=view.confirm();
  const preview=$('startupOptions').children.find(node=>node.tagName==='IMG');
  assert.equal(preview.tagName,'IMG');assert.equal(preview.src,png);assert.equal(preview.decoding,'sync');
  assert.deepEqual([preview.style.left,preview.style.top,preview.width,preview.height],['17px','97px',104,76]);
  assert.equal(preview.onload,undefined);assert.equal(preview.onerror,undefined);
  await opening;settle(view);view.key('Escape');
  assert.equal(view.submenu,null);assert.equal(saveButtons($).length,0);
});

test('title lists ordinary and quick files, refreshes on entry and loads the selected slot',async()=>{
  let entries=[],refreshes=0;const loads=[],quick={sha256:'quick',payload:'{}'},manual={sha256:'manual',payload:'{}'};
  const {view}=setup({getSaves:()=>entries,refreshSaves:async()=>{refreshes++;entries=[{slot:'manual',label:'普通存档',envelope:manual},{slot:'quick',label:'快速存档',envelope:quick}];},onLoad:(save,slot)=>loads.push({save,slot})});
  view.showMenu();settle(view);await view.confirm();settle(view);
  assert.equal(refreshes,1);assert.equal(view.optionCount(),2);assert.equal(view.getSave(),manual);
  view.key('ArrowDown');assert.equal(view.getSave(),quick);await view.confirm();
  assert.deepEqual(loads,[{save:quick,slot:'quick'}]);
});

const numberedSaves=()=>[...Array.from({length:20},(_,index)=>{
  const slot=String(index).padStart(2,'0');return {slot,label:'存档 '+slot,envelope:{sha256:slot,payload:'{}'}};
}),{slot:'quick',label:'快速存档',envelope:{sha256:'quick',payload:'{}'}}];
const saveButtons=$=>$('startupOptions').children.filter(node=>node.classList.contains('startup-save'));

test('title keeps three native save rows while navigation reaches every numbered slot and quick file',async()=>{
  const entries=numberedSaves(),loads=[];const {view,$}=setup({getSaves:()=>entries,onLoad:(save,slot)=>loads.push({save,slot})});
  view.showMenu();settle(view);await view.confirm();settle(view);
  assert.equal(saveButtons($).length,3);assert.equal(view.listTop,0);
  view.key('PageDown');assert.equal(view.subIndex,3);assert.equal(view.listTop,1);
  view.key('PageUp');assert.equal(view.subIndex,0);assert.equal(view.listTop,0);
  view.key('End');assert.equal(view.getSave(),entries[20].envelope);assert.equal(view.listTop,18);
  assert.deepEqual(saveButtons($).map(node=>node.style.top),['99px','207px','315px']);
  assert.ok(saveButtons($)[0].textContent.startsWith('存档 18'));
  assert.ok(saveButtons($)[2].textContent.startsWith('快速存档'));
  await view.confirm();assert.deepEqual(loads,[{save:entries[20].envelope,slot:'quick'}]);
  view.key('ArrowUp');assert.equal(view.subIndex,19);await view.confirm();assert.equal(loads[1].slot,'19');
  view.key('Home');assert.equal(view.subIndex,0);assert.equal(view.listTop,0);
  view.key('ArrowUp');assert.equal(view.subIndex,0);
  for(let index=1;index<entries.length;index++){
    view.key('ArrowDown');assert.equal(view.subIndex,index);
    assert.ok(index>=view.listTop&&index<view.listTop+3);
  }
  view.key('ArrowDown');assert.equal(view.subIndex,20);
  view.key('Escape');assert.equal(view.submenu,null);assert.equal(loads.length,2);
});

test('read wheel only scrolls the read panel and a visible row click loads its full-list slot',async()=>{
  const entries=numberedSaves(),loads=[];let busy=false;
  const {view,$}=setup({getSaves:()=>entries,isBusy:()=>busy,onLoad:(save,slot)=>loads.push({save,slot})});
  let prevented=0,stopped=0;const event={deltaY:120,preventDefault(){prevented++;},stopPropagation(){stopped++;}};
  const wheel=event=>$('startMenu').listeners.wheel(event);
  view.showMenu();settle(view);wheel(event);assert.equal(prevented,0);assert.equal(view.subIndex,0);
  await view.confirm();wheel(event);assert.equal(view.subIndex,0);settle(view);
  busy=true;wheel(event);assert.equal(view.subIndex,0);busy=false;
  for(let index=0;index<30;index++)wheel(event);
  assert.equal(view.subIndex,20);assert.equal(view.listTop,18);assert.equal(prevented,stopped);
  const row=saveButtons($)[1];row.onclick();await new Promise(done=>setImmediate(done));
  assert.equal(view.subIndex,19);assert.deepEqual(loads,[{save:entries[19].envelope,slot:'19'}]);
  wheel({...event,deltaY:-1});assert.equal(view.subIndex,18);
  view.key('Escape');const before=prevented;wheel(event);assert.equal(prevented,before);
  view.submenu='extras';wheel(event);assert.equal(prevented,before);
});

test('read rows directly show stored previews and leave legacy rows empty through scrolling',async()=>{
  const entries=numberedSaves();
  for(const index of [0,2,19,20])entries[index].envelope=attachSavePreview(entries[index].envelope,png);
  const {view,$}=setup({getSaves:()=>entries});
  const thumbnails=()=>saveButtons($).map((_button,row)=>$('startupOptions').children.find(node=>node.tagName==='IMG'&&node.style.top===97+108*row+'px')?.src??null);
  view.showMenu();settle(view);await view.confirm();settle(view);
  assert.deepEqual(thumbnails(),[png,null,png]);
  view.key('ArrowDown');assert.deepEqual(thumbnails(),[png,null,png]);
  view.key('End');assert.equal(view.listTop,18);assert.deepEqual(thumbnails(),[null,png,png]);
  view.key('Home');assert.deepEqual(thumbnails(),[png,null,png]);
  entries[0].envelope={...entries[0].envelope,sha256:'changed'};
  view.renderOptions();assert.deepEqual(thumbnails(),[null,null,png]);
});

test('an external quick load locks title keyboard, mouse confirmation and new game until it finishes',async()=>{
  let busy=false,starts=0;const {view,$}=setup({isBusy:()=>busy,onNew:()=>starts++});
  view.showMenu();settle(view);view.selected=1;busy=true;view.updateButtons();
  assert.equal($('menuNew').disabled,true);view.key('ArrowLeft');assert.equal(view.selected,1);
  await view.confirm();assert.equal(starts,0);
  busy=false;view.updateButtons();await view.confirm();assert.equal(starts,1);
});
