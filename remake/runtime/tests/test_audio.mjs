import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createAudioController, validateAudioManifest} from '../web/core/audio.mjs';

const data = JSON.parse(readFileSync(new URL('../web/data/audio.json', import.meta.url)));
const digest = raw => createHash('sha256').update(raw).digest('hex');
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
class Media {
  constructor(path, result = () => Promise.resolve()) { this.path=path; this.paused=true; this.currentTime=0; this.duration=120; this.readyState=4; this.listeners=new Map(); this.playCalls=0; this.pauseCalls=0; this.result=result; }
  play() { this.playCalls++; this.paused=false; return this.result(); }
  pause() { this.paused=true; this.pauseCalls++; }
  removeAttribute() {}
  load() {}
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name, fn) { if (this.listeners.get(name)===fn) this.listeners.delete(name); }
  emit(name) { this.listeners.get(name)?.(); }
}
function setup(manifest=data, result) {
  const voices=[]; const audio=createAudioController(manifest,{createMedia:path=>{ const media=new Media(path,result); voices.push(media); return media; }});
  return {audio,voices};
}

test('title music uses registered clips, keeps channel settings and returns to scene music',async()=>{
  const {audio,voices}=setup();audio.setScene({mapId:'M70010'});audio.unlock();await tick();
  const original=audio.snapshot().desired_clip,clip=Object.keys(data.clips)[0];
  audio.setChannelVolume('music',.5);audio.setMusic(clip);await tick();
  assert.equal(audio.snapshot().desired_clip,clip);assert.equal(audio.snapshot().channels.music.volume,.5);
  const count=voices.length;audio.setMusic(clip);await tick();assert.equal(voices.length,count);
  assert.throws(()=>audio.setMusic('missing/title.wav'));
  audio.setScene({mapId:'M70010'});await tick();assert.equal(audio.snapshot().desired_clip,original);
});

test('empty DAT music inherits the active track through the black transition map',async()=>{
  assert.equal(data.maps.M00000.source.token,'');assert.equal(data.maps.M00000.inherit,true);
  const {audio,voices}=setup();audio.setScene({mapId:'M01030'});audio.unlock();await tick();
  const clip=audio.snapshot().desired_clip,media=voices[0];media.currentTime=17;
  audio.setScene({mapId:'M00000'});await tick();
  assert.equal(audio.snapshot().desired_clip,clip);assert.equal(voices.length,1);
  assert.equal(media.currentTime,17);assert.equal(media.pauseCalls,0);
  audio.setScene({mapId:'M03039'});await tick();
  assert.equal(audio.snapshot().desired_clip,data.maps.M03039.clip);
});

