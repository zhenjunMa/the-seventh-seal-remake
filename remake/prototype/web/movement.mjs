// DAT terrain is recovered; continuous keyboard motion is a preview policy.
export class MovementMap {
  constructor(data) {
    if (data?.schema !== 'seventh-seal-map-movement' || data.version !== 1 ||
        !Number.isInteger(data.width) || !Number.isInteger(data.height) ||
        data.width <= 0 || data.height <= 0 || data.cell_size !== 16 ||
        data.terrain_rows?.length !== data.height ||
        data.terrain_rows.some(row => typeof row !== 'string' || row.length !== data.width || /[^01]/.test(row))) {
      throw new Error('地图通行数据无效');
    }
    this.width = data.width; this.height = data.height; this.cellSize = data.cell_size;
    this.rows = data.terrain_rows; this.triggers = new Map();
    for (const trigger of data.triggers ?? []) {
      if (!Number.isInteger(trigger.x) || !Number.isInteger(trigger.y) ||
          trigger.x < 0 || trigger.y < 0 || trigger.x >= this.width || trigger.y >= this.height ||
          !Number.isInteger(trigger.id) || trigger.id < 1 || trigger.id > 32 ||
          typeof trigger.path_gate !== 'boolean') throw new Error('地图触发格无效');
      const index = trigger.y * this.width + trigger.x;
      if (this.triggers.has(index)) throw new Error('地图触发格重复');
      this.triggers.set(index, trigger);
    }
  }
  cell(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return {blocked: true, reason: 'bounds', x, y};
    const trigger = this.triggers.get(y * this.width + x);
    if (this.rows[y][x] === '1') return {blocked: true, reason: 'terrain', x, y, trigger};
    if (trigger?.path_gate) return {blocked: true, reason: 'transition', x, y, trigger};
    return {blocked: false, x, y, trigger};
  }
  at(x, y) { return this.cell(Math.floor(x / this.cellSize), Math.floor(y / this.cellSize)); }
  // Traverse every grid boundary on the segment. Endpoint-only checks tunnel
  // through thin walls during running or a slow frame.
  move(x, y, dx, dy) {
    if (![x, y, dx, dy].every(Number.isFinite)) throw new Error('移动坐标无效');
    if (this.at(x, y).blocked) return {x, y, moved: false, blocked: true, hit: this.at(x, y)};
    const distance = Math.hypot(dx, dy);
    if (!distance) return {x, y, moved: false, blocked: false};
    const size = this.cellSize, sx = Math.sign(dx), sy = Math.sign(dy);
    let cx = Math.floor(x / size), cy = Math.floor(y / size);
    let tx = sx ? ((sx > 0 ? (cx + 1) * size : cx * size) - x) / dx : Infinity;
    let ty = sy ? ((sy > 0 ? (cy + 1) * size : cy * size) - y) / dy : Infinity;
    const stepX = sx ? size / Math.abs(dx) : Infinity, stepY = sy ? size / Math.abs(dy) : Infinity;
    while (Math.min(tx, ty) <= 1) {
      const t = Math.min(tx, ty), crossX = tx <= ty + 1e-12, crossY = ty <= tx + 1e-12;
      const nx = cx + (crossX ? sx : 0), ny = cy + (crossY ? sy : 0);
      let hit = this.cell(nx, ny);
      // Conservative preview corner policy. Native path expansion checks the
      // diagonal destination; exact original corner behavior awaits playback.
      if (crossX && crossY && !hit.blocked) {
        const sideX = this.cell(nx, cy), sideY = this.cell(cx, ny);
        if (sideX.blocked || sideY.blocked) hit = {...(sideX.blocked ? sideX : sideY), reason: 'corner'};
      }
      if (hit.blocked) {
        const accepted = Math.max(0, t - 1e-5 / distance);
        return {x: x + dx * accepted, y: y + dy * accepted,
          moved: accepted * distance > 1e-4, blocked: true, hit};
      }
      cx = nx; cy = ny;
      if (crossX) tx += stepX;
      if (crossY) ty += stepY;
    }
    return {x: x + dx, y: y + dy, moved: true, blocked: false};
  }
}

export function locomotion(input, moved) {
  const {dx, dy} = input;
  const direction = dy < 0 ? (dx > 0 ? 2 : dx < 0 ? 4 : 3)
    : dy > 0 ? (dx > 0 ? 0 : dx < 0 ? 6 : 7) : dx > 0 ? 1 : 5;
  return {action: moved ? (input.running ? 2 : 1) : 0, direction: dx || dy ? direction : null};
}
