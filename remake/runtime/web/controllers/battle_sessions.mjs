// Transient combat state belongs to this controller, never to WorldStore or
// the shared application state. Switching owners replaces the complete frame.
function battleState(initial = {}) {
  const defaults = {
    battle: null, battleView: null, battleMenu: null, battleRng: null,
    battleNatural: false, battleSampleMode: false, battleCursorMemory: new Map(),
    battlePresentationError: null, battleEntryPending: false,
    battleResourceWaits: new Set(), scriptedBattleSession: null,
    skillTestSession: null, itemData: null,
  };
  return Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
    [key, initial[key] ?? value]));
}

export function createBattleSessions({initial, views = new Map()} = {}) {
  let current = battleState(initial);
  return {
    views,
    get current() { return current; },
    enter(kind, details = {}) {
      const previous = current;
      current = battleState({
        itemData: previous.itemData,
        battleCursorMemory: kind === 'field'
          ? previous.battleCursorMemory : new Map(previous.battleCursorMemory),
      });
      const session = {...details, kind, previous, runtime: current};
      if (kind === 'scripted') current.scriptedBattleSession = session;
      if (kind === 'skill-test') current.skillTestSession = session;
      return session;
    },
    owns(session) { return current === session.runtime; },
    leave(session) {
      if (current !== session.runtime) return false;
      current = session.previous;
      return true;
    },
    reset() { current = battleState(); },
  };
}
