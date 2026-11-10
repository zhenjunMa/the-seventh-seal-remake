import {createRuntimeState} from './controllers/state.mjs';
import {createServicesController} from './controllers/services.mjs';
import {createMapController} from './controllers/map.mjs';
import {createStoryController} from './controllers/story.mjs';
import {createMenuController} from './controllers/menu.mjs';
import {createSessionController} from './controllers/session.mjs';
import {createBattleController} from './controllers/battle.mjs';
import {createBattleHost} from './controllers/battle_host.mjs';
import {createInspectionController} from './controllers/inspection.mjs';
import {createInputController} from './controllers/input.mjs';
import {createBootController} from './controllers/boot.mjs';
import {createNativeServicesController} from './controllers/native_services.mjs';
import {PhaserRuntime} from './phaser/runtime.mjs';

const $ = id => document.getElementById(id), canvas = $('stage'), ctx = canvas.getContext('2d');
const state = createRuntimeState($);
// Assemble adapters before boot. Combat only receives the declared host ports;
// its transient sessions are private to the battle controller.
const actions = {};
const context = {state, actions, $, canvas, ctx};
for (const create of [createServicesController, createMapController,
  createStoryController, createNativeServicesController, createMenuController, createSessionController,
  createInspectionController, createInputController,
  createBootController]) Object.assign(actions, create(context));
Object.assign(actions, createBattleController({host: createBattleHost({
  ...context, exploration: actions.explorationPresentation, story: actions.storyPresentation,
})}));

const lifetime=new AbortController();
const failed=error=>{
  if(lifetime.signal.aborted)return;
  lifetime.abort(error);state.startupView?.hide();
  void actions.cancelStoryPlayback(error);actions.status(error.message,true);$('loading').hidden=false;$('loading').querySelector('p').textContent=error.message;
};
window.addEventListener('pagehide',event=>{
  if(event.persisted)return;
  lifetime.abort();
  void actions.cancelStoryPlayback();state.battleTransition?.cancel();
  actions.disposeBattles();actions.disposeInput();state.engine?.destroy();
});
async function startEngine(){
  const engine=await PhaserRuntime.create({parent:$('phaserHost'),focusTarget:canvas,onError:failed});
  if(lifetime.signal.aborted){engine.destroy();lifetime.signal.throwIfAborted();}
  state.engine=engine;
}
actions.boot(startEngine,lifetime.signal).catch(failed);
