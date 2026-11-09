// Direction indices match the eight exploration poses, starting down-right.
const forwardVectors = [[1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];

export function mapTargetInFront(player, target) {
  const dx = target.x - player.x, dy = target.y - player.y;
  if (dx === 0 && dy === 0) return true;
  const [x, y] = forwardVectors[player.direction];
  const forward = x * dx + y * dy;
  // Allow 45 degrees to either side so diagonal approaches are easy to aim.
  return forward > 0 && Math.abs(x * dy - y * dx) <= forward;
}

// 486060 uses float32 coordinate deltas and ratio, then compares the ratio
// against the executable's float64 thresholds before looking up the pose.
export function nativeConversationDirection(actor,target,directionMode=1) {
  const directions=directionMode?[5,1,4,3,2,0,7,6]:[4,0,3,2,1,7,6,5];
  const dx=Math.fround((actor.x-target.x)/2),dy=Math.fround((actor.y-target.y)/2);
  if(dy!==0){
    const ratio=Math.fround(dx/dy);
    if(ratio>=0.4&&ratio<2)return directions[dy>0?2:5];
    if(ratio>=-0.4&&ratio<0.4)return directions[dy>0?3:6];
    if(ratio>=-2&&ratio<-0.4)return directions[dy>0?4:7];
  }
  return directions[dx>0?0:1];
}

export function mapInteractionDirection(actor, target) {
  if (!target || !(Math.hypot(target.x - actor.x, target.y - actor.y) > 0)) return actor.direction;
  return nativeConversationDirection(actor, target);
}

// GAME.exe 43CE30/410850 selects explicit CF1 targets; 412640 checks reach.
// Coordinates use the initialized DGP footprint and the original DAT header.
export function nativeObjectInteractionNearby(object, at, header) {
  if (!/^[0-9a-f]{740}$/i.test(header ?? '')) return false;
  const byte = offset => Number.parseInt(header.slice(offset * 2, offset * 2 + 2), 16);
  const shift = byte(0x142) || 3, scale = byte(0x145);
  const width = object.width_cells, height = object.height_cells;
  if (shift > 16 || scale > 5 || !Number.isInteger(width) || !Number.isInteger(height)
      || width < 1 || height < 1) return false;
  const x = Math.floor(at.x / 2) >> shift, y = Math.floor(at.y / 2) >> shift;
  const ox = object.x_native, oy = object.y_native;
  if (!byte(0x88)) {
    const left = ox >> shift, top = oy >> shift;
    return x >= left - 1 && x <= left + width && y >= top - 1 && y <= top + height;
  }
  const step = 2 ** scale;
  for (let row = 0; row < height * step; row++) {
    for (let col = 0; col < width * step; col++) {
      const px = (ox + 8 * (col - row)) >> shift;
      const py = (oy + 4 * (col + row)) >> shift;
      if (Math.max(Math.abs(x - px), Math.abs(y - py)) < step + 1) return true;
    }
  }
  return false;
}

const contains = (point, rect) => point.x >= rect.x && point.x <= rect.x + rect.width
  && point.y >= rect.y && point.y <= rect.y + rect.height;

export function mapWorldPoint(event, rect, view) {
  const scale = Math.min(rect.width / 640, rect.height / 480);
  if (!(scale > 0) || !(view.zoom > 0)) return null;
  const x = (event.clientX - rect.left - (rect.width - 640 * scale) / 2) / scale;
  const y = (event.clientY - rect.top - (rect.height - 480 * scale) / 2) / scale;
  if (x < 0 || x > 640 || y < 0 || y > 480) return null;
  return {x: view.x + (x - 320) / view.zoom, y: view.y + (y - 240) / view.zoom};
}

export function pickMapDialogueObject({scene, world, bindings, header, queue, point}) {
  // The native mouse dispatcher checks visible NPC rectangles before objects.
  if (queue.some(entry => entry.key.startsWith('npc:') && contains(point, entry.pose))) return null;
  const visible = new Set(queue.map(entry => entry.key));
  const admitted = new Set(bindings.filter(row => ['tlk-object', 'mechanism'].includes(row.handler)).map(row => row.index));
  // 410850 builds the selection queue in source index order, not drawing order.
  for (const object of [...scene.objects].sort((a, b) => a.index - b.index)) {
    if (!admitted.has(object.index) || !visible.has(`object:${object.index}`)) continue;
    const rect = {x: object.draw_x, y: object.draw_y,
      width: object.frame_width, height: object.frame_height};
    if (contains(point, rect)) return {object,
      nearby: nativeObjectInteractionNearby(object, world.location, header)};
  }
  return null;
}
