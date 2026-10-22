// The original Game005_2 offers initial/memory battle cursor modes.
// Keep preferences outside world saves so changing UI/audio settings does not
// mark game progress as saved. Selection behavior is integrated separately.
export function createMenuSettings(options = {}) {
  const storage = options.storage ?? null;
  const storageKey = options.storageKey ?? 'seventh-seal-menu-settings-v1';
  const modes = ['initial', 'memory'];
  let saved = null;
  try { saved = JSON.parse(storage?.getItem(storageKey) ?? 'null'); } catch {}
  let battleCursor = options.battleCursor ?? (modes.includes(saved?.battleCursor) ? saved.battleCursor : 'memory');
  if (!modes.includes(battleCursor)) throw new Error('战斗光标设置无效');
  const snapshot = () => ({version:1, battleCursor});
  function setBattleCursor(value) {
    if (!modes.includes(value)) throw new Error('战斗光标设置无效');
    battleCursor = value;
    try { storage?.setItem(storageKey, JSON.stringify(snapshot())); } catch {}
    return snapshot();
  }
  return {snapshot, setBattleCursor};
}
