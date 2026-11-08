import {drawBattleImage} from './core/battle/battle_resources.mjs';
import {nativeStatusPresentation} from './core/battle/battle_status.mjs';

const hash = value => /^[a-f0-9]{64}$/.test(value);
const sheet = value => /^\/assets\/battle_status\/\d{3}\/(?:main|intrinsic)\.png$/.test(value);

export function validateBattleStatusView(data) {
  if (data?.schema !== 'seventh-seal-battle-status-view' || data.version !== 1 || !data.effects)
    throw new Error('战斗状态表现清单无效');
  for (const [id, effect] of Object.entries(data.effects)) {
    if (String(effect.id_raw) !== id || !Number.isInteger(effect.frame_count) || effect.frame_count < 0)
      throw new Error('战斗状态编号或帧数无效');
    if (!effect.frame_count) continue;
    if (![effect.frame_width, effect.frame_height].every(n => Number.isInteger(n) && n > 0) ||
        ![effect.anchor?.x, effect.anchor?.y].every(Number.isFinite) || typeof effect.above_head !== 'boolean' ||
        !Number.isInteger(effect.first_frame) || effect.first_frame < 0 ||
        !sheet(effect.main_sheet) || !hash(effect.main_sha256) ||
        effect.intrinsic_sheet && (!sheet(effect.intrinsic_sheet) || !hash(effect.intrinsic_sha256)))
      throw new Error('战斗状态图层或坐标无效');
  }
  return data;
}

export function battleStatusAssets(data) {
  return Object.values(data?.effects ?? {}).flatMap(effect => effect.frame_count ?
    ['main', 'intrinsic'].filter(layer => effect[`${layer}_sheet`]).map(layer => ({
      path: effect[`${layer}_sheet`], sha256: effect[`${layer}_sha256`],
      width: effect.frame_width * effect.frame_count, height: effect.frame_height, owners: ['shared'],
    })) : []);
}

// GAME.exe 509330: controlling flags take precedence, then status10, then
// ordinary slots. Mode6 is immunity, not a visible status. Slot +13 owns the
// animation frame; drawing never advances the simulation or starts a new clock.
export function visibleBattleStatuses(actor, data) {
  if (!actor || actor.alive === false || actor.hp?.current === 0 || actor.escaped) return [];
  const records = [];
  for (const slot of actor.native_status_effects ?? nativeStatusPresentation(actor.native_status_slots)) {
    const {id_raw:id,mode_raw:mode,frame_raw:frame,flags_raw:flags}=slot;
    const effect = data?.effects[id];
    if (!id || mode === 6 || !effect?.frame_count) continue;
    if (frame >= effect.frame_count) continue;
    records.push({effect, frame, flags});
  }
  const controlling = records.find(row => row.flags & 0xe0);
  if (actor.status_flags_raw & 0xe0 && controlling) return [controlling];
  const special = records.find(row => row.effect.id_raw === 10);
  if (special) return [special];
  const kind = actor.current_skill_kind_raw ?? parseInt(actor.current_skill?.fixed_raw_hex?.slice(0, 2) ?? '00', 16);
  if (kind >= 18 || kind > 1 && kind < 11 && ![3, 4, 6, 7].includes(kind)) return [];
  return records.filter(row => !row.effect.above_head || ![3, 4, 6].includes(kind));
}

export function drawBattleStatuses(ctx, images, data, entries, scale) {
  for (const {actor, role, slot, alpha} of entries) {
    if (alpha <= 0) continue;
    for (const {effect, frame} of visibleBattleStatuses(actor, data)) {
      const width = effect.frame_width, height = effect.frame_height;
      const x = slot[0] - effect.anchor.x * scale;
      const y = slot[1] - (effect.anchor.y + (effect.above_head ? (role.cursor_height_raw ?? 0) + 32 : 0)) * scale;
      ctx.save();ctx.globalAlpha = alpha;
      for (const layer of ['main', 'intrinsic']) {
        const image = images.get(effect[`${layer}_sheet`]);
        if (!image) continue;
        ctx.globalCompositeOperation = layer === 'intrinsic' ? 'lighter' : 'source-over';
        drawBattleImage(ctx, image, frame * width, 0, width, height, x, y, width * scale, height * scale);
      }
      ctx.restore();
    }
  }
}
