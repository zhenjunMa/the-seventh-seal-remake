// Recovered world-map state changes (native 0x49f340), with a bounded scene
// handoff. The open menu is a session state; only selected/statuses are saved.
import {validateWorld, validateWorldMapState} from './world.mjs';

const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireValue(ok, message) { if (!ok) throw new Error(message); }
const source = value => (object(value) && Object.keys(value).length > 0) || (typeof value === 'string' && value.length > 0);
const evidence = value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item.length > 0);

export function validateWorldMapData(data) {
  requireValue(object(data) && source(data.source) && evidence(data.evidence), '大地图数据缺少来源');
  validateWorldMapState({areas: data.areas?.map(area => ({id: area.id, selected_index: area.selected_index, statuses: area.statuses}))});
  for (const area of data.areas) {
    requireValue(Array.isArray(area.destinations) && area.destinations.length === area.statuses.length, '大地图目的地表无效');
    area.destinations.forEach((destination, index) => {
      requireValue(object(destination) && destination.index === index && typeof destination.name === 'string' && destination.name.length > 0 && destination.name.length <= 150, '大地图目的地编号或名称无效');
      requireValue(typeof destination.map_id === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(destination.map_id) && !['__proto__','constructor','prototype'].includes(destination.map_id), '大地图目的地地图无效');
      requireValue(Number.isInteger(destination.entry_marker) && destination.entry_marker >= 0 && destination.entry_marker <= 255, '大地图进入标记无效');
      requireValue(source(destination.source) && evidence(destination.evidence), '大地图目的地缺少来源');
    });
  }
  return copy(data);
}

export class WorldMapController {
  constructor({world, data, prepare, load, captureView = () => null, rollbackView = () => {}, onPhase = () => {}, notify = () => {}}) {
    requireValue(world && typeof world.snapshot === 'function' && typeof world.replace === 'function' && typeof prepare === 'function' && typeof load === 'function', '大地图控制器依赖缺失');
    this.data = validateWorldMapData(data);
    Object.assign(this, {world, prepare, load, captureView, rollbackView, onPhase, notify});
    this.phase = 'closed'; this.area = null;
  }
  initialState() { return {areas: this.data.areas.map(area => ({id: area.id, selected_index: area.selected_index, statuses: [...area.statuses]}))}; }
  // Explicit development/source-table initialization. A legacy v1 save without
  // this field stays without it until the caller chooses this operation.
  initialize() {
    requireValue(this.phase !== 'loading', '大地图目的地正在加载');
    if (this.world.value.world_map) return {initialized: false};
    this.world.transact(next => { next.world_map = this.initialState(); });
    return {initialized: true, source: copy(this.data.source), evidence: [...this.data.evidence]};
  }
  stateArea(id) {
    requireValue(Number.isInteger(id) && this.data.areas.some(area => area.id === id), '大地图区域未支持');
    requireValue(this.world.value.world_map, '大地图状态尚未初始化');
    return this.world.value.world_map.areas.find(area => area.id === id);
  }
  snapshot() {
    const area = this.area === null ? null : this.stateArea(this.area);
    return {phase: this.phase, area: this.area, selected_index: area?.selected_index ?? null,
      destinations: area ? this.data.areas.find(item => item.id === this.area).destinations.map(destination => ({...copy(destination),
        status: area.statuses[destination.index], available: area.statuses[destination.index] === 0 && this.world.mapIds?.includes(destination.map_id) === true})) : []};
  }
  publish() { this.notify(this.snapshot()); }
  setPhase(phase) { this.phase = phase; this.onPhase(phase); this.publish(); }
  open(area) {
    requireValue(this.phase !== 'loading', '大地图目的地正在加载');
    this.stateArea(area); this.area = area; this.setPhase('open'); return this.snapshot();
  }
  close() {
    requireValue(this.phase !== 'loading', '大地图目的地正在加载');
    this.area = null; this.setPhase('closed'); return this.snapshot();
  }
  // type9 parameters have already been decoded by the event adapter. Unknown
  // modes/areas/indices/extra parameters are rejected before a persistent write.
  apply(parameters) {
    requireValue(object(parameters) && Object.keys(parameters).length === 3 && Object.keys(parameters).every(key => ['mode','area','destination'].includes(key)), '大地图状态命令参数未支持');
    const {mode, area, destination} = parameters;
    requireValue(Number.isInteger(mode) && mode >= 0 && mode <= 2, '大地图状态命令模式未支持');
    requireValue(this.phase !== 'loading', '大地图目的地正在加载');
    const state = this.stateArea(area);
    requireValue(Number.isInteger(destination) && destination >= 0 && destination < state.statuses.length, '大地图目的地编号无效');
    this.world.transact(next => {
      const target = next.world_map.areas.find(item => item.id === area);
      target.statuses[destination] = mode === 2 ? 2 : 0;
      if (mode === 0) target.selected_index = destination;
    });
    if (mode === 0) return this.open(area);
    this.publish(); return this.snapshot();
  }
  async select(index) {
    requireValue(this.phase === 'open', '大地图尚未打开或目的地正在加载');
    requireValue(Number.isInteger(index), '大地图目的地编号无效');
    const destination = this.snapshot().destinations.find(item => item.index === index);
    requireValue(destination?.status === 0, '大地图目的地尚未开放');
    requireValue(destination.available, '大地图目的地尚未接入');
    const before = this.world.snapshot(), area = this.area, checkpoint = this.captureView();
    let viewAttempted = false;
    const checkWorld = () => requireValue(this.world.value.revision === before.revision, '大地图加载期间世界状态已变化，不能覆盖新进度');
    this.setPhase('loading');
    try {
      const prepared = await this.prepare(copy(destination));
      checkWorld();
      const location = prepared?.location;
      requireValue(object(location) && location.map_id === destination.map_id && Object.keys(location).length === 4 && Object.keys(location).every(key => ['map_id','x','y','direction'].includes(key)), '大地图目的地进入位置无效');
      const next = copy(before);
      next.world_map.areas.find(item => item.id === area).selected_index = index;
      next.location = {...location}; next.revision = (before.revision + 1) >>> 0;
      const normalized = validateWorld(next, this.world.mapIds);
      // load is the same kind of synchronous view commit as SceneController's
      // commitView. Preparation must finish first; neither callback writes world.
      viewAttempted = true;
      const result = this.load(prepared, {...location});
      requireValue(!result || typeof result.then !== 'function', '大地图视图提交必须同步');
      checkWorld(); this.world.replace(normalized);
      this.area = null; this.setPhase('closed'); return prepared;
    } catch (error) {
      if (viewAttempted) this.rollbackView(checkpoint);
      this.area = area; this.setPhase('open'); throw error;
    }
  }
}