test('audio export binds real content, source digests and action fields, retaining missing originals', () => {
  validateAudioManifest(data);
  for (const clip of Object.values(data.clips)) {
    const original=readFileSync(new URL('../../../'+clip.source.path,import.meta.url));
    const output=readFileSync(new URL('../web'+clip.path,import.meta.url));
    assert.equal(digest(original),clip.source.sha256); assert.equal(digest(output),clip.sha256);
    assert.equal(clip.export.decoded_audio_unchanged,true);
    assert.ok(clip.audio.duration_seconds>0);
    if (clip.mime==='audio/mpeg') { assert.deepEqual(output,original); assert.ok(clip.path.endsWith('.mp3')); }
    else { assert.equal(output.subarray(0,4).toString(),'RIFF'); assert.equal(output.subarray(8,12).toString(),'WAVE'); }
  }
  for (const entry of Object.values(data.maps)) {
    const raw=readFileSync(new URL('../../../'+entry.source.path,import.meta.url));
    assert.equal(digest(raw),entry.source.sha256);
    assert.equal(raw.subarray(entry.source.offset,entry.source.offset+entry.source.bytes).toString().split('\0')[0],entry.source.token);
  }
  for (const entry of data.action_sources) {
    const raw=readFileSync(new URL('../../../'+entry.source_path,import.meta.url)).subarray(entry.offset,entry.offset+176);
    assert.equal(digest(raw),entry.raw_sha256);
    assert.equal(raw.subarray(0x7a,0x8e).toString().split('\0')[0],entry.token);
    assert.equal(raw.readUInt32LE(0x8e),entry.logical_frame);
  }
  for (const cues of Object.values(data.frame_sounds)) for (const entry of Object.values(cues)) {
    const raw=readFileSync(new URL('../../../'+entry.source.path,import.meta.url)).subarray(entry.source.offset,entry.source.offset+0xac);
    assert.equal(digest(raw),entry.source.raw_sha256);
    assert.equal(raw.subarray(0x56,0x6a).toString().split('\0')[0],entry.token);
    assert.equal(raw.readUInt32LE(0x6a),entry.logical_frame);
  }
  for (const entry of Object.values(data.effect_sounds)) {
    const raw=readFileSync(new URL('../../../'+entry.source.path,import.meta.url)).subarray(entry.source.offset,entry.source.offset+0xac);
    assert.equal(digest(raw),entry.source.raw_sha256);
    assert.equal(raw.subarray(0x56,0x6a).toString().split('\0')[0],entry.token);
    assert.equal(raw.readUInt32LE(0x6a),entry.logical_frame);
  }
  for (const entry of Object.values(data.item_effects)) {
    const source=entry.source, raw=readFileSync(new URL('../../../'+source.path,import.meta.url));
    assert.equal(digest(raw),source.sha256);
    const record=raw.subarray(source.record_offset,source.record_offset+0x3bf);
    assert.equal(digest(record),source.record_sha256);
    assert.equal(record.subarray(source.effect_field_offset,source.effect_field_offset+source.effect_field_bytes).toString().split('\0')[0],entry.effect_id===null?'':entry.effect_id+'.dgp');
  }
  assert.deepEqual(data.object_sounds.map(entry=>[entry.map_id,entry.object_index,entry.clip]),
    [['M01042',8,'sound/E015.wav'],['M71071',15,'sound/E034.wav']]);
  for(const entry of data.object_sounds){
    const object=readFileSync(new URL('../../../'+entry.object_source.path,import.meta.url)).subarray(entry.object_source.offset,entry.object_source.offset+0x112);
    const action=readFileSync(new URL('../../../'+entry.action_source.path,import.meta.url)).subarray(entry.action_source.offset,entry.action_source.offset+0xac);
    assert.equal(digest(object),entry.object_source.raw_sha256);assert.equal(object.readUInt32LE(0x9e),entry.object_source.sound_enabled_raw);
    assert.equal(digest(action),entry.action_source.raw_sha256);assert.equal(action.subarray(0x56,0x6a).toString().split('\0')[0],entry.token);
    assert.equal(action.readUInt32LE(0x6a),entry.logical_frame);assert.equal(entry.logical_frame,1);
  }
  const expectedMissing=new Set(['sound/menu/close.wav',...data.action_sources.map(entry=>'sound/'+entry.token),
    ...Object.values(data.frame_sounds).flatMap(cues=>Object.values(cues)).filter(entry=>entry.token).map(entry=>'sound/'+entry.token),
    ...Object.values(data.effect_sounds).filter(entry=>entry.token).map(entry=>'sound/'+entry.token)]
    .filter(source=>!existsSync(new URL('../../../'+source,import.meta.url))));
  assert.deepEqual([...data.missing_original_files].sort(),[...expectedMissing].sort());
  for(const source of data.missing_original_files){
    assert.equal(existsSync(new URL('../../../'+source,import.meta.url)),false,source);
    assert.equal(Object.values(data.clips).some(clip=>clip.source.path.toLowerCase()===source.toLowerCase()),false,'missing originals must never become fabricated clips');
  }
  assert.equal(data.battles['stage13.scn'].clip,null);
  assert.deepEqual(data.battles['stage13.scn'].pool,['sound/Fight/FightBGM01.wav','sound/Fight/FightBGM02.wav']);
});

