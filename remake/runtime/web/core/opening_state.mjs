import {validateWorld} from './world.mjs';

// Pure construction: interrupted playback never commits part of a new game.
export function completedOpeningWorld(seed, result, direction, mapIds) {
  validateWorld(seed, mapIds);
  if (seed.opening?.id !== 'resurrect' || seed.opening.status !== 'pending'
      || result?.program_id !== 'new-game-resurrect' || result.control_map !== 'M17020'
      || result.location?.map_id !== 'M17020' || result.location.x !== 1092 || result.location.y !== 986)
    throw new Error('序章完成状态与原脚本不符');
  const next = structuredClone(seed);
  next.opening.status = 'complete';
  next.location = {...result.location, direction};
  next.revision++;
  return validateWorld(next, mapIds);
}
