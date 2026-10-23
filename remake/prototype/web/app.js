import {MovementMap, locomotion} from '/runtime/core/movement.mjs';
import {BattleSceneBridge} from './battle_scene_bridge.mjs';
const $ = (id) => document.getElementById(id);
const stage = $('stage'), ctx = stage.getContext('2d');
const mini = $('spritePreview'), miniCtx = mini.getContext('2d');
const cache = new Map(), readyImages = new Map(), keys = new Set();
// Visual order of the eight rows in the extracted role sheets.
const DIRECTION_LABELS = ['↘ 右下','→ 右','↗ 右上','↑ 上','↖ 左上','← 左','↙ 左下','↓ 下'];
// Action meanings confirmed by the user against the extracted animation groups.
const ACTION_NAMES = ['待机','行走','跑步'];
const MAP_HINT = '方向键 / WASD 行走 · Shift 跑步 · 路缘会阻挡 · 移动自动跟随';
const state = {schema: 'seventh-seal-visual-preview', version: 2, role: 0, action: 0, direction: 0,
  frame: 0, playing: true, speed: 1, view: 'map', asset: 0, page: 0, x: 330, y: 1500,
  cameraX: 330, cameraY: 1500, zoom: 1, follow: true, grid: false, collisionOverlay: false};
let manifest, mapImage, sheet, assetImage, lastTime = 0, frameClock = 0, requestId = 0;
let movementMap, mapData, objects = [];
let cssWidth = 0, cssHeight = 0, drag = null;
let moving = false, motionMode = '';
let lastHit = null;
let renderRequest = 0, sceneSuspended = false, battleBridge;
let mapScroll = {x: 0, y: 0};
const status = (message) => { $('status').textContent = message; };

function clearMapInput() {
  keys.clear(); moving = false; motionMode = '';
  if (drag?.pointerId !== undefined && stage.hasPointerCapture(drag.pointerId)) {
    stage.releasePointerCapture(drag.pointerId);
  }
  drag = null;
  lastTime = 0;
}
function returnToMap() {
  if (!sceneSuspended) return;
  battleBridge.exit();
  clearMapInput();
  $('battleView').hidden = true;
  $('mapView').hidden = false;
  $('mapView').inert = false;
  document.body.classList.remove('in-battle');
  sceneSuspended = false;
  resize();
  lastTime = performance.now();
  status(`已返回当前位置 · ${Math.round(state.x)}, ${Math.round(state.y)} · 开发演示结束`);
  stage.focus({preventScroll: true});
  window.scrollTo(mapScroll.x, mapScroll.y);
  renderRequest = requestAnimationFrame(render);
}
function enterBattle() {
  if (sceneSuspended || !battleBridge) return;
  if (state.view !== 'map') return status('请先切换到地图预览，再进入战斗演示。');
  mapScroll = {x: window.scrollX, y: window.scrollY};
  clearMapInput();
  sceneSuspended = true;
  cancelAnimationFrame(renderRequest); renderRequest = 0;
  $('mapView').inert = true;
  $('mapView').hidden = true;
  $('battleView').hidden = false;
  document.body.classList.add('in-battle');
  $('battleMapPosition').textContent = `${manifest.maps[0].name} · 地图位置 ${Math.round(state.x)}, ${Math.round(state.y)} 已保留`;
  $('battleMapPosition').dataset.x = String(state.x);
  $('battleMapPosition').dataset.y = String(state.y);
  $('battleSceneStatus').textContent = '正在准备战斗演示…地图运行时已暂停，可随时返回。';
  $('battleSceneStatus').classList.remove('error');
  $('closeBattle').focus({preventScroll: true});
  try {
    battleBridge.enter({entry_kind: 'development_demo',
      player_role_id: {'ROLE_001':'001', 'ROLE_002':'002'}[currentRole().id] ?? '001',
      map: {id: manifest.maps[0].id, x: state.x, y: state.y}});
  } catch (error) {
    $('battleSceneStatus').textContent = error.message;
    $('battleSceneStatus').classList.add('error');
  }
}
function wireBattleScene() {
  battleBridge = new BattleSceneBridge({frame: $('battleFrame'),
    onReady: () => {
      $('battleSceneStatus').textContent = '演示已就绪 · 原作素材交战实验，结束后返回地图当前位置。';
      $('battleSceneStatus').classList.remove('error');
    },
    onReturn: returnToMap,
    onError: (message) => {
      $('battleSceneStatus').textContent = message;
      $('battleSceneStatus').classList.add('error');
    }});
  $('enterBattle').onclick = enterBattle;
  $('closeBattle').onclick = returnToMap;
  $('enterBattle').disabled = state.view !== 'map';
}

