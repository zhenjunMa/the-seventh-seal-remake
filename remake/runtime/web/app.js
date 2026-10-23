import {createRuntimeState} from './controllers/state.mjs';
import {createServicesController} from './controllers/services.mjs';
import {createMapController} from './controllers/map.mjs';
import {createStoryController} from './controllers/story.mjs';
import {createMenuController} from './controllers/menu.mjs';
import {createSessionController} from './controllers/session.mjs';
import {createBattleController} from './controllers/battle.mjs';
import {createInspectionController} from './controllers/inspection.mjs';
import {createInputController} from './controllers/input.mjs';
import {createBootController} from './controllers/boot.mjs';
import {PhaserRuntime} from './phaser/runtime.mjs';

const $ = id => document.getElementById(id), canvas = $('stage'), ctx = canvas.getContext('2d');
const state = createRuntimeState($);
// Each controller closes over the same explicit state and action registry.
// Assemble every adapter before starting asynchronous work.
const actions = {};
const context = {state, actions, $, canvas, ctx};
for (const create of [createServicesController, createMapController,
  createStoryController, createMenuController, createSessionController,
  createBattleController, createInspectionController, createInputController,
  createBootController]) Object.assign(actions, create(context));

const failed=error=>{void actions.cancelStoryPlayback(error);actions.status(error.message,true);$('loading').hidden=false;$('loading').querySelector('p').textContent=error.message;};
async function start(){
  state.engine=await PhaserRuntime.create({parent:$('phaserHost'),focusTarget:canvas,onError:failed});
  window.addEventListener('pagehide',event=>{
    if(event.persisted)return;
    void actions.cancelStoryPlayback();state.battleTransition?.cancel();
    actions.disposeBattles();actions.disposeInput();state.engine.destroy();
  });
  await actions.boot();
}
start().catch(failed);
