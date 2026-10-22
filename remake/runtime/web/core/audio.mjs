// Source-backed clips with a browser-owned playback policy. The operation menu
// has master, music and effects controls. Native 0x45D1B0 mixes their 0..64
// integer values into 1..127 gain; the browser media backend is still an adapter.
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const clone = value => structuredClone(value);
const clipPath = value => typeof value === 'string' && /^\/assets\/(?:audio|startup\/audio)\/[A-Za-z0-9_./-]+\.(?:mp3|wav)$/.test(value)
  && !value.split('/').some(part => part === '.' || part === '..');
const digest = value => /^[a-f0-9]{64}$/.test(value);

export function validateAudioManifest(data) {
  requireValue(data?.schema === 'seventh-seal-audio' && data.version === 1 && data.clips && data.maps && data.battles && data.cues, '音乐音效清单版本无效');
  for (const [id, clip] of Object.entries(data.clips)) {
    requireValue(/^[A-Za-z0-9_./-]+$/.test(id) && clipPath(clip.path) && ['audio/mpeg', 'audio/wav'].includes(clip.mime)
      && digest(clip.sha256) && digest(clip.source?.sha256) && clip.source.path?.startsWith('sound/'), '音频资源来源无效');
  }
  for (const entry of [...Object.values(data.maps), ...Object.values(data.battles), ...Object.values(data.cues), ...(data.world_map ? [data.world_map] : [])]) {
    requireValue(entry && (entry.clip === null || data.clips[entry.clip]) && Array.isArray(entry.evidence)
      && (!entry.pool || Array.isArray(entry.pool) && entry.pool.length > 0 && entry.pool.every(id => data.clips[id])), '音乐场景或音效映射无效');
  }
  for (const entry of [...Object.values(data.frame_sounds ?? {}).flatMap(cues => Object.values(cues)), ...Object.values(data.effect_sounds ?? {})]) {
    requireValue(entry && (entry.clip === null || data.clips[entry.clip]) && Number.isInteger(entry.logical_frame) && entry.logical_frame >= 0
      && digest(entry.source?.sha256) && digest(entry.source?.raw_sha256), '原动作音效字段无效');
  }
  for (const entry of Object.values(data.item_effects ?? {})) requireValue(data.effect_sounds?.[entry.effect_id] && digest(entry.source?.sha256), '道具特效声音映射无效');
  return data;
}

