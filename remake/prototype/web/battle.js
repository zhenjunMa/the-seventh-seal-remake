import { hpState, effectiveHp, manualSettlement, userPositionCompatibility, RULE_EVIDENCE } from './battle_rules.mjs';
import { skillSequence, previewTravel, sceneEnvelope, validSceneMessage } from './battle_presentation.mjs';

const $ = id => document.getElementById(id);
const MANIFEST_URL = new URL('combat_manifest.json', location.href);
const startedAt = performance.now();
const session = { schema: 'seventh-seal-combat-lab-events', version: 1,
  session_id: crypto.randomUUID?.() || `lab-${Date.now()}`,
  created_at: new Date().toISOString(), timezone: 'Asia/Shanghai',
  scope: 'local-asset animation and explicit-input subrule experiment; no original gameplay execution',
  manifest: null, rule_evidence: RULE_EVIDENCE, events: [] };
const tracks = { player: null, enemy: null };
const imageCache = new Map();
const generations = { player: 0, enemy: 0 };
const phaseText = { preview: '动画浏览', ready: '实验就绪', playing: '播放一次动作', waiting: '待结算',
  nonlethal: '手工伤害 · 非致死', death: 'HP 合同 · 死亡处理', rejected: '原分类提前拒绝',
  'roll-failed': '显式比较未通过', 'observed-rejected': 'MISS（用户观察规则）', blocked: 'HP 字段门阻止扣减' };
let manifest = null, observations = null, manifestHash = null, phase = 'preview', entered = false;
let target = hpState(), maxHp = 100, paused = false, fps = 10, lastTime = performance.now();
const sceneParams = new URLSearchParams(location.search);
const embedded = sceneParams.get('embedded') === '1' && window.parent !== window;
const sceneSession = sceneParams.get('sceneSession');
let presentation = null, presentationRun = null, presentationGeneration = 0, impact = null;
let initialized = false, pendingSceneContext = null;
if (embedded) document.body.classList.add('embedded');

function notify(message) { $('status').textContent = message; }
function notifySelection(subject) {
  const source = $('sequenceMode').checked ? '将按技能动作序列施放' :
    tracks.player?.nativeActionRecord ? '玩家按已确认 type 0 索引播放单段' : '玩家图集动作独立选择';
  const readiness = !entered ? '当前为动画浏览，可进入开发实验' : effectiveHp(target) <= 0 ?
    '目标 HP 已归零，重建 HP 后可继续实验' : '当前实验已就绪，可播放选定动作';
  notify(`${subject}。${source}；${readiness}。目标 HP 保持 ${effectiveHp(target)}。`);
}
function showError(error) {
  $('error').hidden = false;
  $('error').textContent = `${error.message || error}`;
  log('error', '错误', { error: String(error.message || error) });
}
function clearError() { $('error').hidden = true; $('error').textContent = ''; }
function guarded(handler) {
  return async event => { try { clearError(); await handler(event); } catch (error) { showError(error); } };
}
const controlIds = ['playerRole', 'playerSkill', 'skillAction', 'playerAction', 'playerDirection',
  'enemyAction', 'enemyDirection', 'targetSkill', 'fps', 'settlementTiming', 'knownDamage', 'sequenceMode',
  'useObservedPositions', 'useClassGate', 'actionMask', 'targetClass', 'targetSkillGate', 'effectToken', 'useRoll',
  'roll', 'threshold', 'zoneUpper', 'zoneMiddle', 'zoneLower', 'initialHp', 'sideRaw',
  'roleLinkRaw', 'linkedHpBonus', 'statusHpRaw', 'stateRaw', 'gate679c6c', 'gate55ee004', 'gate55edfec'];