test('positioned source sounds preserve native distance/pan, existing channel gain, active single-voice playback and node cleanup',async()=>{
  const voices=[],nodes=[],panners=[];let closed=0;
  const context={state:'running',destination:{},createMediaElementSource(media){const node={media,connected:null,disconnects:0,connect(target){this.connected=target;},disconnect(){this.disconnects++;}};nodes.push(node);return node;},
    createStereoPanner(){const node={pan:{value:0},connected:null,disconnects:0,connect(target){this.connected=target;},disconnect(){this.disconnects++;}};panners.push(node);return node;},close(){closed++;}};
  const audio=createAudioController(data,{createMedia:path=>{const media=new Media(path);voices.push(media);return media;},createAudioContext:()=>context});
  const clip=data.cues.menuConfirm.clip;audio.unlock();
  const positions=[{dx:0,dy:0},{dx:8,dy:-6},{dx:-8,dy:6},{dx:64,dy:0},{dx:-65,dy:0}];
  const volume=[127,97,97,0,0],pan=[64,56,72,0,127];
  for(const position of positions)assert.equal(audio.playClip(clip,null,{position,singleVoice:false}),true);
  await tick();assert.equal(voices.length,5);
  assert.deepEqual(audio.snapshot().effect_events.map(event=>event.volume_native),volume);
  assert.deepEqual(audio.snapshot().effect_events.map(event=>event.pan_native),pan);
  assert.deepEqual(panners.map(node=>node.pan.value),[0,-8/64,8/63,-1,1]);
  assert.deepEqual(voices.map(media=>media.volume),volume.map(value=>value/127));
  audio.setChannelVolume('effects',.5);assert.deepEqual(voices.map(media=>media.volume),volume.map(value=>64/127*value/127));
  assert.equal(audio.playClip(clip,null,{position:{dx:32,dy:0},singleVoice:true}),true);assert.equal(voices.length,5);
  assert.equal(voices[0].playCalls,1);assert.equal(voices[0].volume,64/127*31/127);assert.equal(panners[0].pan.value,-.5);
  assert.equal(audio.snapshot().stats.effect_play_attempts,5);assert.equal(audio.snapshot().effect_events.length,5);
  audio.setChannelVolume('effects',1);assert.equal(voices[0].volume,31/127,'later channel changes retain the updated spatial gain');
  for(const media of voices)media.emit('ended');
  assert.deepEqual(nodes.map(node=>node.disconnects),[1,1,1,1,1]);assert.deepEqual(panners.map(node=>node.disconnects),[1,1,1,1,1]);
  assert.equal(audio.playClip(clip,null,{position:{dx:0,dy:0},singleVoice:true}),true);assert.equal(voices.length,6);
  audio.dispose();assert.equal(closed,1);assert.equal(nodes.at(-1).disconnects,1);assert.equal(panners.at(-1).disconnects,1);
});

test('every integrated skill, revival and item effect and lifecycle sound field is exported from its real source',()=>{
  for(const name of ['party_battle_view','battle_lifecycle','item_presentation']){
    const meta=JSON.parse(readFileSync(new URL(`../web/data/${name}.json`,import.meta.url)));
    for(const effect of meta.effects){
      const cue=data.effect_sounds[effect.id];assert.ok(cue,`${name}:${effect.id}`);
      assert.equal(cue.source.sha256,effect.source_sha256);assert.ok(cue.evidence.includes(data.native_evidence['0x5074c0']));
    }
    if(name!=='battle_lifecycle')continue;
    for(const role of meta.roles){const dgp=readFileSync(new URL('../../../'+role.source_dgp,import.meta.url));
      for(const skill of role.skills)for(const step of skill.timeline){
      if(step.kind!=='sprite')continue;
      const raw=Buffer.from(step.raw_hex,'hex'),token=raw.subarray(0x7a,0x8e).toString().split('\0')[0];
      if(token)assert.ok(Object.hasOwn(data.action_tokens,token),`${role.id}:${skill.chr_skill_index}:${token}`);
      const offset=0x43+step.action_index*0xac;
      const dgpToken=dgp.subarray(offset+0x56,offset+0x6a).toString().split('\0')[0];
      if(dgpToken)assert.equal(data.frame_sounds[role.id][step.action_index].token,dgpToken);
    }}
  }
});

test('aid, impact and revival effects play once per instance at their source frame and respect the shared audio lifecycle',async()=>{
  const {audio}=setup();audio.unlock();
  const ids=['BFr01_Nm','BFr01_Up','BFr01_Nd','BFr01_Dn','cvt_p001','cvt_p002','_iRelife'];
  for(const id of ids){
    const cue=data.effect_sounds[id];assert.ok(cue.clip,id);
    assert.equal(audio.playEffect(id,`aid:${id}`,cue.logical_frame+1),false);
    assert.equal(audio.playEffect(id,`aid:${id}`,cue.logical_frame),true);
    assert.equal(audio.playEffect(id,`aid:${id}`,cue.logical_frame),false);
  }
  await tick();assert.equal(audio.snapshot().stats.effects_started,ids.length);
  assert.deepEqual(audio.snapshot().effect_events.map(e=>[e.clip,e.started]),ids.map(id=>[data.effect_sounds[id].clip,true]));
  const cue=data.effect_sounds.BFr01_Nm;
  assert.equal(audio.playEffect('BFr01_Nm','next-action',cue.logical_frame),true);
  audio.setChannelMuted('effects',true);assert.equal(audio.snapshot().effects.length,0);
  assert.equal(audio.playEffect('BFr01_Nm','muted',cue.logical_frame),false);
  audio.setChannelMuted('effects',false);assert.equal(audio.playEffect('BFr01_Nm','after-mute',cue.logical_frame),true);
  audio.setScene({mapId:'M17010'});assert.equal(audio.snapshot().effects.length,0);
  audio.dispose();assert.equal(audio.playEffect('BFr01_Nm','disposed',cue.logical_frame),false);
});

