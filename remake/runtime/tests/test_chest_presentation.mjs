import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createStoryController} from '../web/controllers/story.mjs';
import {StoryPlayback} from '../web/core/story_playback.mjs';
import {ActionClock} from '../web/phaser/components/action_clock.mjs';
import {RewardNoticeView} from '../web/reward_notice_view.mjs';
import {nativeNpcActionBindings} from '../web/core/map_npcs.mjs';

const roles=JSON.parse(fs.readFileSync(new URL('../web/data/story/shared.json',import.meta.url),'utf8')).roles;
for(const role of Object.values(roles))role.native_action_bindings=nativeNpcActionBindings(role);

test('Chest actor action uses the controlled role, faces the object, pauses and clears on cancellation',async()=>{
  const clock=new ActionClock(),playback=new StoryPlayback({clock});
  const state={world:{value:{leader_id:'002'},location:{x:0,y:0,direction:3}},openingResources:{roles},engine:{exploration:{clock}}};
  const controller=createStoryController({state,actions:{},$:()=>({}),canvas:{}});
  const task=controller.animateObjectInteraction({mapId:'M70020',objectIndex:4,object:{x_native:16,y_native:16},
    actionGroup:4,playback,signal:playback.signal});
  const actor=state.objectActorPreview;assert.equal(actor.role.id,'002');assert.equal(actor.action.index,4);assert.equal(actor.direction,0);
  clock.advance(actor.action.interval_raw*2);await Promise.resolve();assert.equal(actor.frame,2);
  clock.paused=true;clock.advance(10000);await Promise.resolve();assert.equal(actor.frame,2);
  playback.cancel();await assert.rejects(task,{name:'AbortError'});assert.equal(state.objectActorPreview,null);assert.equal(clock.tasks.size,0);
  state.world.value.leader_id='005';
  await controller.animateObjectInteraction({object:{x_native:16,y_native:16},actionGroup:4});
  assert.equal(state.objectActorPreview,null);assert.equal(clock.tasks.size,0,'Missing source channels do not borrow another role action');
});

test('Reward notices keep each item name, follow paused exploration time and release their frame task',()=>{
  const clock=new ActionClock(),labels=[],draws=[],root={hidden:true,style:{},parentElement:{getBoundingClientRect:()=>({width:640,height:480})}};
  const view=Object.assign(Object.create(RewardNoticeView.prototype),{root,canvas:{style:{}},context:{clearRect(){},drawImage(image,x,y){draws.push({image,x,y});}},
    label:{set textContent(text){labels.push(text);}},ink:{},resource:{width:201,height:50,bitmaps:[{plate:true}]},clock,queue:[],
    textRenderer:{paint:()=>({offsetX:0,offsetY:0})}});
  view.show(['红宝石','高纯度红晶矿']);assert.equal(root.hidden,false);assert.equal(labels.at(-1),'获得 红宝石');
  clock.advance(840);assert.equal(draws.at(-2).x,439);assert.equal(draws.at(-2).y,430);
  clock.paused=true;const before=draws.length;clock.advance(10000);assert.equal(draws.length,before);assert.equal(labels.at(-1),'获得 红宝石');
  clock.paused=false;clock.advance(2500);assert.equal(labels.at(-1),'获得 高纯度红晶矿');
  clock.advance(3300);assert.equal(root.hidden,true);assert.equal(clock.tasks.size,0);
  view.show(['红宝石']);view.close();clock.advance(10000);assert.equal(root.hidden,true);assert.equal(clock.tasks.size,0);
});
