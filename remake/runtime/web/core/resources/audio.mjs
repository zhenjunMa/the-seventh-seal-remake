// Source-backed clips with a browser-owned playback policy. The operation menu
// has master, music and effects controls. Native 0x45D1B0 mixes their 0..64
// integer values into 1..127 gain; the browser media backend is still an adapter.
import {isNativeMapId} from '../exploration/native_map_identity.mjs';
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const clone = value => structuredClone(value);
const clipPath = value => typeof value === 'string' && /^\/assets\/(?:audio|startup\/audio)\/[A-Za-z0-9_./-]+\.(?:mp3|wav)$/.test(value)
  && !value.split('/').some(part => part === '.' || part === '..');
const digest = value => /^[a-f0-9]{64}$/.test(value);
const clipId = value => typeof value === 'string' && /^[A-Za-z0-9_./-]+$/.test(value);

function validateMapAmbience(data) {
  if (data == null) return;
  requireValue(data.schema === 'seventh-seal-map-ambience' && data.version === 1
    && data.clips && data.maps, '地图环境音清单版本无效');
  for (const [id, clip] of Object.entries(data.clips)) {
    requireValue(/^sound\/[a-z0-9_-]+\.wav$/.test(id) && clip.source?.path === id
      && /^\/assets\/audio\/ambience\/[a-z0-9_-]+\.(wav|mp3)$/.test(clip.path)
      && clip.mime === (clip.path.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg')
      && digest(clip.sha256) && clip.source.sha256 === clip.sha256, '地图环境音文件无效');
  }
  for (const [id, map] of Object.entries(data.maps)) {
    requireValue(isNativeMapId(id) && Number.isInteger(map.coordinate_shift)
      && map.coordinate_shift >= 1 && map.coordinate_shift <= 16 && Array.isArray(map.emitters), '地图环境声源无效');
    let previous = -1;
    for (const row of map.emitters) {
      requireValue([row.object_index, row.resource_id, row.x, row.y, row.interval_ms].every(Number.isInteger)
        && row.object_index > previous && row.resource_id > 0 && /^[a-z0-9_-]+\.wav$/i.test(row.token)
        && (row.clip === null || row.clip === 'sound/' + row.token.toLowerCase() && data.clips[row.clip]), '地图环境声源无效');
      previous = row.object_index;
    }
  }
}

function spatialLevels(position) {
  const volumeNative = position ? Math.max(0, 127 - 3 * Math.trunc(Math.hypot(position.dx, position.dy))) : 127;
  const panNative = position ? Math.max(0, Math.min(127, 64 - position.dx)) : 64;
  return {volumeNative, panNative, gain:volumeNative / 127, pan:(panNative - 64) / (panNative < 64 ? 64 : 63)};
}

function mapAmbienceGroups(map, clips) {
  const groups = new Map();
  for (const row of map?.emitters ?? []) {
    const clip = row.clip ?? 'sound/' + row.token.toLowerCase();
    if (!clips[clip]) continue;
    // 0x4102b0 groups negative intervals by the DAT object resource ID.
    const key = row.interval_ms < 0 ? `resource:${row.resource_id}` : `object:${row.object_index}`;
    if (!groups.has(key)) groups.set(key, {key, clip, interval:row.interval_ms, points:[], nextPlay:null, failed:false});
    groups.get(key).points.push(row);
  }
  return [...groups.values()];
}

export function validateAudioManifest(data) {
  requireValue(data?.schema === 'seventh-seal-audio' && data.version === 1 && data.clips && data.maps && data.battles && data.cues, '音乐音效清单版本无效');
  for (const [id, clip] of Object.entries(data.clips)) {
    requireValue(clipId(id) && clipPath(clip.path) && ['audio/mpeg', 'audio/wav'].includes(clip.mime)
      && digest(clip.sha256) && digest(clip.source?.sha256) && clip.source.path?.startsWith('sound/'), '音频资源来源无效');
  }
  for (const entry of [...Object.values(data.maps), ...Object.values(data.battles), ...Object.values(data.cues), ...(data.world_map ? [data.world_map] : [])]) {
    requireValue(entry && (entry.clip === null || clipId(entry.clip)) && Array.isArray(entry.evidence)
      && (!entry.pool || Array.isArray(entry.pool) && entry.pool.length > 0 && entry.pool.every(clipId)), '音乐场景或音效映射无效');
  }
  for (const entry of [...Object.values(data.frame_sounds ?? {}).flatMap(cues => Object.values(cues)), ...Object.values(data.effect_sounds ?? {})]) {
    requireValue(entry && (entry.clip === null || data.clips[entry.clip]) && Number.isInteger(entry.logical_frame) && entry.logical_frame >= 0
      && digest(entry.source?.sha256) && digest(entry.source?.raw_sha256), '原动作音效字段无效');
  }
  for (const entry of Object.values(data.item_effects ?? {})) requireValue((entry.effect_id===null||data.effect_sounds?.[entry.effect_id]) && digest(entry.source?.sha256), '道具特效声音映射无效');
  for(const [token,clip]of Object.entries(data.native_sound_tokens??{}))requireValue((token===''||/^[A-Za-z0-9_-]+\.wav$/i.test(token))
    &&(clip===null||data.clips[clip]),'原对白音效映射无效');
  for(const entry of data.native_sound_sources??[])requireValue(data.native_sound_tokens?.[entry.token]===entry.clip
    &&digest(entry.source?.sha256)&&digest(entry.source?.raw_sha256)&&entry.source.token_offset===0x37,'原对白音效来源无效');
  return data;
}

export function createAudioController(manifest, options = {}) {
  validateAudioManifest(manifest);
  const mapAmbience = options.mapAmbience;
  validateMapAmbience(mapAmbience);
  const ambientClips = {...manifest.clips, ...mapAmbience?.clips};
  const clipsByName = new Map(Object.entries(manifest.clips).map(([id, clip]) => [id.toLowerCase(), clip]));
  const getClip = id => typeof id === 'string' && (Object.hasOwn(manifest.clips, id)
    ? manifest.clips[id] : clipsByName.get(id.toLowerCase()));
  const createMedia = options.createMedia ?? (path => new Audio(path));
  const getBattleEffectRate = options.getBattleEffectRate ?? (() => 1);
  const storage = options.storage ?? null, storageKey = options.storageKey ?? 'seventh-seal-audio-v1';
  let saved = null;
  try { saved = JSON.parse(storage?.getItem(storageKey) ?? 'null'); } catch {}
  const volumeValue = value => { const number = Number(value); requireValue(Number.isFinite(number) && number >= 0 && number <= 1, '音量须在 0 至 1 之间'); return number; };
  const channelNames = ['master', 'music', 'effects'];
  const savedVolume = (value, fallback) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
  const channels = Object.fromEntries(channelNames.map(name => [name, {
    volume: volumeValue(options.channels?.[name]?.volume ?? (name === 'master' ? options.volume : undefined)
      ?? savedVolume(saved?.channels?.[name]?.volume, name === 'master' ? savedVolume(saved?.volume, 1) : 1)),
    muted: Boolean(options.channels?.[name]?.muted ?? (name === 'master' ? options.muted : undefined)
      ?? saved?.channels?.[name]?.muted ?? (name === 'master' && saved?.muted === true))
  }]));
  const channelVolume = name => Math.max(1, Math.min(127,
    Math.floor(2 * Math.round(channels.master.volume * 64) * Math.round(channels[name].volume * 64) / 64))) / 127;
  const channelMuted = name => channels.master.muted || channels[name].muted;
  let unlocked = false, disposed = false, storyMusicSuppressed=false;
  let positionalContext = null;
  const musicVolume=()=>storyMusicSuppressed?0:channelVolume('music');
  let scene = {mapId:null, battle:false, stageId:null, worldMap:false}, desired = null, music = null, cleanupUnlock = null;
  let nextId = 0;
  const effects = new Map(), ambience = new Map(), seen = new Set(), positions = new Map(), cueEvents=[], effectEvents=[];
  let ambientGroups = null, coordinateShift = 0;
  let cueSequence=0;
  const stats = {unlock_attempts:0, music_play_attempts:0, effect_play_attempts:0, music_started:0, effects_started:0,
    playback_failures:0, suppressed_before_unlock:0, suppressed_duplicate:0, missing_clips:0, last_error:null};
  const persist = () => { try { storage?.setItem(storageKey, JSON.stringify({version:2,
    volume:channels.master.volume, muted:channels.master.muted, channels})); } catch {} };
  const errorRecord = (error, kind, clip) => {
    stats.playback_failures++; stats.last_error = {kind, clip, name:String(error?.name ?? 'Error'), message:String(error?.message ?? error)};
  };
  const stop = media => { try { media.pause(); } catch {} };
  const retire = media => { stop(media); try { media.removeAttribute?.('src'); media.load?.(); } catch {} };
  function clearVoices(voices) {
    for (const entry of voices.values()) { entry.clean(); retire(entry.media); }
    voices.clear();
  }
  function stopEffects() { clearVoices(effects); }
  function clearAmbience() { clearVoices(ambience); ambientGroups = null; }
  function stopClip(clipId) {
    for(const [key,entry] of effects)if(entry.clip===clipId){entry.clean();retire(entry.media);effects.delete(key);}
  }
  function clearMusic() {
    if (!music) return;
    if (Number.isFinite(music.media.currentTime)) positions.set(music.clip, music.media.currentTime);
    music.clean(); retire(music.media); music = null;
  }
  function playMusic() {
    if (!music || !unlocked || disposed || music.pending || (!music.media.paused && music.started)) return;
    const entry = music; entry.pending = true; stats.music_play_attempts++;
    let result;
    try { result = entry.media.play(); } catch (error) { result = Promise.reject(error); }
    Promise.resolve(result).then(() => {
      entry.pending = false;
      if (disposed || music !== entry) { stop(entry.media); return; }
      entry.started = true; stats.music_started++; stats.last_error = null;
    }).catch(error => {
      entry.pending = false;
      if (music !== entry || disposed) return;
      errorRecord(error, 'music', entry.clip);
      if (error?.name === 'NotAllowedError') unlocked = false;
    });
  }
  function syncMusic() {
    if (disposed) return;
    if (music?.clip === desired) { playMusic(); return; }
    clearMusic();
    const clip = getClip(desired);
    if (!clip || !unlocked) return;
    const media = createMedia(clip.path);
    media.preload = 'auto'; media.loop = true; media.volume = musicVolume(); media.muted = channelMuted('music');
    const entry = {id:++nextId, clip:desired, media, started:false, pending:false, clean:() => {}};
    const restorePosition = () => {
      if (music !== entry) return;
      const time = positions.get(entry.clip) ?? 0;
      if (time > 0) { try { media.currentTime = Number.isFinite(media.duration) && media.duration > 0 ? time % media.duration : time; } catch {} }
    };
    const failed = () => { if (music === entry) errorRecord(media.error ?? new Error('音频加载失败'), 'music', entry.clip); };
    media.addEventListener?.('loadedmetadata', restorePosition);
    media.addEventListener?.('error', failed);
    entry.clean = () => { media.removeEventListener?.('loadedmetadata', restorePosition); media.removeEventListener?.('error', failed); };
    music = entry; restorePosition(); playMusic();
  }
  function setScene(next) {
    requireValue(next && isNativeMapId(next.mapId), '音乐场景地图无效');
    const nextScene = {mapId:next.mapId, battle:next.battle === true, stageId:next.stageId ?? null, worldMap:next.worldMap === true};
    const changed = Object.keys(nextScene).some(key => scene[key] !== nextScene[key]);
    if (changed) { stopEffects(); clearAmbience(); seen.clear(); }
    scene = nextScene;
    if (!scene.battle && !scene.worldMap && ambientGroups === null) {
      const map = mapAmbience?.maps[scene.mapId];
      ambientGroups = mapAmbienceGroups(map, ambientClips); coordinateShift = map?.coordinate_shift ?? 0;
    }
    const mapping = scene.battle ? manifest.battles[scene.stageId ?? scene.mapId] : scene.worldMap ? manifest.world_map : manifest.maps[scene.mapId];
    const pool = mapping?.pool?.filter(getClip);
    if (pool?.length && (changed || !pool.includes(desired))) {
      const draw = (options.rng ?? Math.random)();
      requireValue(Number.isFinite(draw) && draw >= 0 && draw < 1, '音乐随机数无效');
      desired = pool[Math.floor(draw * pool.length)];
    } else if (!pool?.length && !mapping?.inherit) desired = getClip(mapping?.clip) ? mapping.clip : null;
    if(changed&&scene.battle)positions.delete(desired);
    syncMusic(); return snapshot();
  }
  function setMusic(clipId) {
    if (clipId !== null && !getClip(clipId)) return snapshot();
    if(desired!==clipId){stopEffects();clearAmbience();seen.clear();}
    desired=clipId;syncMusic();return snapshot();
  }
  function unlock() {
    if (disposed) return false;
    stats.unlock_attempts++; unlocked = true; syncMusic();
    if(positionalContext?.state==='suspended')positionalContext.resume().catch(error=>errorRecord(error,'positioned-effect',null));
    return true;
  }
  function attachUnlock(target = globalThis.document) {
    requireValue(target?.addEventListener && target?.removeEventListener, '音频解锁事件目标无效');
    cleanupUnlock?.();
    const listener = event => { if (!unlocked && event.isTrusted !== false) unlock(); };
    target.addEventListener('pointerdown', listener, true); target.addEventListener('keydown', listener, true);
    cleanupUnlock = () => { target.removeEventListener('pointerdown', listener, true); target.removeEventListener('keydown', listener, true); };
    return cleanupUnlock;
  }
  function playClip(clipId, eventKey = null, {position=null,singleVoice=false,loop=false,battleEffect=false}={}) {
    if (disposed || channelMuted('effects')) return false;
    if (!unlocked) { stats.suppressed_before_unlock++; return false; }
    const clip = getClip(clipId);
    if (!clip) { stats.missing_clips++; return false; }
    const levels = spatialLevels(position);
    // 52D938/52D8A8 apply new levels before 52D74A checks quick_status.
    // An active handle moves in the stereo field without restarting its clip.
    if(singleVoice){
      const current=[...effects.values()].find(entry=>entry.clip===clipId);
      if(current){setVoiceLevels(current,levels);return true;}
    }
    if (eventKey !== null && seen.has(eventKey)) { stats.suppressed_duplicate++; return false; }
    if (eventKey !== null) { seen.add(eventKey); if (seen.size > 2048) seen.delete(seen.values().next().value); }
    // Keep transient sound voices bounded and retire their load/play listeners.
    if (effects.size >= 8) {
      const [key,oldest] = effects.entries().next().value;
      oldest.clean(); retire(oldest.media); effects.delete(key);
    }
    const event={clip:clipId,event_key:eventKey,started:false,...(position?{position:{...position},volume_native:levels.volumeNative,pan_native:levels.panNative}:{})};
    effectEvents.push(event);if(effectEvents.length>256)effectEvents.shift();
    startVoice(effects,++nextId,clipId,clip.path,{levels,position,loop,event,battleEffect});
    return true;
  }
  function setVoiceLevels(entry,{gain,pan}) {
    if(entry.gain!==gain){entry.gain=gain;entry.media.volume=channelVolume('effects')*gain;}
    if(entry.panner&&entry.panner.pan.value!==pan)entry.panner.pan.value=pan;
  }
  function startVoice(voices,key,clipId,path,{levels,position,loop,event,onError,battleEffect=false}) {
    const media = createMedia(path);
    let cleanSpatial=()=>{},panner=null;
    const Context = globalThis.AudioContext??globalThis.webkitAudioContext;
    if(position && (options.createAudioContext || Context)){
      positionalContext??=(options.createAudioContext??(()=>new Context()))();
      const source=positionalContext.createMediaElementSource(media);panner=positionalContext.createStereoPanner();
      source.connect(panner);panner.connect(positionalContext.destination);
      cleanSpatial=()=>{source.disconnect();panner.disconnect();};
      if(positionalContext.state==='suspended')positionalContext.resume().catch(error=>errorRecord(error,'positioned-effect',clipId));
    }
    media.preload = 'auto'; media.loop = Boolean(loop); media.muted = channelMuted('effects');
    if(battleEffect)media.playbackRate=getBattleEffectRate();
    const entry = {clip:clipId, media, panner, battleEffect, started:false, clean:() => {}};
    setVoiceLevels(entry,levels);
    const current = () => !disposed && voices.get(key) === entry;
    const finish = () => { if(current()){entry.clean();voices.delete(key);retire(media);} };
    const failed = error => {
      if (!current()) return;
      errorRecord(error,event?'effect':'map-ambience',clipId); finish();
      if (error?.name === 'NotAllowedError') unlocked = false;
      else onError?.();
    };
    const mediaError = () => failed(media.error ?? new Error('音效加载失败'));
    media.addEventListener?.('ended', finish); media.addEventListener?.('error', mediaError);
    entry.clean = () => { media.removeEventListener?.('ended', finish); media.removeEventListener?.('error', mediaError);cleanSpatial(); };
    voices.set(key,entry); stats.effect_play_attempts++;
    let result;
    try { result = media.play(); } catch (error) { result = Promise.reject(error); }
    Promise.resolve(result).then(() => {
      if (!current()) { stop(media); return; }
      entry.started = true; if(event)event.started = true; stats.effects_started++;
    }).catch(failed);
  }
  function updateMapAmbience(mapId,listener,now) {
    if (!ambientGroups?.length || scene.mapId !== mapId || !unlocked) return;
    const x = Math.trunc(listener.x / 2), y = Math.trunc(listener.y / 2);
    for (const group of ambientGroups) {
      if (group.failed) continue;
      if (group.interval > 0) {
        group.nextPlay ??= now + group.interval;
        if (now < group.nextPlay) continue;
        group.nextPlay = now + group.interval;
      }
      let dx = Infinity, dy = Infinity;
      // 0x419760 selects the closest signed offset on each axis separately.
      for (const point of group.points) {
        const px = ((x - point.x) >> coordinateShift) * 2, py = ((point.y - y) >> coordinateShift) * 2;
        if (Math.abs(px) < Math.abs(dx)) dx = px;
        if (Math.abs(py) < Math.abs(dy)) dy = py;
      }
      const position = {dx,dy}, levels = spatialLevels(position), entry = ambience.get(group.key);
      if (entry) setVoiceLevels(entry,levels);
      if (!entry && !channelMuted('effects')) {
        startVoice(ambience,group.key,group.clip,ambientClips[group.clip].path,
          {levels,position,loop:group.interval<=0,onError:()=>{group.failed=true;}});
      }
    }
  }
  function playCue(name, eventKey = null) {
    const cue = manifest.cues[name];
    if (!cue?.clip) return false;
    const played=playClip(cue.clip, eventKey);
    cueEvents.push({sequence:++cueSequence,name,clip:cue.clip,event_key:eventKey,played});if(cueEvents.length>256)cueEvents.shift();
    return played;
  }
  function syncBattleEffectRate(){
    const rate=getBattleEffectRate();
    for(const entry of effects.values())if(entry.battleEffect)entry.media.playbackRate=rate;
  }
  const playBattleClip=(clipId,eventKey)=>playClip(clipId,eventKey,{battleEffect:true});
  function playAction(step, eventKey) {
    const raw = step?.source?.raw_hex ?? step?.raw_hex;
    if (typeof raw !== 'string' || !/^(?:[a-f0-9]{2}){176}$/i.test(raw)) return false;
    const b = Uint8Array.from(raw.match(/../g), part => parseInt(part, 16)), v = new DataView(b.buffer);
    if (b[0] !== 0 || step.sound_inhibited === true) return false;
    const origin = step.source?.source?.path ?? step.source?.path ?? step.source?.source?.source ?? step.source?.source ?? '';
    const roleId = step.resource_id ?? (typeof origin === 'string' ? /Fight_Role\/(\d+)\.CHR$/i.exec(origin)?.[1] : null);
    const frameCue = manifest.frame_sounds?.[roleId]?.[step.action_index];
    const key = eventKey ?? `${step.actor_id ?? ''}:${step.source_skill_index}:${step.plan_record_index}:${step.logical_frame}`;
    let played = false;
    if (frameCue && frameCue.logical_frame === step.logical_frame) played = playBattleClip(frameCue.clip, `${key}:dgp`);
    if (step.logical_frame !== v.getUint32(0x8e, true)) return played;
    const token = new TextDecoder().decode(b.slice(0x7a, 0x8e)).split('\0')[0];
    if (!token) return played;
    return playBattleClip(manifest.action_tokens?.[token] ?? null, `${key}:chr`) || played;
  }
  function playEffect(effectId, eventKey, logicalFrame = 0) {
    const cue = manifest.effect_sounds?.[effectId];
    if (!cue?.clip || logicalFrame !== cue.logical_frame) return false;
    return playBattleClip(cue.clip, `${eventKey}:effect:${effectId}`);
  }
  function playItemEffect(itemId, eventKey, logicalFrame = 0) {
    return playEffect(manifest.item_effects?.[String(itemId)]?.effect_id,eventKey,logicalFrame);
  }
  function refreshLevels() {
    if (music) { music.media.volume = musicVolume(); music.media.muted = channelMuted('music'); }
    for (const voices of [effects,ambience]) for (const entry of voices.values()) {
      entry.media.volume = channelVolume('effects')*entry.gain; entry.media.muted = channelMuted('effects');
    }
    if (channelMuted('effects')) stopEffects();
  }
  function setChannelVolume(name, value) {
    requireValue(channelNames.includes(name), '音量通道无效');
    channels[name].volume = volumeValue(value); refreshLevels(); persist(); return snapshot();
  }
  function setChannelMuted(name, value) {
    requireValue(channelNames.includes(name), '音量通道无效');
    channels[name].muted = Boolean(value); refreshLevels(); persist(); return snapshot();
  }
  function setVolume(value) { return setChannelVolume('master', value); }
  function setMuted(value) { return setChannelMuted('master', value); }
  // ANM 63/62 temporarily mutes/restores the map music gain. This must not
  // rewrite the player's persisted channel preferences or stop music time.
  function setStoryMusicSuppressed(value){storyMusicSuppressed=Boolean(value);refreshLevels();return snapshot();}
  function snapshot() {
    return clone({scene, desired_clip:desired, unlocked, disposed,
      volume:channels.master.volume, muted:channels.master.muted, channels,story_music_suppressed:storyMusicSuppressed,
      music:music ? {clip:music.clip, path:manifest.clips[music.clip].path, started:music.started, pending:music.pending,
        paused:music.media.paused, current_time:Number.isFinite(music.media.currentTime) ? music.media.currentTime : null,
        ready_state:music.media.readyState ?? null} : null,
      effects:[...effects.values()].map(entry => ({clip:entry.clip, started:entry.started, paused:entry.media.paused})),
      ambience:[...ambience.values()].map(entry => ({clip:entry.clip,started:entry.started,volume:entry.media.volume,
        muted:entry.media.muted,pan:entry.panner?.pan.value??0})), cue_events:cueEvents, effect_events:effectEvents, stats});
  }
  function suspend() { desired = null; clearMusic(); stopEffects(); clearAmbience(); seen.clear(); return snapshot(); }
  function dispose() { if (disposed) return; disposed = true; cleanupUnlock?.(); cleanupUnlock = null; clearMusic(); stopEffects(); clearAmbience(); seen.clear();positionalContext?.close(); }
  return {setScene, setMusic, getClip, unlock, attachUnlock, updateMapAmbience, playCue, playClip, playAction, playEffect, playItemEffect, setMuted, setVolume,
    setChannelMuted, setChannelVolume,setStoryMusicSuppressed, syncBattleEffectRate, stopEffects, stopClip, suspend, snapshot, dispose};
}
