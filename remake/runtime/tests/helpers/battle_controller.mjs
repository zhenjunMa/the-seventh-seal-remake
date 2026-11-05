import {createBattleController} from '../../web/controllers/battle.mjs';
import {createBattleSessions} from '../../web/controllers/battle_sessions.mjs';
import {createBattleHost} from '../../web/controllers/battle_host.mjs';
import {createExplorationPresentation,createStoryPresentation} from '../../web/controllers/presentation_handoff.mjs';

// Fixtures inject the private owner explicitly. Production callers only see
// query/command methods and cannot replace a combat or view through app state.
export function createBattleFixtureController(context) {
  const sessions=createBattleSessions({initial:context.state,views:context.state.battleViews});
  const host=createBattleHost({...context,
    exploration:createExplorationPresentation(context),story:createStoryPresentation(context)});
  const controller=createBattleController({host,sessions});
  if (sessions.current.battle) {
    // Reconstruct the pre-entry presentation for fixtures seeded at finish().
    const view=context.state.view,hidden=context.canvas.hidden;
    context.state.view=context.state.battleCheckpoint??view;
    context.canvas.hidden=false;
    sessions.current.returnView=host.presentation.captureReturn({phase:'map'});
    context.state.view=view;context.canvas.hidden=hidden;
  }
  Object.assign(controller,{host,sessions});
  Object.defineProperty(controller,'runtime',{get:()=>sessions.current});
  return controller;
}
