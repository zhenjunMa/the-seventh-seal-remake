import test from 'node:test';
import assert from 'node:assert/strict';
import {battleViewport,battleBallState,battleActorPositions} from '../web/core/battle_layout.mjs';
test('battle source plane stays 4:3 with identical HUD and pointer transforms in wide and narrow screens',()=>{
  for(const [w,h]of [[1280,960],[1200,600],[600,900]]){const v=battleViewport(w,h);assert.equal(v.width/v.height,4/3);assert.equal(v.x+640*v.scale,w-v.x);assert.equal(v.y+480*v.scale,h-v.y);assert.ok(v.x>=0&&v.y>=0);}
});
test('zero and just-spent charge leave the original glass empty; full charge fills green',()=>{
  assert.equal(battleBallState({gauge:0,delay:0},20000),null);
  assert.equal(battleBallState({gauge:-20000,delay:0},20000).top,46);
  assert.deepEqual(battleBallState({gauge:20000,delay:0},20000),{top:0,color:[0,128,0],phase:'charge',level:23});
  assert.equal(battleBallState({gauge:24000,delay:0},20000).top,0);
});
test('skill preparation draws a separate lower-half fill instead of the ordinary negative charge',()=>{
  assert.equal(battleBallState({gauge:-20000,delay:20000},20000),null);
  const p=battleBallState({gauge:-20000,delay:10000},20000);assert.equal(p.phase,'preparation');assert.equal(p.top,35);
});

test('Four source formation slots stay fixed for every party size, with gaps and reordered role identities',()=>{
  // 5181D0 source pairs, projected at the retained 640x480 zero camera:
  // X=320+source X, Y=80+source Y. Never compact occupied positions.
  const expected=[[460,280],[540,250],[510,330],[590,290]];
  for(let occupied=1;occupied<=4;occupied++)for(let first=0;first<4;first++){
    const roster=Array.from({length:occupied},(_,i)=>({id:`role-${i}`,side:'player',party_slot_zero_based:(first+i)%4}));
    const positions=battleActorPositions([...roster].reverse());
    for(const actor of roster)assert.deepEqual(positions[actor.id],expected[actor.party_slot_zero_based]);
  }
});

test('Three-party formation exchanges move Wadi to the selected fixed slot without moving the others',()=>{
  const roster=['001','002','003'].map((id,i)=>({id,side:'player',party_slot_zero_based:i}));
  const before=battleActorPositions(roster);assert.deepEqual(before['003'],[510,330]);
  roster[2].party_slot_zero_based=3;const after=battleActorPositions(roster);
  assert.deepEqual(after['003'],[590,290]);assert.deepEqual(after['001'],before['001']);assert.deepEqual(after['002'],before['002']);
});