test('operation cues use the separate native table and preserve missing close without substituting another clip',()=>{
  for(const [name,index,token]of [['menuCancel',0,'cancel'],['menuError',0,'cancel'],['menuConfirm',1,'decide'],['menuSelect',2,'select'],['menuOpen',3,'open']]){
    assert.equal(data.cues[name].native_index,index);assert.equal(data.cues[name].clip,'sound/menu/'+token+'.wav');assert.ok(data.cues[name].evidence.length);
  }
  assert.equal(data.cues.menuClose.clip,null);assert.equal(data.cues.menuClose.source,'sound/menu/close.wav');assert.equal(data.cues.legacyMenuConfirm.clip,'sound/menu/mDecide.wav');
});

test('actual cue diagnostics retain play attempts and respect duplicate keys, unlock and effects mute',async()=>{
  const {audio}=setup();assert.equal(audio.playCue('menuOpen','gesture0'),false);audio.unlock();
  assert.equal(audio.playCue('menuOpen','gesture1'),true);assert.equal(audio.playCue('menuSelect','gesture2'),true);
  assert.equal(audio.playCue('menuSelect','gesture2'),false);await tick();
  assert.equal(audio.snapshot().stats.effects_started,2);assert.deepEqual(audio.snapshot().cue_events.map(e=>[e.name,e.played]),[['menuOpen',false],['menuOpen',true],['menuSelect',true],['menuSelect',false]]);
  audio.setChannelMuted('effects',true);assert.equal(audio.playCue('menuError','gesture3'),false);assert.equal(audio.snapshot().stats.effects_started,2);assert.equal(audio.snapshot().cue_events.at(-1).played,false);
});

test('music waits for first gesture, keeps same-track position across map changes, and restores after battle', async () => {
  const manifest=structuredClone(data);
  // The controller fixture exercises battle music even when the exported stage
  // has an unresolved original default; it does not fabricate a runtime map.
  manifest.battles['test.scn']={clip:data.maps.M70010.clip,evidence:[]};
  const {audio,voices}=setup(manifest);
  audio.setScene({mapId:'M17010'}); assert.equal(voices.length,0);
  audio.setScene({mapId:'M17020'}); audio.unlock(); await tick();
  assert.equal(voices.length,1); assert.equal(audio.snapshot().music.started,true);
  voices[0].currentTime=23.5;
  audio.setScene({mapId:'M17026'}); await tick();
  assert.equal(voices.length,1); assert.equal(voices[0].playCalls,1);
  audio.setScene({mapId:'M17026',battle:true,stageId:'test.scn'}); await tick();
  assert.equal(voices[0].paused,true); assert.equal(voices.length,2);
  audio.setScene({mapId:'M17026',battle:false}); await tick();
  assert.equal(voices[1].paused,true); assert.equal(voices.length,3); assert.equal(voices[2].currentTime,23.5);
  const count=audio.snapshot().stats.music_started; audio.setScene({mapId:'M17026'}); await tick();
  assert.equal(audio.snapshot().stats.music_started,count);
});

test('unknown battle mapping stops music and returns to the map without inventing a default', async () => {
  const {audio,voices}=setup(); audio.setScene({mapId:'M70010'}); audio.unlock(); await tick();
  voices[0].currentTime=17;
  audio.setScene({mapId:'M70010',battle:true,stageId:'unknown.scn'}); await tick();
  assert.equal(audio.snapshot().music,null); assert.equal(voices[0].paused,true);
  audio.setScene({mapId:'M70010'}); await tick(); assert.equal(audio.snapshot().music.current_time,17);
  audio.suspend();assert.equal(audio.snapshot().music,null);assert.equal(audio.snapshot().desired_clip,null);
  audio.setScene({mapId:'M70010'});await tick();assert.equal(audio.snapshot().music.current_time,17);
});

