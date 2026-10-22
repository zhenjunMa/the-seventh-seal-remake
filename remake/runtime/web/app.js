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

actions.boot().catch(error=>{actions.status(error.message,true);$('loading').querySelector('p').textContent=error.message;});