function loadImage(url) {
  if (!cache.has(url)) cache.set(url, new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { readyImages.set(url, image); resolve(image); };
    image.onerror = () => { cache.delete(url); readyImages.delete(url); reject(new Error(`图片加载失败：${url}`)); };
    image.src = url;
  }));
  return cache.get(url);
}
function currentRole() { return manifest.roles[state.role]; }
function currentAction() { return currentRole().actions[state.action]; }
function options(select, items, value = 0) {
  select.replaceChildren(...items.map((text, index) => { const opt = document.createElement('option'); opt.value = index; opt.textContent = text; return opt; }));
  select.value = value;
}
async function updateRole() {
  const id = ++requestId;
  const role = currentRole();
  state.action = Math.min(state.action, role.actions.length - 1);
  const action = currentAction();
  sheet = readyImages.get(action.sheet) ?? null;
  state.direction = Math.min(state.direction, action.directions - 1);
  state.frame = Math.min(state.frame, action.frames_per_direction - 1);
  options($('role'), manifest.roles.map((r) => r.name), state.role);
  options($('action'), role.actions.map((a) => `动作 ${String(a.index).padStart(2, '0')}${ACTION_NAMES[a.index] ? ` · ${ACTION_NAMES[a.index]}` : ''} · ${a.frames_per_direction} 帧`), state.action);
  options($('direction'), Array.from({length: action.directions}, (_, i) => `方向 ${i + 1}${action.directions === 8 ? ` · ${DIRECTION_LABELS[i]}` : ''}`), state.direction);
  $('frame').max = action.frames_per_direction - 1;
  $('frame').value = state.frame;
  $('timingNote').textContent = `移动自动切换行走 / 跑步，松开回到待机。原始间隔字段 ${action.interval_raw} 暂按毫秒播放，时序仍待原版对照。`;
  try {
    const loaded = await loadImage(action.sheet);
    if (id === requestId) sheet = loaded;
  } catch (error) { status(error.message); }
  sourceInfo();
}
function sourceInfo() {
  const r = state.view === 'map' ? currentRole() : manifest.resources[state.asset];
  const data = [['文件', r.source], ['画幅', `${r.frame_width} × ${r.frame_height}`], ['总帧', r.frame_count],
    ['指纹', `${r.sha256.slice(0, 16)}…`], ['对照', '结构与颜色转换通过；尚未原版截图对照']];
  $('sourceInfo').replaceChildren(...data.flatMap(([key, value]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = key; dd.textContent = value; return [dt, dd];
  }));
  $('failedResources').textContent = manifest.failures.length ? `未支持 ${manifest.failures.length} 个试验样本：${manifest.failures.map((f) => f.source).join('、')}。未输出猜测素材。` : '本批试验样本均已导出。';
}
async function updateAsset() {
  const asset = manifest.resources[state.asset];
  const images = asset.pages ?? asset.actions.map((a) => ({image: a.sheet}));
  state.page = Math.min(state.page, images.length - 1);
  options($('page'), images.map((_, i) => asset.pages ? `图集页 ${i + 1}` : `动作组 ${i}`), state.page);
  const imageUrl = images[state.page].image;
  try { const loaded = await loadImage(imageUrl); if (images[state.page]?.image === imageUrl && manifest.resources[state.asset] === asset) { assetImage = loaded; if (state.view === 'asset') { fitView(); $('mapName').textContent = `${asset.source} / ${loaded.width} × ${loaded.height}`; } } }
  catch (error) { assetImage = null; status(error.message); }
  sourceInfo();
}
function setView(view) {
  state.view = view;
  $('enterBattle').disabled = view !== 'map';
  $('mapTab').classList.toggle('active', view === 'map');
  $('assetTab').classList.toggle('active', view === 'asset');
  $('assetControls').hidden = view !== 'asset';
  $('stageNote').textContent = view === 'map' ? MAP_HINT : '拖动查看 · 滚轮缩放 · 图集保留原始帧位置';
  if (view === 'map') { centerOnRole(); $('mapName').textContent = `${manifest.maps[0].name} / ${mapImage.width} × ${mapImage.height}`; } else updateAsset();
  sourceInfo();
}
function resize() {
  const rect = stage.getBoundingClientRect();
  if (sceneSuspended || rect.width <= 0 || rect.height <= 0) return;
  cssWidth = rect.width; cssHeight = rect.height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  stage.width = Math.round(cssWidth * dpr); stage.height = Math.round(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  if (manifest && mapImage) paint();
}
function centerOnRole() {
  const role = currentRole(), offset = role.map_draw_offset;
  state.cameraX = state.x + offset.x + role.frame_width / 2;
  state.cameraY = state.y + offset.y + role.frame_height / 2;
  state.follow = true;
}
function fitView() {
  const im = state.view === 'map' ? mapImage : assetImage;
  if (!im) return;
  state.zoom = Math.min(cssWidth / im.width, cssHeight / im.height) * 0.97;
  state.cameraX = im.width / 2; state.cameraY = im.height / 2; state.follow = false;
}
function zoomBy(ratio) { state.zoom = Math.max(0.08, Math.min(6, state.zoom * ratio)); }
function drawSprite(context, x, y, scale = 1, onMap = false) {
  if (!sheet) return;
  const role = currentRole(), w = role.frame_width, h = role.frame_height;
  const left = onMap ? x + role.map_draw_offset.x : x - w * scale / 2;
  const top = onMap ? y + role.map_draw_offset.y : y - h * scale;
  context.drawImage(sheet, state.frame * w, state.direction * h, w, h, left, top, w * scale, h * scale);
}
function movementInput() {
  return {
    dx: Number(keys.has('ArrowRight') || keys.has('d')) - Number(keys.has('ArrowLeft') || keys.has('a')),
    dy: Number(keys.has('ArrowDown') || keys.has('s')) - Number(keys.has('ArrowUp') || keys.has('w')),
    running: keys.has('Shift'),
  };
}
function updateLocomotion(input, movement) {
  if (state.view === 'map' && (input.dx || input.dy)) {
    const {action: actionIndex, direction} = locomotion(input, movement.moved);
    state.direction = direction;
    // Inspecting the map is temporary: character movement always resumes follow.
    state.follow = true;
    drag = null;
    // Movement resumes playback even after the manual frame inspector paused it.
    state.playing = true;
    $('play').textContent = '暂停';
    if (state.action !== actionIndex) {
      state.action = actionIndex; state.frame = 0; frameClock = 0;
      updateRole();
    } else $('direction').value = direction;
    const nextMode = movement.moved ? (input.running ? '跑步' : '行走') : '受阻';
    if (nextMode !== motionMode) {
      if (nextMode === '受阻') {
        const reason = {terrain:'地形边界', bounds:'地图边界', corner:'墙角边界', transition:'切图边界（本版未执行切图）'}[movement.hit?.reason] ?? '边界';
        status(`已停止 · ${reason} · 可换方向绕行`);
      } else status(`${nextMode} · 松开方向键返回待机`);
    }
    moving = true; motionMode = nextMode;
  } else if (moving) {
    moving = false; motionMode = '';
    state.action = 0; state.frame = 0; frameClock = 0;
    updateRole();
    status('已停止 · 保持最后朝向');
  }
}
function render(now) {
  renderRequest = 0;
  if (sceneSuspended) return;
  const delta = Math.min((now - lastTime) / 1000 || 0, 0.1); lastTime = now;
  const input = movementInput();
  let movement = {moved:false, blocked:false};
  if (state.view === 'map') {
    const {dx, dy, running} = input;
    if (dx || dy) {
      const length = Math.hypot(dx, dy);
      const velocity = running ? 270 : 150;
      movement = movementMap.move(state.x, state.y, dx / length * velocity * delta, dy / length * velocity * delta);
      state.x = movement.x; state.y = movement.y;
      lastHit = movement.blocked ? movement.hit : null;
    }
  }
  updateLocomotion(input, movement);
  if (state.view === 'map' && state.follow) centerOnRole();
  if (state.playing && sheet) {
    frameClock += delta * 1000 * state.speed;
    const interval = Math.max(20, currentAction().interval_ms_preview);
    if (frameClock >= interval) {
      const advance = Math.floor(frameClock / interval); frameClock %= interval;
      state.frame = (state.frame + advance) % currentAction().frames_per_direction;
      $('frame').value = state.frame;
    }
  }
  paint();
  renderRequest = requestAnimationFrame(render);
}
function paint() {
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = '#10151a'; ctx.fillRect(0, 0, cssWidth, cssHeight);
  ctx.save(); ctx.translate(cssWidth / 2, cssHeight / 2); ctx.scale(state.zoom, state.zoom); ctx.translate(-state.cameraX, -state.cameraY);
  const image = state.view === 'map' ? mapImage : assetImage;
  if (image) ctx.drawImage(image, 0, 0);
  if (state.grid && image) {
    ctx.strokeStyle = '#eee8dd35'; ctx.lineWidth = 1 / state.zoom; ctx.beginPath();
    const step = state.view === 'map' ? movementMap.cellSize : 32;
    for (let x = 0; x <= image.width; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, image.height); }
    for (let y = 0; y <= image.height; y += step) { ctx.moveTo(0, y); ctx.lineTo(image.width, y); } ctx.stroke();
  }
  if (state.view === 'map') {
    if (state.collisionOverlay) drawCollision();
    const queue = [...objects.map(obj => ({...obj, draw: () => ctx.drawImage(obj.bitmap, obj.draw_x, obj.draw_y)})),
      {layer:manifest.maps[0].role_layer_preview, sort_y:state.y+32, draw: () => drawSprite(ctx, state.x, state.y, 1, true)}];
    queue.sort((a,b) => a.layer-b.layer || a.sort_y-b.sort_y);
    for (const entity of queue) entity.draw();
    if (state.collisionOverlay) {
      const size = movementMap.cellSize, cell = movementMap.at(state.x,state.y);
      ctx.strokeStyle = '#4de2ff'; ctx.lineWidth = 2/state.zoom;
      ctx.strokeRect(cell.x*size,cell.y*size,size,size);
      ctx.fillStyle = '#4de2ff'; ctx.beginPath();ctx.arc(state.x,state.y,3/state.zoom,0,Math.PI*2);ctx.fill();
      if (lastHit) {ctx.strokeStyle='#ffed8a';ctx.strokeRect(lastHit.x*size,lastHit.y*size,size,size);}
    }
  }
  ctx.restore();
  miniCtx.clearRect(0, 0, mini.width, mini.height); miniCtx.imageSmoothingEnabled = false;
  drawSprite(miniCtx, mini.width / 2, mini.height - 12, Math.min(1.15, 180 / currentRole().frame_height));
  $('frameLabel').textContent = `${state.frame + 1} / ${currentAction().frames_per_direction}`;
  $('position').textContent = `${Math.round(state.x)}, ${Math.round(state.y)}`;
  $('position').dataset.x = String(state.x);
  $('position').dataset.y = String(state.y);
  if (movementMap) {
    const cell = movementMap.at(state.x,state.y);
    $('cellInfo').textContent = `逻辑格 ${cell.x}, ${cell.y}${cell.trigger ? ` · 触发 ${cell.trigger.id}（未执行）` : ' · 可通行'}`;
  }
  $('zoomValue').textContent = `${Math.round(state.zoom * 100)}%`;
  $('center').setAttribute('aria-pressed',String(state.follow));
}
function drawCollision() {
  const size = movementMap.cellSize;
  const x0 = Math.max(0,Math.floor((state.cameraX-cssWidth/2/state.zoom)/size));
  const x1 = Math.min(movementMap.width,Math.ceil((state.cameraX+cssWidth/2/state.zoom)/size));
  const y0 = Math.max(0,Math.floor((state.cameraY-cssHeight/2/state.zoom)/size));
  const y1 = Math.min(movementMap.height,Math.ceil((state.cameraY+cssHeight/2/state.zoom)/size));
  for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++) {
    const cell=movementMap.cell(x,y);
    ctx.fillStyle=cell.reason==='transition'?'#e6ad4055':cell.blocked?'#ec535342':'#4bd48b38';
    ctx.fillRect(x*size,y*size,size,size);
    if(cell.trigger&&!cell.blocked){ctx.fillStyle='#e6ad4080';ctx.fillRect(x*size+5,y*size+5,6,6);}
  }
}
function validatePreview(data) {
  if (data?.schema !== state.schema || ![1,2].includes(data.version)) throw new Error('预览状态版本不兼容');
  data = {...data, version:2, collisionOverlay:data.collisionOverlay ?? false};
  for (const key of ['role','action','direction','frame','asset','page']) if (!Number.isInteger(data[key]) || data[key] < 0) throw new Error('预览状态包含无效选项');
  if (!manifest.roles[data.role] || !manifest.roles[data.role].actions[data.action] || !manifest.resources[data.asset]) throw new Error('预览状态对应资源不存在');
  const action = manifest.roles[data.role].actions[data.action], resource = manifest.resources[data.asset];
  if (data.direction >= action.directions || data.frame >= action.frames_per_direction || data.page >= (resource.pages ?? resource.actions).length) throw new Error('预览状态帧或朝向超出范围');
  for (const key of ['x','y','cameraX','cameraY','zoom','speed']) if (!Number.isFinite(data[key])) throw new Error('预览状态包含无效位置');
  if (data.zoom < 0.08 || data.zoom > 6 || ![0.5,1,2].includes(data.speed) || !['map','asset'].includes(data.view)) throw new Error('预览状态设置无效');
  if (data.x < 0 || data.x > mapImage.width || data.y < 0 || data.y > mapImage.height) throw new Error('预览位置超出地图');
  if (movementMap.at(data.x,data.y).blocked) throw new Error('保存位置位于阻挡格，请使用验证点重新定位');
  for (const key of ['playing','follow','grid','collisionOverlay']) if (typeof data[key] !== 'boolean') throw new Error('预览状态开关无效');
  return Object.fromEntries(Object.keys(state).map((key) => [key, data[key]]));
}
function wireControls() {
  $('role').onchange = () => { state.role = Number($('role').value); state.action = 0; state.frame = 0; frameClock = 0; updateRole(); };
  $('action').onchange = () => { state.action = Number($('action').value); state.frame = 0; frameClock = 0; updateRole(); };
  $('direction').onchange = () => { state.direction = Number($('direction').value); state.frame = 0; frameClock = 0; };
  $('speed').onchange = () => { state.speed = Number($('speed').value); };
  $('play').onclick = () => { state.playing = !state.playing; $('play').textContent = state.playing ? '暂停' : '播放'; };
  $('frame').oninput = () => { state.frame = Number($('frame').value); state.playing = false; $('play').textContent = '播放'; frameClock = 0; };
  $('mapTab').onclick = () => setView('map'); $('assetTab').onclick = () => setView('asset');
  $('asset').onchange = () => { state.asset = Number($('asset').value); state.page = 0; updateAsset(); };
  $('page').onchange = () => { state.page = Number($('page').value); updateAsset(); };
  $('zoomOut').onclick = () => zoomBy(1 / 1.25); $('zoomIn').onclick = () => zoomBy(1.25);
  $('fit').onclick = fitView; $('center').onclick = () => { setView('map'); state.zoom = 1; centerOnRole(); };
  $('grid').onchange = () => { state.grid = $('grid').checked; };
  $('collisionOverlay').onchange = () => {state.collisionOverlay = $('collisionOverlay').checked;};
  $('jumpProbe').onclick = () => {
    const point = manifest.maps[0].movement_probes[Number($('probe').value)];
    if (movementMap.at(point.x,point.y).blocked) return status('验证点不在可通行格');
    keys.clear(); moving=false; motionMode=''; lastHit=null;
    state.x=point.x;state.y=point.y;state.action=0;state.frame=0;frameClock=0;
    setView('map');updateRole();stage.focus();status(`已定位 · ${point.name}`);
  };
  $('save').onclick = () => { try { localStorage.setItem(state.schema, JSON.stringify(state)); status('预览状态已保存'); } catch (e) { status(`保存失败：${e.message}`); } };
  $('restore').onclick = async () => {
    try {
      const raw = localStorage.getItem(state.schema); if (!raw) return status('还没有保存过预览状态');
      Object.assign(state, validatePreview(JSON.parse(raw))); frameClock = 0;
      keys.clear();moving=false;motionMode='';lastHit=null;
      await updateRole(); $('speed').value = state.speed; $('grid').checked = state.grid; $('collisionOverlay').checked=state.collisionOverlay; $('play').textContent = state.playing ? '暂停' : '播放';
      $('asset').value = state.asset;
      $('mapTab').classList.toggle('active', state.view === 'map'); $('assetTab').classList.toggle('active', state.view === 'asset');
      $('enterBattle').disabled = state.view !== 'map';
      $('assetControls').hidden = state.view !== 'asset';
      $('stageNote').textContent = state.view === 'map' ? MAP_HINT : '拖动查看 · 滚轮缩放 · 图集保留原始帧位置';
      if (state.view === 'asset') { const camera = [state.cameraX,state.cameraY,state.zoom]; await updateAsset(); [state.cameraX,state.cameraY,state.zoom] = camera; }
      else $('mapName').textContent = `${manifest.maps[0].name} / ${mapImage.width} × ${mapImage.height}`;
      sourceInfo(); status('预览状态已恢复');
    } catch (e) { status(`恢复失败：${e.message}`); }
  };
  $('capture').onclick = () => stage.toBlob((blob) => {
    if (!blob) return status('画面导出失败');
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'seventh-seal-preview.png'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); status('已导出当前画面');
  });
  stage.addEventListener('pointerdown', (e) => { if (sceneSuspended) return; stage.focus(); drag = {x:e.clientX,y:e.clientY,cx:state.cameraX,cy:state.cameraY,panning:false,pointerId:e.pointerId}; stage.setPointerCapture(e.pointerId); });
  stage.addEventListener('pointermove', (e) => {
    if (sceneSuspended || !drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.panning && Math.hypot(dx, dy) < 4) return;
    drag.panning = true; state.follow = false;
    state.cameraX = drag.cx - dx / state.zoom;
    state.cameraY = drag.cy - dy / state.zoom;
  });
  stage.addEventListener('pointerup', () => { drag = null; }); stage.addEventListener('pointercancel', () => { drag = null; });
  stage.addEventListener('wheel', (e) => { if (sceneSuspended) return; e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); }, {passive:false});
  stage.addEventListener('keydown', (e) => {
    if (sceneSuspended) return;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d','Shift'].includes(key)) {
      keys.add(key);
      if (e.shiftKey) keys.add('Shift');
      else keys.delete('Shift');
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
  window.addEventListener('blur', () => keys.clear()); document.addEventListener('visibilitychange', () => { keys.clear(); lastTime = 0; });
  stage.addEventListener('blur', () => keys.clear());
  new ResizeObserver(resize).observe(stage);
}
async function init() {
  try {
    const response = await fetch('manifest.json'); if (!response.ok) throw new Error('找不到资源清单，请先执行提取器');
    manifest = await response.json();
    if (!manifest.maps.length || !manifest.roles.length) throw new Error('缺少地图或角色，请查看提取失败报告');
    mapImage = await loadImage(manifest.maps[0].image);
    const mapResponse = await fetch(manifest.maps[0].movement);
    if (!mapResponse.ok) throw new Error('找不到地图通行数据，请运行移动提取器');
    mapData = await mapResponse.json(); movementMap = new MovementMap(mapData);
    if (mapImage.width!==movementMap.width*16 || mapImage.height!==movementMap.height*16) throw new Error('背景与通行格尺寸不一致');
    Object.assign(state,manifest.maps[0].start_preview);
    if (movementMap.at(state.x,state.y).blocked) throw new Error('起点落在阻挡格');
    objects = await Promise.all(manifest.maps[0].objects.map(async obj => ({...obj,bitmap:await loadImage(obj.image)})));
    $('verification').textContent = `${manifest.verification.decoded_frames.toLocaleString()} 帧已检查 · 来源指纹${manifest.verification.unchanged ? '未变' : '异常'}`;
    $('mapName').textContent = `${manifest.maps[0].name} / ${mapImage.width} × ${mapImage.height}`;
    options($('asset'), manifest.resources.map((r) => r.source));
    options($('probe'), manifest.maps[0].movement_probes.map(p => p.name));
    // Ready sheets avoid blank frames or a stale standing pose when movement starts.
    await Promise.all(manifest.roles.flatMap((role) => role.actions.slice(0, 3).map((action) => loadImage(action.sheet))));
    $('stageNote').textContent = MAP_HINT;
    centerOnRole(); resize(); await updateRole(); wireControls(); wireBattleScene();
    $('loading').hidden = true; status('原作背景与角色素材已载入'); renderRequest = requestAnimationFrame(render);
  } catch (error) { $('loading').textContent = error.message; status(error.message); }
}
init();
