import test from 'node:test';
import assert from 'node:assert/strict';
import {MapNameNoticeView} from '../web/map_name_notice_view.mjs';
import {ActionClock} from '../web/phaser/components/action_clock.mjs';

test('Map names slide into the upper right, pause with exploration and replace the previous name',()=>{
  const clock=new ActionClock(),draws=[],style=new Map(),root={hidden:true,style:{setProperty:(key,value)=>style.set(key,value)},parentElement:{getBoundingClientRect:()=>({width:1280,height:960})}};
  const view=Object.assign(Object.create(MapNameNoticeView.prototype),{root,canvas:{style:{}},
    context:{clearRect(){},drawImage(image,x,y){draws.push({image,x,y,alpha:this.globalAlpha});}},
    label:{textContent:''},ink:{},resource:{width:138,height:47,bitmaps:[{plate:true}]},clock,
    textRenderer:{paint:()=>({offsetX:0,offsetY:0})}});
  clock.update(0);view.show('火之谷');
  assert.equal(root.hidden,false);assert.equal(view.label.textContent,'火之谷');
  assert.equal(style.get('--map-name-scale'),'2');
  clock.advance(18*24);
  assert.deepEqual(draws.at(-2),{image:view.resource.bitmaps[0],x:502,y:0,alpha:1});
  clock.paused=true;const count=draws.length;clock.advance(10000);assert.equal(draws.length,count);
  clock.paused=false;clock.advance(60*24);
  assert.equal(draws.at(-2).x,502,'The native hold spans sixty visits');
  clock.advance(24);assert.equal(draws.at(-2).x,510);
  view.show('白森林');assert.equal(view.label.textContent,'白森林');assert.equal(clock.tasks.size,1);
  clock.advance(97*24);assert.equal(root.hidden,true);assert.equal(view.label.textContent,'');assert.equal(clock.tasks.size,0);
  view.show('火之谷');view.close();clock.advance(10000);assert.equal(root.hidden,true);assert.equal(clock.tasks.size,0);
});