export function createAudioController(manifest, options = {}) {
  validateAudioManifest(manifest);
  const createMedia = options.createMedia ?? (path => new Audio(path));
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
  let unlocked = false, disposed = false;
  let scene = {mapId:null, battle:false, stageId:null, worldMap:false}, desired = null, music = null, cleanupUnlock = null;
  let nextId = 0;
  const effects = new Set(), seen = new Set(), positions = new Map(), cueEvents=[];
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
  function stopEffects() {
    for (const entry of effects) { entry.clean(); retire(entry.media); }
    effects.clear();
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
    if (!desired || !unlocked) return;
    const clip = manifest.clips[desired], media = createMedia(clip.path);
    media.preload = 'auto'; media.loop = true; media.volume = channelVolume('music'); media.muted = channelMuted('music');
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
    requireValue(next && typeof next.mapId === 'string' && /^M\d{5}$/.test(next.mapId), '音乐场景地图无效');
    const nextScene = {mapId:next.mapId, battle:next.battle === true, stageId:next.stageId ?? null, worldMap:next.worldMap === true};
    const changed = Object.keys(nextScene).some(key => scene[key] !== nextScene[key]);
    if (changed) { stopEffects(); seen.clear(); }
    scene = nextScene;
    const mapping = scene.battle ? manifest.battles[scene.stageId ?? scene.mapId] : scene.worldMap ? manifest.world_map : manifest.maps[scene.mapId];
    if (mapping?.pool && (changed || !mapping.pool.includes(desired))) {
      const draw = (options.rng ?? Math.random)();
      requireValue(Number.isFinite(draw) && draw >= 0 && draw < 1, '音乐随机数无效');
      desired = mapping.pool[Math.floor(draw * mapping.pool.length)];
    } else if (!mapping?.pool) desired = mapping?.clip ?? null;
    syncMusic(); return snapshot();
  }
  function setMusic(clipId) {
    requireValue(clipId===null||Boolean(manifest.clips[clipId]), '音乐资源无效');
    if(desired!==clipId){stopEffects();seen.clear();}
    desired=clipId;syncMusic();return snapshot();
  }
  function unlock() {
    if (disposed) return false;
    stats.unlock_attempts++; unlocked = true; syncMusic(); return true;
  }
  function attachUnlock(target = globalThis.document) {
    requireValue(target?.addEventListener && target?.removeEventListener, '音频解锁事件目标无效');
    cleanupUnlock?.();
    const listener = event => { if (!unlocked && event.isTrusted !== false) unlock(); };
    target.addEventListener('pointerdown', listener, true); target.addEventListener('keydown', listener, true);
    cleanupUnlock = () => { target.removeEventListener('pointerdown', listener, true); target.removeEventListener('keydown', listener, true); };
    return cleanupUnlock;
  }
  function playClip(clipId, eventKey = null) {
    if (disposed || channelMuted('effects')) return false;
    if (!unlocked) { stats.suppressed_before_unlock++; return false; }
    if (!manifest.clips[clipId]) { stats.missing_clips++; return false; }
    if (eventKey !== null && seen.has(eventKey)) { stats.suppressed_duplicate++; return false; }
    if (eventKey !== null) { seen.add(eventKey); if (seen.size > 2048) seen.delete(seen.values().next().value); }
    // Keep transient sound voices bounded and retire their load/play listeners.
    if (effects.size >= 8) { const oldest = effects.values().next().value; oldest.clean(); retire(oldest.media); effects.delete(oldest); }
    const media = createMedia(manifest.clips[clipId].path);
    media.preload = 'auto'; media.loop = false; media.volume = channelVolume('effects'); media.muted = channelMuted('effects');
    const entry = {id:++nextId, clip:clipId, media, started:false, clean:() => {}};
    const finish = () => { entry.clean(); effects.delete(entry); retire(media); };
    const failed = () => { if (effects.has(entry)) errorRecord(media.error ?? new Error('音效加载失败'), 'effect', clipId); finish(); };
    media.addEventListener?.('ended', finish); media.addEventListener?.('error', failed);
    entry.clean = () => { media.removeEventListener?.('ended', finish); media.removeEventListener?.('error', failed); };
    effects.add(entry); stats.effect_play_attempts++;
    let result;
    try { result = media.play(); } catch (error) { result = Promise.reject(error); }
    Promise.resolve(result).then(() => {
      if (disposed || !effects.has(entry)) { stop(media); return; }
      entry.started = true; stats.effects_started++;
    }).catch(error => {
      if (!effects.has(entry) || disposed) return;
      errorRecord(error, 'effect', clipId); finish();
      if (error?.name === 'NotAllowedError') unlocked = false;
    });
    return true;
  }
  function playCue(name, eventKey = null) {
    const cue = manifest.cues[name];
    if (!cue?.clip) return false;
    const played=playClip(cue.clip, eventKey);
    cueEvents.push({sequence:++cueSequence,name,clip:cue.clip,event_key:eventKey,played});if(cueEvents.length>256)cueEvents.shift();
    return played;
  }
  function playAction(step, eventKey) {
    const raw = step?.source?.raw_hex ?? step?.raw_hex;
    if (typeof raw !== 'string' || !/^(?:[a-f0-9]{2}){176}$/i.test(raw)) return false;
    const b = Uint8Array.from(raw.match(/../g), part => parseInt(part, 16)), v = new DataView(b.buffer);
    if (b[0] !== 0 || step.sound_inhibited === true) return false;
    const origin = step.source?.source?.path ?? step.source?.source?.source ?? step.source?.source ?? '';
    const roleId = typeof origin === 'string' ? /Fight_Role\/(\d+)\.CHR$/i.exec(origin)?.[1] : null;
    const frameCue = manifest.frame_sounds?.[roleId]?.[step.action_index];
    const key = eventKey ?? `${step.actor_id ?? ''}:${step.source_skill_index}:${step.plan_record_index}:${step.logical_frame}`;
    let played = false;
    if (frameCue && frameCue.logical_frame === step.logical_frame) played = playClip(frameCue.clip, `${key}:dgp`);
    if (step.logical_frame !== v.getUint32(0x8e, true)) return played;
    const token = new TextDecoder().decode(b.slice(0x7a, 0x8e)).split('\0')[0];
    if (!token) return played;
    return playClip(manifest.action_tokens?.[token] ?? null, `${key}:chr`) || played;
  }
  function playItemEffect(itemId, eventKey, logicalFrame = 0) {
    const mapping = manifest.item_effects?.[String(itemId)], cue = manifest.effect_sounds?.[mapping?.effect_id];
    if (!cue?.clip || logicalFrame !== cue.logical_frame) return false;
    return playClip(cue.clip, `${eventKey}:item-effect:${mapping.effect_id}`);
  }
  function refreshLevels() {
    if (music) { music.media.volume = channelVolume('music'); music.media.muted = channelMuted('music'); }
    for (const entry of effects) { entry.media.volume = channelVolume('effects'); entry.media.muted = channelMuted('effects'); }
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
  function snapshot() {
    return clone({scene, desired_clip:desired, unlocked, disposed,
      volume:channels.master.volume, muted:channels.master.muted, channels,
      music:music ? {clip:music.clip, path:manifest.clips[music.clip].path, started:music.started, pending:music.pending,
        paused:music.media.paused, current_time:Number.isFinite(music.media.currentTime) ? music.media.currentTime : null,
        ready_state:music.media.readyState ?? null} : null,
      effects:[...effects].map(entry => ({clip:entry.clip, started:entry.started, paused:entry.media.paused})), cue_events:cueEvents, stats});
  }
  function suspend() { desired = null; clearMusic(); stopEffects(); seen.clear(); return snapshot(); }
  function dispose() { if (disposed) return; disposed = true; cleanupUnlock?.(); cleanupUnlock = null; clearMusic(); stopEffects(); seen.clear(); }
  return {setScene, setMusic, unlock, attachUnlock, playCue, playClip, playAction, playItemEffect, setMuted, setVolume,
    setChannelMuted, setChannelVolume, stopEffects, suspend, snapshot, dispose};
}
