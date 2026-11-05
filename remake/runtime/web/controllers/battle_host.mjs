import {playbackTask} from '../core/story_playback.mjs';

// Composition adapter: combat receives named capabilities and read-only data
// access, rather than the application's mutable state/action registries.
export function createBattleHost({state, actions, $, canvas, exploration, story}) {
  const battleElements = new Set(['battleCanvas', 'battleHud', 'battleCommands', 'battleMessage']);
  const host = {
    element(id) {
      if (!battleElements.has(id)) throw new Error(`战斗界面未声明元素：${id}`);
      return $(id);
    },
    services: Object.fromEntries(['json', 'readConfiguredData', 'log', 'status',
      'guarded', 'currentPlayTime', 'presentGameOver', 'refreshPartyMenu']
      .map(name => [name, (...args) => actions[name]?.(...args)])),
    get phase() { return state.scenes.phase; },
    setPhase(phase) { state.scenes.setPhase(phase); },
    get sidePriority() { return state.sidePriority; },
    set sidePriority(value) { state.sidePriority = value; },
    get lastBattle() { return state.lastBattle; },
    set lastBattle(value) { state.lastBattle = value; },
    clearBattleLog() { state.logs = []; $('eventLog').textContent = ''; },
    loadCombatData(signal) {
      if (state.battleData) return null;
      return playbackTask(actions.json(state.catalog.combat_sample ?? 'data/combat_sample.json'), signal).then(value => {
        signal?.throwIfAborted();
        state.battleData = value;
      });
    },
    menu: {
      canTest: () => state.menuContext && !state.menuContext.combat && state.scenes.phase === 'party-menu',
      get nameCharset() { return state.operationMenu?.techniques?.supplement?.name_charset; },
      get textRenderer() { return state.operationMenu?.textRenderer; },
      settings: () => state.menuSettings?.snapshot() ?? {},
      begin: () => actions.beginTechniqueTestMenu({retainVisible: true}),
      cover: ticket => actions.hideTechniqueTestMenu?.(ticket),
      resume: ticket => actions.resumeTechniqueTestMenu(ticket),
    },
    presentation: {
      captureReturn({phase = state.scenes.phase} = {}) {
        const map = exploration.capture(), dialogue = story.capture();
        return {
          restore({refresh = false} = {}) {
            map.restore();
            dialogue.restore();
            state.scenes.setPhase(phase);
            state.audio?.setScene({mapId: state.world.location.map_id, battle: false});
            exploration.resize();
            if (refresh) exploration.resume();
          },
        };
      },
      capture(kind = 'exploration') {
        if (state.engine?.captureTexture) return state.engine.captureTexture(kind);
        const source = actions.captureScene?.(kind) ?? (kind === 'battle' ? $('battleCanvas') : canvas);
        return state.battleTransition.capture(source);
      },
      captureMenu: () => state.engine?.captureInterface?.($('operationFrame')),
      show({scripted = false} = {}) {
        state.engine?.setMode('battle');
        for (const id of ['battleCanvas', 'battleHud', 'battleCommands']) $(id).hidden = false;
        exploration.hide();
        story.hide({shade: scripted});
        exploration.resize();
      },
      hide() { for (const id of ['battleCanvas', 'battleHud', 'battleCommands']) $(id).hidden = true; },
      label: name => exploration.label(name),
      refreshExploration: () => exploration.refresh(),
    },
  };
  for (const key of ['world', 'engine', 'audio', 'catalog', 'battleTransition',
    'partyCombat', 'partySkills', 'partyReactions', 'statusData', 'reactionData', 'selectedRole']) {
    Object.defineProperty(host, key, {get: () => state[key]});
  }
  return host;
}
