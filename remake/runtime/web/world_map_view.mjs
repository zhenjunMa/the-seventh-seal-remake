import {drawingContext} from './phaser/rendering/recorded_surface.mjs';
// Native Locate_001/002 pixels and sensor plane. This view owns transient focus;
// destination preparation, world writes and rollback stay in WorldMapController.
export function nextWorldMapDestination(destinations, current, step) {
  if (!destinations.length) return null;
  const start = destinations.findIndex(destination => destination.index === current);
  for (let offset = 1; offset <= destinations.length; offset++) {
    const position = ((start < 0 ? (step > 0 ? -1 : 0) : start) + step * offset + destinations.length * 2) % destinations.length;
    if (destinations[position].status === 0) return destinations[position].index;
  }
  return null;
}

export class WorldMapView {
  static async create(options) {
    const view = new WorldMapView(options);
    await Promise.all(options.manifest.areas.map(async area => {
      const paths = [area.background, area.sensor.image,
        ...area.destinations.flatMap(destination => [destination.normal, destination.active, destination.selected])];
      await Promise.all([...new Set(paths)].map(async path => view.images.set(path, await options.image(path))));
      const sensor = document.createElement('canvas');
      sensor.width = 641; sensor.height = 481;
      sensor.getContext('2d').drawImage(view.images.get(area.sensor.image), 0, 0);
      view.sensors.set(area.id, sensor.getContext('2d').getImageData(0, 0, 641, 481).data);
    }));
    return view;
  }
  constructor({manifest, root, image, select, close, status, cue = () => {}}) {
    Object.assign(this, {manifest, root, image, select, close, status, cue});
    this.images = new Map(); this.sensors = new Map(); this.snapshot = {phase: 'closed'};
    this.selected = null; this.hovered = null; this.armed = false; this.buttons = new Map();
    this.viewport = root.querySelector('.world-map-viewport');
    this.canvas = root.querySelector('canvas'); this.ctx = drawingContext(this.canvas);
    this.hits = root.querySelector('#worldMapDestinations');
    this.canvas.addEventListener('pointermove', event => {
      if (this.snapshot.phase !== 'open') return;
      const index = this.hit(event);
      this.canvas.style.cursor = index === null ? 'default' : 'pointer';
      if (index !== this.hovered) { this.hovered = index; if (index !== null) this.cue('menuSelect'); this.draw(); }
    });
    this.canvas.addEventListener('pointerleave', () => { this.hovered = null; this.canvas.style.cursor = 'default'; this.draw(); });
    this.canvas.addEventListener('click', event => {
      if (this.snapshot.phase !== 'open') return;
      const index = this.hit(event); if (index !== null) this.confirm(index);
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(root);
  }
  resize() {
    const rect = this.root.getBoundingClientRect();
    if (rect.width && rect.height) this.viewport.style.setProperty('--world-map-scale', String(Math.min(rect.width / 640, rect.height / 480)));
  }
  show(snapshot) {
    const opening = snapshot.phase !== 'closed' && (this.snapshot.phase === 'closed' || this.snapshot.area !== snapshot.area);
    this.snapshot = snapshot;
    this.root.hidden = snapshot.phase === 'closed';
    this.root.setAttribute('aria-busy', String(snapshot.phase === 'loading'));
    if (snapshot.phase === 'closed') { this.hits.replaceChildren(); this.buttons.clear(); return; }
    this.area = this.manifest.areas.find(area => area.id === snapshot.area);
    if (!this.area) throw new Error('大地图画面尚未接入');
    if (opening) {
      this.selected = snapshot.selected_index; this.hovered = null; this.armed = false;
      this.buttons.clear();
      this.hits.replaceChildren(...snapshot.destinations.filter(destination => destination.status === 0).map(destination => {
        const source = this.area.destinations.find(item => item.index === destination.index);
        const button = document.createElement('button');
        button.dataset.map = destination.map_id; button.dataset.index = String(destination.index);
        button.textContent = destination.name;
        button.setAttribute('aria-label', destination.name + (destination.available ? '' : '（尚未接入）'));
        button.setAttribute('aria-disabled', String(!destination.available));
        const {left, top, right, bottom} = source.rect;
        Object.assign(button.style, {left: `${left}px`, top: `${top}px`, width: `${right - left + 1}px`, height: `${bottom - top + 1}px`});
        button.addEventListener('focus', () => this.focus(destination.index, false));
        button.addEventListener('click', () => this.confirm(destination.index));
        this.buttons.set(destination.index, button); return button;
      }));
    }
    for (const button of this.buttons.values()) button.disabled = snapshot.phase !== 'open';
    this.resize(); this.draw();
    if (opening) this.root.focus({preventScroll: true});
  }
  focus(index, feedback = true) {
    if (this.snapshot.phase !== 'open' || !this.snapshot.destinations.some(destination => destination.index === index && destination.status === 0)) return;
    const changed = this.selected !== index;
    this.selected = index; this.hovered = null; this.armed = true;
    if (changed && feedback) this.cue('menuSelect');
    this.draw();
  }
  hit(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) * 640 / rect.width), y = Math.floor((event.clientY - rect.top) * 480 / rect.height);
    if (x < 0 || y < 0 || x >= 640 || y >= 480) return null;
    const value = this.sensors.get(this.area.id)[(y * 641 + x) * 4];
    const source = this.area.destinations.find(destination => destination.sensor_value === value);
    return source && this.snapshot.destinations.some(destination => destination.index === source.index && destination.status === 0) ? source.index : null;
  }
  confirm(index) {
    if (this.snapshot.phase !== 'open') return;
    const destination = this.snapshot.destinations.find(destination => destination.index === index);
    if (!destination || destination.status !== 0) return;
    this.focus(index, false);
    if (!destination.available) { this.cue('menuError'); this.status('这个目的地尚未接入当前章节。', true); return; }
    this.cue('menuConfirm'); this.select(index);
  }
  key(key, repeat = false) {
    if (this.snapshot.phase === 'closed') return false;
    if (key === 'Escape') {
      if (!repeat && this.snapshot.phase === 'open') { this.cue('menuCancel'); this.close(); }
      return true;
    }
    if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(key)) {
      if (this.snapshot.phase === 'open') {
        const step = ['ArrowLeft', 'ArrowUp'].includes(key) ? -1 : 1;
        const next = nextWorldMapDestination(this.snapshot.destinations, this.selected, step);
        if (next !== null) this.focus(next);
      }
      return true;
    }
    if (key === ' ' || key === 'Enter') {
      if (!repeat && this.armed) this.confirm(this.selected);
      return true;
    }
    // Keep map movement and menu shortcuts from reaching the scene underneath.
    return key !== 'Tab';
  }
  draw() {
    if (this.snapshot.phase === 'closed' || !this.area) return;
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.clearRect(0, 0, 640, 480);
    this.ctx.drawImage(this.images.get(this.area.background), 0, 0);
    for (const source of this.area.destinations) {
      if (!this.snapshot.destinations.some(destination => destination.index === source.index && destination.status === 0)) continue;
      const path = source.index === this.hovered ? source.active : source.index === this.selected ? source.selected : source.normal;
      this.ctx.drawImage(this.images.get(path), source.point.x, source.point.y);
    }
    for (const [index, button] of this.buttons) {
      button.classList.toggle('selected', index === this.selected);
      button.setAttribute('aria-pressed', String(index === this.selected));
    }
  }
}