function inputs() {
  return Object.fromEntries(controlIds.map(id => [id, $(id).type === 'checkbox' ? $(id).checked : $(id).value]));
}
function trackSnapshot(track) {
  if (!track) return null;
  return { role_id: track.role.id, role_name: track.role.name,
    source: track.role.source, source_sha256: track.role.sha256,
    source_hashes: track.role.source_hashes || null,
    identity_status: track.role.identity_status || track.role.status || 'see_manifest_evidence',
    action_index: track.action.index, direction_raw: track.direction, frame_in_direction: track.frame,
    source_frame_index: track.action.first_frame + track.direction * track.action.frames_per_direction + track.frame,
    interval_raw: track.action.interval_raw, loop_raw: track.action.loop_raw,
    sheet: track.sheetURL, sheet_sha256: track.sheetHash,
    skill_to_animation_pairing: track.mappingBasis || 'independent_dgp_selection',
    selected_native_action_record: track.nativeActionRecord || null };
}
function log(kind, message, detail = {}) {
  const event = { sequence: session.events.length + 1, at: new Date().toISOString(),
    elapsed_ms: Math.round((performance.now() - startedAt) * 1000) / 1000,
    kind, message, phase, frames: { player: trackSnapshot(tracks.player), enemy: trackSnapshot(tracks.enemy) },
    inputs: inputs(), target_state: { ...target }, presentation: presentationRun ? {
      skill_name: presentationRun.skill.name, segment: presentationRun.index,
      cursor: presentationRun.cursor, scheduler_basis: presentationRun.sequence.scheduler_basis,
      original_hit_frame: null, source_combat_event: presentationRun.segments[presentationRun.index]?.combat_event || null,
      choreography: 'preview_approach_and_return',
      effects: currentEffects().map(e => ({ asset_id: e.asset.id, source: e.asset.source,
        source_sha256: e.asset.sha256 || e.asset.source_sha256, sheet_sha256: e.loaded.hash,
        frame: effectFrame(e), placement: e.placement, blend: e.asset.blend,
        placement_basis: 'native-actor-slot; preview-screen-projection' })) } : null, ...detail };
  session.events.push(event);
  const item = document.createElement('li'), time = document.createElement('time');
  time.textContent = new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
  item.append(time, document.createTextNode(message));
  $('eventLog').append(item);
  while ($('eventLog').children.length > 80) $('eventLog').firstChild.remove();
  $('eventLog').scrollTop = $('eventLog').scrollHeight;
  $('logCount').textContent = `${session.events.length} 条`;
}
function number(id, optional = false) {
  const raw = $(id).value.trim();
  if (raw === '' && optional) return null;
  const result = raw === '' ? NaN : Number(raw);
  if (!Number.isInteger(result)) throw new Error(`${id} 需要整数输入`);
  return result;
}
function selectedSkill() {
  return tracks.player?.role.skills?.find(s => String(s.index) === $('playerSkill').value) || null;
}
function selectedSkillAction() {
  return selectedSkill()?.actions?.find(a => String(a.index) === $('skillAction').value) || null;
}
const positionLabels = { upper: '上', middle: '中', lower: '下' };
function selectedPositionObservation() {
  const skill = selectedSkill();
  return observations?.skills?.find(record => record.names.includes(skill?.name)) || null;
}
function observedTargetPositions() {
  return [['zoneUpper', 'upper'], ['zoneMiddle', 'middle'], ['zoneLower', 'lower']]
    .filter(([id]) => $(id).checked).map(([, position]) => position);
}
function positionText(positions) { return positions === null ? '未知' : positions.map(p => positionLabels[p]).join('、') || '未选择'; }
function updatePositionNote() {
  const observation = selectedPositionObservation();
  $('observedPositions').textContent = `技能：${positionText(observation?.target_positions || null)}；目标：${positionText(observedTargetPositions())}。` +
    `来源：用户观察（${observations?.reported_date || '待读取'}），不建立原位号编码。`;
}
function options(select, values, label, previous = null) {
  select.replaceChildren();
  for (const value of values) {
    const option = document.createElement('option');
    option.value = String(value.index ?? value.id ?? value.value);
    option.textContent = label(value); select.append(option);
  }
  if (previous !== null && [...select.options].some(o => o.value === String(previous))) select.value = String(previous);
  select.disabled = !values.length;
}
function populateSkills(role) {
  const initialSkill = role.skills?.find(skill => skill.name === '炎剑．燕突');
  const connected = presentation?.skills?.filter(s => s.role_id === role.id).map(s => s.skill_index) || [];
  const skills = $('sequenceMode').checked && connected.length ? role.skills.filter(s => connected.includes(s.index)) : role.skills || [];
  options($('playerSkill'), skills, s => s.name || `未命名技能记录 ${s.index}（原 ID ${s.id_raw}）`, initialSkill?.index ?? null);
  populateSkillActions();
}
function populateSkillActions(keepSelection = false) {
  const role = tracks.player?.role || manifest.roles.find(r => r.id === $('playerRole').value);
  const skill = role?.skills?.find(s => String(s.index) === $('playerSkill').value);
  const initial = keepSelection ? $('skillAction').value : skill?.actions?.find(a => a.type_raw === 0)?.index ?? null;
  options($('skillAction'), skill?.actions || [], a => `记录 ${a.index} · 原 type ${a.type_raw}`, initial);
  const action = skill?.actions?.find(a => String(a.index) === $('skillAction').value);
  $('actionMask').value = Number.isInteger(action?.raw_reject_mask) ? action.raw_reject_mask : '';
  const verified = role?.native_action_index_verified === true || manifest.native_action_index_verified === true;
  $('mappingNote').textContent = action ?
    `检查记录 ${action.index}，图集编号字段 ${action.dgp_action_index ?? '未知'}。${verified && action.type_raw === 0 ? 'type 0 图集索引已有原生证据。' : '此记录不直接播放图像。'}勾选动作序列时，施放会使用全部已接入图像段；单段模式只播放此记录。` :
    '此资源没有可读取的技能动作记录。仍可独立浏览图集；完整技能执行未接入。';
  updatePositionNote();
}
async function applyVerifiedSkillMapping() {
  const record = selectedSkillAction(), role = tracks.player?.role;
  if (!record || record.type_raw !== 0 || !(role?.native_action_index_verified === true || manifest.native_action_index_verified === true)) {
    if (tracks.player) { tracks.player.mappingBasis = 'independent_dgp_selection'; tracks.player.nativeActionRecord = null; }
    return;
  }
  if (!role.actions.some(a => a.index === record.dgp_action_index)) throw new Error('已确认的技能动作图集编号超出已提取动作范围');
  await setTrack('player', role, record.dgp_action_index, record);
  log('native-index-pairing', '依据已确认 type 0 索引选择图集单段；未执行完整技能命令',
    { selected_action_record: record, original_hit_frame: null });
}
function populateDirections(kind, action) {
  options($(`${kind}Direction`), Array.from({ length: action.directions }, (_, i) => ({ value: i })), d => `原编号 ${d.value}`);
}
function validateRole(role) {
  if (!role || !Number.isInteger(role.frame_width) || !Number.isInteger(role.frame_height) ||
      role.frame_width <= 0 || role.frame_height <= 0 || !role.actions?.length) throw new Error('角色图集尺寸或动作清单无效');
  for (const action of role.actions) {
    if (!Number.isInteger(action.index) || !Number.isInteger(action.directions) || action.directions < 1 ||
        !Number.isInteger(action.frames_per_direction) || action.frames_per_direction < 1 ||
        !Number.isInteger(action.first_frame) || typeof action.sheet !== 'string') throw new Error(`资源 ${role.id} 动作格式无效`);
  }
}
async function digest(bytes) {
  if (!crypto.subtle) throw new Error('资源 SHA-256 需要本地 HTTP / localhost 环境，请使用原型启动入口');
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join('');
}
async function loadImage(action, role) {
  const url = new URL(action.sheet, MANIFEST_URL);
  const assetRoot = new URL('assets/', location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith(assetRoot.pathname) || !url.pathname.toLowerCase().endsWith('.png')) {
    throw new Error('图集路径必须指向本地 assets 内的 PNG');
  }
  if (!imageCache.has(url.href)) imageCache.set(url.href, (async () => {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`图集读取失败 (${response.status})：${url.pathname}`);
    const bytes = await response.arrayBuffer(), hash = await digest(bytes);
    const objectURL = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    const image = new Image();
    try { image.src = objectURL; await image.decode(); } finally { URL.revokeObjectURL(objectURL); }
    return { image, hash, url: url.href, bounds: new Map() };
  })());
  let loaded;
  try { loaded = await imageCache.get(url.href); } catch (error) { imageCache.delete(url.href); throw error; }
  if (action.sheet_sha256 && action.sheet_sha256 !== loaded.hash) throw new Error(`图集 SHA-256 与清单不符：${role.id} / ${action.index}`);
  if (loaded.image.width !== role.frame_width * action.frames_per_direction || loaded.image.height !== role.frame_height * action.directions) {
    throw new Error(`图集布局不符：${role.id} / 动作 ${action.index}。需列=帧、行=方向，实际 ${loaded.image.width}×${loaded.image.height}`);
  }
  return loaded;
}
function directionBounds(loaded, role, action, direction) {
  if (loaded.bounds.has(direction)) return loaded.bounds.get(direction);
  // A stable union over this direction's frames avoids resizing the sprite each frame.
  // Only the browser display is cropped; original frames and exported PNGs stay intact.
  const scratch = document.createElement('canvas'); scratch.width = role.frame_width; scratch.height = role.frame_height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  let left = role.frame_width, top = role.frame_height, right = -1, bottom = -1;
  for (let frame = 0; frame < action.frames_per_direction; frame++) {
    ctx.clearRect(0, 0, scratch.width, scratch.height);
    ctx.drawImage(loaded.image, frame * role.frame_width, direction * role.frame_height,
      role.frame_width, role.frame_height, 0, 0, role.frame_width, role.frame_height);
    const pixels = ctx.getImageData(0, 0, scratch.width, scratch.height).data;
    for (let y = 0; y < role.frame_height; y++) for (let x = 0; x < role.frame_width; x++) {
      if (!pixels[(y * role.frame_width + x) * 4 + 3]) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  const bounds = right < 0 ? { left: 0, top: 0, width: role.frame_width, height: role.frame_height }
    : { left, top, width: right - left + 1, height: bottom - top + 1 };
  loaded.bounds.set(direction, bounds); return bounds;
}
function cancelAttack(reason) {
  if (phase === 'playing' || phase === 'waiting') log('attack-aborted', reason);
  if (presentationRun?.reactionActive) tracks.enemy = presentationRun.enemyBefore;
  presentationGeneration++; presentationRun = null; impact = null;
  phase = entered ? 'ready' : 'preview';
}
async function setTrack(kind, role, actionIndex = null, nativeActionRecord = null) {
  validateRole(role);
  const generation = ++generations[kind];
  const action = role.actions.find(a => String(a.index) === String(actionIndex)) || role.actions[0];
  tracks[kind] = { role, action, direction: 0, frame: 0, elapsed: 0, image: null, sheetHash: null,
    mappingBasis: nativeActionRecord ? 'verified_native_type0_index_single_segment' : 'independent_dgp_selection',
    nativeActionRecord };
  options($(`${kind}Action`), role.actions, a => `原组 ${a.index} · ${a.frames_per_direction} 帧 × ${a.directions} 方向`, action.index);
  populateDirections(kind, action); updateUI();
  const loaded = await loadImage(action, role);
  if (generation !== generations[kind]) return;
  Object.assign(tracks[kind], { image: loaded.image, sheetHash: loaded.hash, sheetURL: loaded.url,
    loaded, contentBounds: directionBounds(loaded, role, action, 0) });
  log('resource-selected', `${kind === 'player' ? '玩家' : '敌方'}图集：${role.name} / 原组 ${action.index}`, { input_origin: 'resource_selection' });
  updateUI();
}
function selectedTrack() { return tracks[$('inspectActor').value]; }
function updateUI() {
  const loaded = Boolean(tracks.player?.image && tracks.enemy?.image);
  $('phaseLabel').textContent = presentationRun && phase === 'playing' ? '技能播放' :
    presentationRun && phase === 'waiting' ? '演示完成 · 伤害待核对' : phaseText[phase] || phase;
  $('enterExperiment').disabled = !loaded;
  $('attack').disabled = !loaded || !entered || ['playing', 'death'].includes(phase) ||
    (phase === 'waiting' && !$('sequenceMode').checked) || effectiveHp(target) <= 0;
  $('settle').disabled = !loaded || !(phase === 'waiting' || (phase === 'playing' && $('settlementTiming').value === 'manual'));
  for (const id of ['playPause', 'stepFrame', 'resetAnimation', 'rebuildHp']) $(id).disabled = !loaded;
  $('stepFrame').disabled = !loaded || Boolean(presentationRun?.loading);
  $('playPause').textContent = paused ? '自动播放' : '暂停';
  $('hpLabel').textContent = `实验 HP ${effectiveHp(target)} / ${maxHp} · raw ${target.raw_hp}`;
  $('hpBar').style.width = `${Math.min(100, Math.max(0, effectiveHp(target) / maxHp * 100))}%`;
  if (tracks.player) {
    $('playerName').textContent = `${tracks.player.role.name} · 资源 ${tracks.player.role.id}`;
    $('playerSource').textContent = tracks.player.nativeActionRecord ?
      '按已确认 type 0 索引播放技能动作单段' : '独立图集动作选择 · 完整技能命令未执行';
  }
  if ($('sequenceMode').checked) {
    $('playerSource').textContent = '技能动作序列 · 使用原作帧，接近与退回轨迹为演示';
    const recipe = presentation?.skills?.find(s => s.role_id === tracks.player?.role.id && s.skill_index === selectedSkill()?.index);
    $('skillScope').textContent = recipe ? '已接入人物动作、通用烟尘与受击光效。技能自身特效尚未完整显示，原版数值仍待核对。' :
      '此技能暂可浏览人物动作，独立特效尚未接入。英格妮的燕突、瓦裂、破霞已列为本轮样本。';
  } else $('skillScope').textContent = '单段检查模式：独立选择图集与帧，不编排交战动作。';
  if (tracks.enemy) {
    $('enemyName').textContent = `${tracks.enemy.role.name} · 资源 ${tracks.enemy.role.id}`;
    $('enemyAction').value = String(tracks.enemy.action.index);
  }
  const track = selectedTrack();
  if (track) {
    $('frameSlider').disabled = phase === 'playing' && Boolean(presentationRun);
    $('frameSlider').max = track.action.frames_per_direction - 1;
    $('frameSlider').value = track.frame;
    $('frameLabel').textContent = `${track.frame + 1} / ${track.action.frames_per_direction} · 原方向 ${track.direction}`;
    $('timingNote').textContent = `原 interval_raw ${track.action.interval_raw ?? '未知'} / loop_raw ${track.action.loop_raw ?? '未知'}；当前按实验 ${fps} fps 播放。`;
  }
  $('sequenceLabel').textContent = presentationRun ?
    `${presentationRun.skill.name} · 动作 ${presentationRun.index + 1}/${presentationRun.segments.length}` :
    $('sequenceMode').checked ? '选择技能后施放：准备 → 接近 → 出招／特效 → 退回' : '单段逐帧检查';
  updatePositionNote();
}
function rebuiltTarget() {
  return hpState({ raw_hp: number('initialHp'), side_raw: number('sideRaw'), role_link_raw: number('roleLinkRaw'),
    linked_hp_bonus: number('linkedHpBonus'), status_hp_raw: number('statusHpRaw'), state_raw: number('stateRaw') });
}
function resetTarget() {
  const next = rebuiltTarget();
  if (next.raw_hp < 0) throw new Error('实验初始原 HP 应非负');
  cancelAttack('重建 HP 前取消未完成动作'); target = next; maxHp = Math.max(1, effectiveHp(next));
  log('hp-reset', '重建目标 HP 实验（显式输入，不是原版敌人属性）', { input_origin: 'manual_hp_fields' });
  notify('目标已重新开始。选择技能后施放；伤害留空时只看表现，HP 保持不变。'); updateUI();
}
async function beginAttack() {
  if ($('attack').disabled) throw new Error('请先进入开发实验，并重建可用目标');
  if (phase === 'waiting') cancelAttack('重新施放，取消上一次数值待核对的演示');
  if ($('sequenceMode').checked) { await beginSkillPresentation(); return; }
  tracks.player.frame = 0; tracks.player.elapsed = 0; paused = false; phase = 'playing';
  log('attack-start', '开始播放一次实验攻击动作', { input_origin: 'attack_button',
    selected_skill_record: selectedSkill()?.index ?? null, selected_action_record: selectedSkillAction() || null,
    timing_contract: 'one selected DGP direction segment; original hit frame unknown' });
  notify('动作播放中。末帧后等待手工结算；可暂停或逐帧检查。'); updateUI();
}
function endAttack() {
  phase = 'waiting';
  if (presentationRun) presentationRun.activeEffects = [];
  log('awaiting-settlement', '动作到达实验结束帧，HP 尚未改变', { input_origin: 'lab_frame_clock', original_hit_frame: null });
  notify('动作序列结束。伤害留空时只展示战斗表现；可输入已知伤害核对HP。此时点未认定为原命中帧。'); updateUI();
  if (presentationRun && $('knownDamage').value.trim() !== '') {
    try { settleAttack(); } catch (error) { showError(error); }
  }
}
function advance(kind, origin) {
  const track = tracks[kind]; if (!track?.image) return;
  if (kind === 'player' && phase === 'playing') {
    if (presentationRun) {
      if (presentationRun.loading) return;
      if (presentationRun.cursor < presentationRun.segments[presentationRun.index].frames.length - 1) {
        presentationRun.cursor++; track.frame = presentationRun.segments[presentationRun.index].frames[presentationRun.cursor];
      } else if (presentationRun.index < presentationRun.segments.length - 1) {
        presentationRun.index++; presentationRun.cursor = 0; activatePresentationSegment();
      } else { endAttack(); return; }
      presentationRun.step++;
      triggerPresentationEvents();
      log('skill-frame', '技能动作序列推进', { input_origin: origin }); updateUI(); return;
    }
    if (track.frame >= track.action.frames_per_direction - 1) { endAttack(); return; }
    track.frame++;
    log('attack-frame', `攻击动画：原组 ${track.action.index} / 方向 ${track.direction} / 帧 ${track.frame}`, { input_origin: origin });
  } else if (kind === 'enemy' && presentationRun?.reactionActive) {
    if (track.frame < track.action.frames_per_direction - 1) track.frame++;
    else { tracks.enemy = presentationRun.enemyBefore; presentationRun.reactionActive = false; }
  } else if (kind === 'player' && !['ready', 'preview'].includes(phase) && origin !== 'step_button') return;
  else if (kind === 'enemy' && phase === 'death' && origin !== 'step_button') return;
  else track.frame = (track.frame + 1) % track.action.frames_per_direction;
  if (origin === 'step_button') log('frame-step', `${kind === 'player' ? '玩家' : '敌方'}逐帧检查`, { input_origin: origin });
  updateUI();
}

function currentEffects() {
  return presentationRun?.activeEffects?.filter(e => presentationRun.step - e.started_step < e.action.frames_per_direction) || [];
}
function effectFrame(effect) {
  return Math.max(0, Math.min(effect.action.frames_per_direction - 1, presentationRun.step - effect.started_step));
}
function triggerPresentationEvents() {
  const run = presentationRun, segment = run.segments[run.index], frame = tracks.player.frame;
  for (const effect of segment.loadedEffects) {
    const eventFrame = effect.trigger_frame ?? segment.frames[0];
    const key = `${run.index}:${effect.asset.id}`;
    if (frame === eventFrame && !run.triggeredEffects.has(key)) {
      run.triggeredEffects.add(key);
      const observed = $('useObservedPositions').checked ?
        userPositionCompatibility(selectedPositionObservation()?.target_positions || null, observedTargetPositions()) : { compatible: null };
      if (effect.placement === 'target' && (observed.compatible === false || $('knownDamage').value.trim() === '0')) {
        log('effect-skipped', '观察MISS或显式零伤害：不展示受击目标特效', { asset_id: effect.asset.id }); continue;
      }
      run.activeEffects.push({ ...effect, started_step: run.step });
      log('original-effect-trigger', `原作特效 ${effect.asset.name || effect.asset.id}`, {
        source_field: effect.filename_field || effect.field || null, source_event_field: effect.event_field || null,
        source_frame: frame, placement: effect.placement,
        condition: effect.condition || null, playback_condition_basis: 'visual_preview; full-native-damage-gates-not-evaluated' });
    }
  }
  if (!run.impactShown && segment.combat_event && frame === segment.combat_event.frame) showPresentationImpact();
  else if (!run.impactShown && !run.sequence.recipe && run.index === Math.floor(run.segments.length / 2) &&
    run.cursor >= Math.floor(segment.frames.length / 2)) showPresentationImpact();
}
function activatePresentationSegment() {
  const run = presentationRun, segment = run.segments[run.index];
  tracks.player = { ...segment.track, frame: segment.frames[0], elapsed: 0 };
  options($('playerAction'), run.role.actions, a => `原组 ${a.index} · ${a.frames_per_direction} 帧 × ${a.directions} 方向`, segment.action.index);
  populateDirections('player', segment.action);
  log('skill-segment', `技能动作 ${run.index + 1}/${run.segments.length} · 原组 ${segment.action.index}`, {
    chr_record_index: segment.record.index, sequence_basis: segment.sequence_basis,
    original_effect_trigger_frame_and_actor_slot_confirmed: Boolean(run.sequence.recipe),
    original_wall_clock_timing_and_screen_projection_confirmed: false });
}
async function beginSkillPresentation() {
  const role = tracks.player.role, skill = selectedSkill(), sequence = skillSequence(role, skill, presentation);
  const generation = ++presentationGeneration;
  phase = 'playing'; paused = false;
  presentationRun = { role, skill, sequence, segments: [], index: 0, cursor: 0, step: 0, loading: true,
    impactShown: false, activeEffects: [], triggeredEffects: new Set(), enemyBefore: tracks.enemy, reactionActive: false };
  notify('正在准备本次技能的全部人物动作与原作特效…'); updateUI();
  try {
    const segments = await Promise.all(sequence.segments.map(async segment => {
      const loaded = await loadImage(segment.action, role);
      const direction = Math.min(tracks.player.direction, segment.action.directions - 1);
      const track = { role, action: segment.action, direction, frame: segment.frames[0], elapsed: 0,
        image: loaded.image, loaded, sheetHash: loaded.hash, sheetURL: loaded.url,
        contentBounds: directionBounds(loaded, role, segment.action, direction),
        mappingBasis: 'verified_native_type0_index_skill_sequence', nativeActionRecord: segment.record };
      const loadedEffects = await Promise.all(segment.effects.map(async effect => {
        const assetId = effect.asset_id || effect.id;
        const asset = presentation?.assets?.find(a => a.id === assetId);
        if (!asset) throw new Error(`技能特效资源缺失：${assetId}`);
        const action = asset.actions.find(a => a.index === (effect.action_index ?? 0)) || asset.actions[0];
        const loaded = await loadImage(action, asset);
        return { ...effect, asset, action, loaded, bounds: directionBounds(loaded, asset, action, 0) };
      }));
      return { ...segment, track, loadedEffects };
    }));
    if (generation !== presentationGeneration) return;
    presentationRun.segments = segments;
    if (sequence.recipe?.target_reaction) {
      const reaction = sequence.recipe.target_reaction;
      const enemy = manifest.roles.find(r => r.id === reaction.role_id);
      const action = enemy?.actions.find(a => a.index === reaction.action_index);
      if (!enemy || !action) throw new Error('受击动作未在原始目标资源中找到');
      const loaded = await loadImage(action, enemy);
      if (generation !== presentationGeneration) return;
      presentationRun.reaction = { ...reaction, track: { role: enemy, action, direction: 0, frame: 0, elapsed: 0,
        image: loaded.image, loaded, sheetHash: loaded.hash, sheetURL: loaded.url,
        contentBounds: directionBounds(loaded, enemy, action, 0), mappingBasis: 'native-normal-surviving-reaction-branch' } };
    }
    const bounds = segments.map(s => s.track.contentBounds);
    const left = Math.min(...bounds.map(b => b.left)), top = Math.min(...bounds.map(b => b.top));
    presentationRun.bounds = { left, top, width: Math.max(...bounds.map(b => b.left + b.width)) - left,
      height: Math.max(...bounds.map(b => b.top + b.height)) - top };
    presentationRun.loading = false;
    activatePresentationSegment();
    triggerPresentationEvents();
    log('skill-presentation-start', `施放 ${skill.name} · ${segments.length} 段真实人物动作`, {
      original_hit_frame: null, omitted_command_types: sequence.omitted_command_types,
      presentation_source: session.presentation_manifest || null });
    notify(`${skill.name}：人物接近目标、施放并退回。使用原作图像，移动轨迹与特效时序为演示；伤害留空时只看表现。`); updateUI();
  } catch (error) {
    if (generation === presentationGeneration) { presentationRun = null; phase = entered ? 'ready' : 'preview'; updateUI(); }
    throw error;
  }
}
function showPresentationImpact() {
  const compatibility = $('useObservedPositions').checked ?
    userPositionCompatibility(selectedPositionObservation()?.target_positions || null, observedTargetPositions()) :
    { compatible: null };
  presentationRun.impactShown = true;
  impact = { at: performance.now(), compatible: compatibility.compatible,
    text: compatibility.compatible === false ? 'MISS' : compatibility.compatible === null ? '方位待核对' : '命中表现' };
  if (compatibility.compatible === true && presentationRun.reaction) {
    tracks.enemy = { ...presentationRun.reaction.track, elapsed: 0 };
    presentationRun.reactionActive = true;
  }
  log('presentation-contact', '源字段结算事件对应的演示接触：目标反馈不代替完整原版命中／伤害', {
    user_position_compatibility: compatibility,
    combat_event: presentationRun.segments[presentationRun.index].combat_event || null,
    reaction: presentationRun.reaction ? { action_index: presentationRun.reaction.action_index,
      condition: presentationRun.reaction.condition, basis: 'normal-branch-sprite-preview; no-complete-native-target-state' } : null,
    hp_unchanged: true });
}
function settleAttack() {
  if ($('settle').disabled) throw new Error('尚未到达实验结算时点');
  if ($('useObservedPositions').checked) {
    const record = selectedPositionObservation(), skillPositions = record?.target_positions || null;
    const targetPositions = observedTargetPositions();
    const compatibility = userPositionCompatibility(skillPositions, targetPositions);
    log('user-position-check', '依据用户观察检查明确方位数组的交集', {
      source: observations.source, reported_date: observations.reported_date, evidence_type: 'user_reported',
      selected_skill_name: selectedSkill()?.name || null, skill_positions: skillPositions,
      target_positions: targetPositions, result: compatibility, native_raw_encoding_established: false });
    if (compatibility.status === 'unknown') {
      notify('待验证：所选技能方位未知，HP 未改变。可选择已观察技能，或关闭用户观察规则以单独测试 HP。'); return;
    }
    if (!compatibility.compatible) {
      phase = 'observed-rejected';
      log('observation-rule-rejected', 'MISS（用户观察规则）：方位不符，HP 未改变');
      notify('MISS（用户观察规则）：方位不符，HP 未改变。依据用户观察的方位数组交集；未认定为原分类门或完整原版命中判定。'); updateUI(); return;
    }
  }
  const args = { target, damage: number('knownDamage', true), attackerIndex: tracks.player.role.id === '002' ? 1 : 0,
    useClassGate: $('useClassGate').checked, actionMask: number('actionMask', true), targetClass: number('targetClass', true),
    targetSkillGate: number('targetSkillGate'), effectToken: number('effectToken'), useRoll: $('useRoll').checked,
    roll: number('roll', true), threshold: number('threshold', true), gates: {
      global_00679c6c: Number($('gate679c6c').checked), global_055ee004: Number($('gate55ee004').checked),
      global_055edfec: Number($('gate55edfec').checked) } };
  const result = manualSettlement(args);
  log('settlement-request', '在本次实验帧请求结算', { input_origin: 'manual_settlement_button',
    experiment_parameters: args, result, original_hit_frame: null,
    damage_origin: args.damage === null ? 'unresolved' : 'manual_known_damage',
    excluded_rules: ['complete_damage_formula', 'full_skill_execution', 'world_victory_and_return_state'] });
  if (result.status === 'unresolved') { notify(`继续待验证：${result.reason}。HP 未改变。`); return; }
  target = result.target;
  if (result.status === 'raw-class-rejected') {
    phase = 'rejected'; notify('原分类拒绝子规则成立，返回 -1；HP 未改变。没有将位号解释为上／中／下。');
  } else if (result.status === 'explicit-roll-failed') {
    phase = 'roll-failed'; notify('显式 roll ≤ threshold 子项未通过，HP 未改变；这不是完整原版命中判定。');
  } else if (!result.applied) {
    phase = 'blocked'; notify('HP 字段门阻止扣减，状态未改变。可检查字段或重建实验。');
  } else if (result.native_return === 1) {
    phase = 'death'; notify('手工伤害触发死亡处理合同，state_raw=4。死亡动画、胜利与世界状态未执行。可导出日志或返回地图预览。');
  } else {
    phase = 'nonlethal'; notify(`手工伤害实验完成：目标有效 HP ${result.effective_hp}。可继续一次攻击，或重建 HP。`);
  }
  log('settlement-result', phaseText[phase], { result }); updateUI();
}

const context = $('battleStage').getContext('2d');
function draw() {
  const canvas = $('battleStage'), rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1), width = rect.width, height = rect.height;
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, width, height);
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#0d1723'); gradient.addColorStop(1, '#243242');
  context.fillStyle = gradient; context.fillRect(0, 0, width, height);
  context.strokeStyle = '#849aae15'; context.lineWidth = 1;
  for (let x = 0; x < width; x += 32) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke(); }
  for (let y = 0; y < height; y += 32) { context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke(); }
  context.fillStyle = '#8192a5'; context.font = '11px "Microsoft YaHei", sans-serif';
  context.fillText('原作人物与通用效果 · 技能自身特效尚未完整显示', 18, 26);
  const run = presentationRun;
  const travel = run && !run.loading ? previewTravel(run.index, run.segments.length,
    run.cursor / Math.max(1, run.segments[run.index].frames.length - 1)) : 0;
  const impactAge = impact ? performance.now() - impact.at : Infinity;
  const actorPositions = { player: .75 - travel * .32, enemy: .25 };
  for (const kind of ['enemy', 'player']) {
    const track = tracks[kind], x = width * actorPositions[kind] +
      (kind === 'enemy' && impact?.compatible === true && impactAge < 650 ? Math.sin(impactAge / 35) * 9 * (1 - impactAge / 650) : 0), y = height * .63;
    context.strokeStyle = '#acb9c538'; context.beginPath(); context.ellipse(x, y + 28, Math.min(width * .16, 95), 16, 0, 0, Math.PI * 2); context.stroke();
    if (!track?.image) continue;
    const role = track.role, bounds = track.contentBounds;
    const scaleBounds = kind === 'player' && run?.bounds ? run.bounds : bounds;
    const scale = Math.min(3, width * .36 / scaleBounds.width, height * .48 / scaleBounds.height);
    const anchor = role.anchor || { x: role.frame_width / 2, y: role.frame_height };
    context.imageSmoothingEnabled = false;
    context.save(); context.translate(x, y);
    // Battle art already faces the opposing side: players left, monsters right.
    // Preserve its orientation when projecting actors into their screen slots.
    context.drawImage(track.image, track.frame * role.frame_width + bounds.left,
      track.direction * role.frame_height + bounds.top, bounds.width, bounds.height,
      (bounds.left - anchor.x) * scale, (bounds.top - anchor.y) * scale,
      bounds.width * scale, bounds.height * scale);
    context.restore();
    context.fillStyle = '#c3ced9'; context.textAlign = 'center';
    context.fillText(`${kind === 'player' ? '玩家' : '敌方'} · 原组 ${track.action.index} / 方向 ${track.direction}`, x, height - 46);
    if (kind === 'enemy' && phase === 'death') { context.fillStyle = '#ddbc79'; context.fillText('实验 HP 已归零 · 死亡合同', x, height - 24); }
    context.textAlign = 'left';
  }
  for (const [effectIndex, effect] of currentEffects().entries()) {
    const frame = effectFrame(effect), asset = effect.asset, bounds = effect.bounds;
    const scale = Math.min(3, width * .44 / bounds.width, height * .62 / bounds.height);
    const x = width * actorPositions[effect.placement === 'player' ? 'player' : 'enemy'];
    const y = height * .63;
    const anchor = asset.anchor || { x: asset.frame_width / 2, y: asset.frame_height / 2 };
    context.save(); context.imageSmoothingEnabled = false;
    context.globalCompositeOperation = asset.blend === 'additive' ? 'lighter' : 'source-over';
    context.translate(x, y);
    // Attached effects use the same unmirrored source coordinates as the actor.
    context.drawImage(effect.loaded.image, frame * asset.frame_width + bounds.left, bounds.top,
      bounds.width, bounds.height, (bounds.left - anchor.x) * scale, (bounds.top - anchor.y) * scale,
      bounds.width * scale, bounds.height * scale); context.restore();
    context.fillStyle = '#ddbc79'; context.font = '11px "Microsoft YaHei", sans-serif';
    context.fillText(`原作特效 ${asset.name || asset.id} · 帧 ${frame + 1}`, 18, 48 + effectIndex * 14);
  }
  if (impact && impactAge < 1000) {
    context.save(); context.globalAlpha = 1 - impactAge / 1000;
    context.textAlign = 'center'; context.font = 'bold 24px "Microsoft YaHei", sans-serif';
    context.fillStyle = impact.compatible === false ? '#ced5df' : '#f3d99a';
    context.fillText(impact.text, width * actorPositions.enemy, height * .29 - impactAge / 80); context.restore();
  }
}
function tick(now) {
  const elapsed = Math.min(200, now - lastTime); lastTime = now;
  if (!paused) for (const kind of ['player', 'enemy']) {
    const track = tracks[kind]; if (!track?.image) continue;
    track.elapsed += elapsed;
    while (track.elapsed >= 1000 / fps) { track.elapsed -= 1000 / fps; advance(kind, 'automatic_lab_clock'); }
  }
  draw(); requestAnimationFrame(tick);
}
function exportLog() {
  log('log-export', '导出实验日志', { input_origin: 'export_button' });
  const blob = new Blob([JSON.stringify({ ...session, final_phase: phase, final_target: target }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = `combat-lab-${session.session_id}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000); notify('实验日志已导出，包含时间、帧、输入、资源 SHA-256 与结算参数。');
}

$('playerRole').addEventListener('change', guarded(async () => {
  cancelAttack('切换玩家资源，取消未结算动作');
  const role = manifest.roles.find(r => r.id === $('playerRole').value);
  await setTrack('player', role); populateSkills(role); await applyVerifiedSkillMapping();
  notifySelection(`玩家资源改为 ${role.name}`); updateUI();
}));
for (const kind of ['player', 'enemy']) {
  $(`${kind}Action`).addEventListener('change', guarded(async () => {
    cancelAttack('切换图集动作组，取消未结算动作');
    await setTrack(kind, tracks[kind].role, $(`${kind}Action`).value);
    notifySelection(`${kind === 'player' ? '玩家' : '敌方'}图集动作改为原组 ${tracks[kind].action.index}`);
  }));
  $(`${kind}Direction`).addEventListener('change', guarded(() => {
    cancelAttack('切换方向，取消未结算动作'); tracks[kind].direction = number(`${kind}Direction`);
    tracks[kind].frame = 0; tracks[kind].elapsed = 0;
    tracks[kind].contentBounds = directionBounds(tracks[kind].loaded, tracks[kind].role, tracks[kind].action, tracks[kind].direction);
    log('direction-selected', `${kind === 'player' ? '玩家' : '敌方'}原方向 ${tracks[kind].direction}`);
    notifySelection(`${kind === 'player' ? '玩家' : '敌方'}方向改为原编号 ${tracks[kind].direction}`); updateUI();
  }));
}
$('playerSkill').addEventListener('change', guarded(async () => {
  cancelAttack('切换技能记录，取消未结算动作'); populateSkillActions(); log('skill-selected', '选择技能记录');
  await applyVerifiedSkillMapping(); notifySelection(`技能改为 ${selectedSkill()?.name || '未命名记录'}`); updateUI();
}));
$('skillAction').addEventListener('change', guarded(async () => {
  cancelAttack('切换技能动作记录，取消未结算动作'); populateSkillActions(true); log('skill-action-selected', '选择技能动作记录与原拒绝掩码');
  await applyVerifiedSkillMapping(); notifySelection(`技能动作改为记录 ${selectedSkillAction()?.index ?? '未知'}`); updateUI();
}));
$('targetSkill').addEventListener('change', guarded(() => {
  const skill = tracks.enemy.role.skills?.find(s => String(s.index) === $('targetSkill').value);
  $('targetSkillGate').value = Number.isInteger(skill?.gate_raw) ? skill.gate_raw : 0;
  log('target-skill-selected', '目标技能门字段来自实验选择记录，不声明原版当前技能');
  notify(skill ? `目标所选技能各动作的原分类字段：${skill.actions.map(a => a.target_class_raw ?? '未知').join(' / ')}。来自当前动作 +0x24，字段会随动作改变；方位含义未知，原分类输入仍需手工选择。` : '未选择目标技能记录，原分类输入仍未知。');
}));
$('fps').addEventListener('input', guarded(() => {
  const value = number('fps'); if (value < 1 || value > 60) throw new Error('实验帧速范围为 1–60 fps');
  fps = value; log('fps-changed', `实验帧速 ${fps} fps，原播放时序未认定`); updateUI();
}));
$('inspectActor').addEventListener('change', () => updateUI());
$('frameSlider').addEventListener('input', guarded(() => {
  paused = true; const track = selectedTrack(); if (!track) return;
  track.frame = number('frameSlider'); track.elapsed = 0;
  log('frame-scrub', '手动选择实验动画帧', { input_origin: 'frame_slider' }); updateUI();
}));
$('playPause').addEventListener('click', guarded(() => { paused = !paused; log('playback', paused ? '暂停动画' : '自动播放动画'); updateUI(); }));
$('stepFrame').addEventListener('click', guarded(() => { paused = true; advance($('inspectActor').value, 'step_button'); updateUI(); }));
$('resetAnimation').addEventListener('click', guarded(() => {
  cancelAttack('重置动画，取消未结算动作');
  for (const track of Object.values(tracks)) { track.frame = 0; track.elapsed = 0; }
  log('animation-reset', '动画回到首帧，目标 HP 保留'); updateUI();
}));
$('enterExperiment').addEventListener('click', guarded(() => {
  if (!tracks.player?.image || !tracks.enemy?.image) throw new Error('本地动画尚未准备完成');
  entered = true; resetTarget(); phase = 'ready';
  log('development-entry', '进入开发战斗实验；未执行地图暗雷'); updateUI();
}));
$('attack').addEventListener('click', guarded(beginAttack));
$('settle').addEventListener('click', guarded(settleAttack));
$('rebuildHp').addEventListener('click', guarded(resetTarget));
$('targetEnemy').addEventListener('click', guarded(() => {
  log('target-selected', '选中雪泥怪为本次技能目标');
  notify('目标：雪泥怪（用户观察中下）。选择技能并施放，可在原始图像上检查动作与特效。');
}));
$('sequenceMode').addEventListener('change', guarded(() => {
  cancelAttack('切换动作序列／单段检查，取消未结算动作'); populateSkills(tracks.player.role); notifySelection('播放方式已切换'); updateUI();
}));
$('settlementTiming').addEventListener('change', guarded(() => { log('timing-selection', '更改实验结算时点；原命中帧仍未知'); updateUI(); }));
$('exportLog').addEventListener('click', guarded(exportLog));
function returnToMap(event) {
  log('experiment-exit', '返回地图预览实验出口；未执行胜利或原作世界状态', { input_origin: 'return_link' });
  // Keep all existing localStorage untouched. This separate session key only preserves a recoverable lab log.
  try { sessionStorage.setItem('seventh-seal.combat-lab.last-log', JSON.stringify({ ...session, final_phase: phase, final_target: target })); } catch { /* Export remains available if session storage is full. */ }
  if (embedded) {
    event.preventDefault(); paused = true;
    window.parent.postMessage(sceneEnvelope(sceneSession, 'battle-return'), location.origin);
  }
}
$('returnMap').addEventListener('click', returnToMap);
$('headerReturnMap').addEventListener('click', returnToMap);
for (const id of controlIds.filter(id => !['playerRole', 'playerSkill', 'skillAction', 'playerAction', 'playerDirection',
  'enemyAction', 'enemyDirection', 'targetSkill', 'fps', 'settlementTiming'].includes(id))) {
  $(id).addEventListener('change', () => { log('input-changed', `更改实验输入 ${id}`, { input_origin: 'form_control' }); updatePositionNote(); });
}

async function initialize() {
  updateUI();
  try {
    const previous = sessionStorage.getItem('seventh-seal.combat-lab.last-log');
    const parsed = previous ? JSON.parse(previous) : null;
    if (parsed?.schema === session.schema && parsed.version === session.version) $('lastSessionLog').textContent = previous;
  } catch { /* A prior log never prevents entering this demonstration. */ }
  const response = await fetch(MANIFEST_URL, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`战斗资源清单读取失败 (${response.status})。请先生成 combat_manifest.json`);
  const bytes = await response.arrayBuffer(); manifestHash = await digest(bytes);
  manifest = JSON.parse(new TextDecoder().decode(bytes));
  if (manifest.schema !== 'seventh-seal-combat-lab' || manifest.version !== 1 || !Array.isArray(manifest.roles)) throw new Error('战斗资源清单 schema / version 不匹配');
  const players = manifest.roles.filter(r => ['001', '002'].includes(r.id)), enemy = manifest.roles.find(r => r.id === '012');
  if (!players.length || !enemy) throw new Error('清单缺少玩家 001/002 或敌方 012 图集');
  const observationURL = new URL('combat_observations.json', location.href);
  const observationResponse = await fetch(observationURL, { cache: 'no-cache' });
  if (!observationResponse.ok) throw new Error('用户方位观察清单读取失败');
  const observationBytes = await observationResponse.arrayBuffer();
  observations = JSON.parse(new TextDecoder().decode(observationBytes));
  if (observations.schema !== 'seventh-seal-combat-user-observations' || observations.version !== 1) throw new Error('用户观察清单格式不匹配');
  session.user_observations = { url: observationURL.href, sha256: await digest(observationBytes), ...observations };
  const presentationURL = new URL('combat_presentation.json', location.href);
  const presentationResponse = await fetch(presentationURL, { cache: 'no-cache' });
  if (!presentationResponse.ok) throw new Error('技能动作／特效清单尚未生成，请运行战斗表现导出工具');
  const presentationBytes = await presentationResponse.arrayBuffer();
  presentation = JSON.parse(new TextDecoder().decode(presentationBytes));
  if (presentation.schema !== 'seventh-seal-combat-presentation' || presentation.version !== 1) throw new Error('技能表现清单版本无效');
  session.presentation_manifest = { url: presentationURL.href, sha256: await digest(presentationBytes),
    evidence: presentation.evidence, limits: presentation.limits };
  session.manifest = { url: MANIFEST_URL.href, sha256: manifestHash, limits: manifest.limits || [], evidence: manifest.evidence || [] };
  $('sourceDetails').textContent = JSON.stringify({ manifest_sha256: manifestHash,
    roles: manifest.roles.map(r => ({ id: r.id, name: r.name, source: r.source, sha256: r.sha256,
      source_hashes: r.source_hashes, status: r.status, identity_status: r.identity_status, anchor: r.anchor,
      limits: r.limits, evidence: r.evidence })), limits: manifest.limits, evidence: manifest.evidence,
    rules: RULE_EVIDENCE, frame_layout: 'columns=frames, rows=raw directions',
    presentation: session.presentation_manifest,
    timing: 'source event frame and actor slot confirmed for three recipes; experiment fps and screen projection' }, null, 2);
  options($('playerRole'), players, r => `${r.name} · 资源 ${r.id}`);
  await Promise.all([setTrack('player', players[0]), setTrack('enemy', enemy)]);
  populateSkills(players[0]);
  options($('targetSkill'), [{ index: '', name: '不选择目标技能记录（门字段由实验输入）' }, ...(enemy.skills || [])],
    s => s.name || `未命名技能记录 ${s.index}（原 ID ${s.id_raw}）`);
  $('loading').hidden = true;
  initialized = true; entered = true; phase = 'ready';
  log('resources-ready', '本地原作图集读取完成，资源哈希已记录');
  notify('选择技能，点击“施放技能”查看人物接近、出招／原作特效与退回。伤害留空时只看表现，HP为实验值。'); updateUI();
  if (embedded) {
    window.parent.postMessage(sceneEnvelope(sceneSession, 'battle-ready'), location.origin);
    if (pendingSceneContext) await applySceneContext(pendingSceneContext);
  }
}
async function applySceneContext(context) {
  cancelAttack('地图场景进入战斗演示');
  const role = manifest.roles.find(r => r.id === context.player_role_id);
  $('playerRole').value = role.id;
  await setTrack('player', role); populateSkills(role);
  entered = true; resetTarget(); phase = 'ready';
  session.map_entry = { ...context, world_state_applied: false };
  log('same-page-entry', '由地图进入同页战斗演示，地图位置保留', { map_entry: session.map_entry });
  notify('已从地图进入战斗演示。选择技能后施放；退出后回到刚才的地图位置。'); updateUI();
}
if (embedded) window.addEventListener('message', guarded(async event => {
  if (!validSceneMessage(event, window.parent, location.origin, sceneSession)) return;
  pendingSceneContext = event.data.context;
  if (initialized) await applySceneContext(pendingSceneContext);
}));
initialize().catch(error => { $('loading').hidden = true; showError(error); notify('资源准备未完成，请检查错误信息并重新加载。'); });
requestAnimationFrame(tick);