test('confirmed native battle music pool selects once per encounter and world-map music restores exploration', async () => {
  const voices=[]; let draws=0;
  const audio=createAudioController(data,{createMedia:path=>{const media=new Media(path);voices.push(media);return media;},rng:()=>{draws++;return .99;}});
  audio.setScene({mapId:'M70010'});audio.unlock();await tick();voices[0].currentTime=21;
  audio.setScene({mapId:'M70010',battle:true,stageId:'stage13.scn'});await tick();
  assert.equal(audio.snapshot().desired_clip,'sound/Fight/FightBGM02.wav');
  voices.at(-1).currentTime=8;
  audio.setScene({mapId:'M70010',battle:true,stageId:'stage13.scn'});await tick();assert.equal(draws,1);
  assert.equal(audio.snapshot().music.current_time,8,'The same encounter does not restart its music');
  audio.setScene({mapId:'M70010',worldMap:true});await tick();assert.equal(audio.snapshot().desired_clip,'sound/mworld.wav');
  audio.setScene({mapId:'M70010'});await tick();assert.equal(audio.snapshot().music.current_time,21);
  audio.setScene({mapId:'M70010',battle:true,stageId:'stage13.scn'});await tick();
  assert.equal(draws,2);assert.equal(audio.snapshot().music.current_time,0,'A fresh encounter plays the intro from the beginning');
});

test('actor DGP sounds use the same logical frame and can play alongside a CHR cue without repeating', async () => {
  const [role,cues]=Object.entries(data.frame_sounds).find(([,entries])=>Object.values(entries).some(entry=>entry.clip));
  const [group,cue]=Object.entries(cues).find(([,entry])=>entry.clip);
  const raw=Buffer.alloc(176);raw.writeUInt32LE(Number(group),1);
  const {audio}=setup();audio.setScene({mapId:'M17010'});audio.unlock();await tick();
  const step={source:{raw_hex:raw.toString('hex'),source:{path:`Fight_Role/${role}.CHR`}},action_index:Number(group),logical_frame:cue.logical_frame};
  assert.equal(audio.playAction({...step,sound_inhibited:true},'frame'),false);
  assert.equal(audio.playAction(step,'frame'),true);assert.equal(audio.playAction(step,'frame'),false);await tick();
  assert.equal(audio.snapshot().stats.effects_started,1);
  assert.equal(audio.snapshot().stats.suppressed_duplicate,1);
});

test('item actor and recovery sounds follow independent manifest source frames and source item-effect IDs', async () => {
  const meta=JSON.parse(readFileSync(new URL('../web/data/item_presentation.json',import.meta.url)));
  for(const role of meta.roles){const cue=data.frame_sounds[role.id][role.actions[0].index];
    if(role.sound_token_raw_56)assert.equal(cue.token,role.sound_token_raw_56);else assert.equal(cue,undefined);
  }
  assert.equal(data.effect_sounds._iReHP.token,'iReHealth.wav');assert.equal(data.effect_sounds._iReMP.token,'_iReMP.wav');
  const {audio}=setup();audio.setScene({mapId:'M17010'});audio.unlock();await tick();
  const role=meta.roles[0],step={source:role.source_plan.records[0],action_index:23,logical_frame:1};
  assert.equal(audio.playAction(step,'item-action:1'),true);assert.equal(audio.playAction(step,'item-action:1'),false);
  assert.equal(audio.playItemEffect(8,'item:8',0),false);assert.equal(audio.playItemEffect(8,'item:8',1),true);
  assert.equal(audio.playItemEffect(8,'item:8',1),false);
  assert.equal(audio.playItemEffect(11,'item:11',1),true);assert.equal(audio.playItemEffect(12,'item:12',1),true);
  assert.equal(audio.playItemEffect(253,'unsupported',1),false);await tick();
  assert.equal(audio.snapshot().stats.effects_started,4);assert.equal(audio.snapshot().stats.suppressed_duplicate,2);
  audio.suspend();assert.equal(audio.snapshot().effects.length,0);
});

