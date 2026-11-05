// Each presentation owner captures and restores its own transient state.
// These handles do not pause the exploration clock used by story playback.
export function createExplorationPresentation({state, actions, $, canvas}) {
  const refresh = () => {
    actions.buildHud?.();
    actions.updateNearest?.();
  };
  return {
    capture() {
      const view = {...state.view}, name = $('mapName').textContent;
      const hidden = canvas.hidden;
      return {
        restore() {
          Object.assign(state.view, view);
          $('mapName').textContent = name;
          canvas.hidden = hidden;
        },
      };
    },
    hide() { canvas.hidden = true; },
    label(name) { $('mapName').textContent = name; },
    resize() { actions.resize?.(); },
    refresh,
    resume() {
      refresh();
      canvas.focus?.({preventScroll: true});
    },
  };
}

export function createStoryPresentation({$, state}) {
  return {
    capture() {
      const dialogue = $('dialogue').hidden, shade = $('openingShade');
      const hidden = shade.hidden, opacity = shade.style?.opacity;
      return {
        restore() {
          $('dialogue').hidden = dialogue;
          shade.hidden = hidden;
          if (shade.style) shade.style.opacity = opacity;
        },
      };
    },
    hide({shade = false} = {}) {
      $('dialogue').hidden = true;
      if (shade) $('openingShade').hidden = true;
    },
    clearInput() { state.keys?.clear(); },
  };
}