test('source logical frame plays an action sound once per action visit and skips missing original clips', async () => {
  const source=data.action_sources.find(entry=>entry.token==='OS01-07.wav');
  const raw=readFileSync(new URL('../../../'+source.source_path,import.meta.url)).subarray(source.offset,source.offset+176).toString('hex');
  const {audio,voices}=setup(); audio.setScene({mapId:'M17010'}); audio.unlock(); await tick();
  const step={source:{raw_hex:raw},logical_frame:source.logical_frame};
  assert.equal(audio.playAction({...step,logical_frame:source.logical_frame+1},'a:1'),false);
  assert.equal(audio.playAction(step,'a:1'),true); await tick();
  assert.equal(audio.playAction(step,'a:1'),false);
  assert.equal(audio.snapshot().stats.suppressed_duplicate,1);
  assert.equal(audio.playAction(step,'a:2'),true); await tick();
  assert.equal(audio.snapshot().stats.effects_started,2);
  voices[1].emit('ended'); assert.equal(audio.snapshot().effects.length,1);
  audio.setScene({mapId:'M17020'}); assert.equal(audio.snapshot().effects.length,0);
  assert.equal(voices[2].paused,true);
  const missing=data.action_sources.find(entry=>data.action_tokens[entry.token]===null);
  const missingRaw=readFileSync(new URL('../../../'+missing.source_path,import.meta.url)).subarray(missing.offset,missing.offset+176).toString('hex');
  assert.equal(audio.playAction({source:{raw_hex:missingRaw},logical_frame:missing.logical_frame},'missing:1'),false);
  assert.equal(audio.snapshot().stats.missing_clips,1);
});

test('volume and mute persist, transient voices are stopped and are bounded', async () => {
  const voices=[],saved=new Map();
  const options={createMedia:path=>{const media=new Media(path);voices.push(media);return media;},storage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)}};
  const audio=createAudioController(data,options); audio.setScene({mapId:'M17010'}); audio.unlock(); await tick();
  for(let i=0;i<12;i++)audio.playCue('menuConfirm',String(i)); await tick();
  assert.equal(audio.snapshot().effects.length,8); assert.equal(voices[1].paused,true);
  audio.setVolume(.3); assert.equal(voices.at(-1).volume,38/127);
  audio.setMuted(true); assert.equal(audio.snapshot().effects.length,0); assert.equal(voices[0].muted,true);
  assert.equal(audio.playCue('menuConfirm'),false); audio.setMuted(false);
  assert.equal(createAudioController(data,options).snapshot().volume,.3);
  assert.equal(createAudioController(data,options).snapshot().muted,false);
  assert.throws(()=>audio.setVolume(2));
  audio.dispose(); assert.equal(voices[0].paused,true); assert.equal(audio.snapshot().disposed,true);
});

test('browser playback rejection is recorded, untrusted gesture is ignored, and real gesture retries', async () => {
  let allowed=false;
  const {audio,voices}=setup(data,()=>allowed?Promise.resolve():Promise.reject(Object.assign(new Error('blocked'),{name:'NotAllowedError'})));
  const listeners=new Map(),target={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  audio.setScene({mapId:'M17010'}); audio.attachUnlock(target);
  listeners.get('pointerdown')({isTrusted:false}); assert.equal(voices.length,0);
  listeners.get('pointerdown')({isTrusted:true}); await tick();
  assert.equal(audio.snapshot().unlocked,false); assert.equal(audio.snapshot().stats.playback_failures,1);
  assert.equal(audio.snapshot().stats.last_error.name,'NotAllowedError');
  allowed=true; listeners.get('keydown')({isTrusted:true}); await tick();
  assert.equal(audio.snapshot().unlocked,true); assert.equal(audio.snapshot().music.started,true);
  assert.equal(audio.snapshot().stats.music_play_attempts,2);
  audio.dispose(); assert.equal(listeners.size,0);
});

test('an old play promise cannot leave audio behind after a scene switch or disposal', async () => {
  const pending=[]; const {audio,voices}=setup(data,()=>new Promise(resolve=>pending.push(resolve)));
  audio.setScene({mapId:'M17010'}); audio.unlock(); audio.playCue('menuConfirm','cue');
  audio.setScene({mapId:'M70010'}); audio.dispose(); pending.forEach(resolve=>resolve()); await tick();
  assert.equal(audio.snapshot().music,null); assert.equal(audio.snapshot().effects.length,0);
  assert.ok(voices.every(media=>media.paused)); assert.equal(audio.snapshot().stats.music_started,0);
  const unsafe=structuredClone(data); Object.values(unsafe.clips)[0].path='/assets/audio/../oops.mp3';
  assert.throws(()=>validateAudioManifest(unsafe));
});
