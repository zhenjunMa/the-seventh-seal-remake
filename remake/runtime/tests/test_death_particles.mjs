import test from 'node:test';
import assert from 'node:assert/strict';
import {DeathParticles,DeathParticlePlayback,deathVisualRandom,deathParticleColor,createDeathParticleSurface} from '../web/death_particles.mjs';
import {TextureCache} from '../web/phaser/rendering/texture_cache.mjs';
import {AppearanceParticles} from '../web/appearance_particles.mjs';

const pixels=[{x:-8,y:-8,rgb:[255,255,255]},{x:8,y:8,rgb:[160,100,64]}];
const make=mode=>new DeathParticles({mode,pixels,random:deathVisualRandom(`test-${mode}`)});

test('source modes move pixels in distinct directions with RGB565 darkening, without global fading',()=>{
  const up=make(2),down=make(3),split=make(6),spin=make(7),rise=make(4);
  for(const p of [up,down,split,spin,rise]){p.step();p.step();}
  assert.ok(up.particles[0].y<-8);assert.ok(down.particles[0].y>-8);
  assert.equal(split.particles[0].x,-10);assert.equal(split.particles[1].x,10);
  assert.equal(rise.particles[0].y,-18);assert.ok(rise.visible[0].original);
  assert.equal(spin.cy,-6);assert.equal(spin.angle,4);
  assert.deepEqual(deathParticleColor([255,255,255],10,2),[173,215,173]);
  assert.deepEqual(deathParticleColor([255,255,255],10,6),[90,174,90]);
});

test('all seven modes finish in under one second at30/60/144Hz and on a slow frame',()=>{
  const mathRandom=Math.random;Math.random=()=>assert.fail('Particle presentation must use its local RNG');
  try{for(let mode=1;mode<=7;mode++)for(const hz of [30,60,144]){
    const effect=make(mode),play=new DeathParticlePlayback({mode,clock_ms:220,started:0,effect});let now=0;
    while(play.advance(now)&&now<1000)now+=1000/hz;
    assert.ok(play.done,`mode${mode}/${hz}Hz`);assert.ok(now<1000);assert.equal(effect.visible.length,0);
    assert.equal(play.advance(now+10000),false);
    const slow=new DeathParticlePlayback({mode,clock_ms:220,started:0,effect:make(mode)});
    slow.advance(0);assert.equal(slow.advance(1000),false);
  }}finally{Math.random=mathRandom;}
});

test('empty source pixels finish immediately; time duplication never advances particles twice',()=>{
  const empty=new DeathParticlePlayback({mode:1,clock_ms:220,started:0,effect:new DeathParticles({mode:1,pixels:[]})});assert.equal(empty.advance(0),false);
  const play=new DeathParticlePlayback({mode:6,clock_ms:220,started:0,effect:make(6)});play.advance(0);play.advance(300);const before=structuredClone(play.effect.particles);
  play.advance(300);assert.deepEqual(play.effect.particles,before);
});

test('scaled source anchors produce integer particle columns for both vertical modes',()=>{
  const originalDocument=globalThis.document;
  globalThis.document={createElement:()=>({getContext:()=>({createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)})})})};
  try{for(const mode of [2,5]){
    const effect=createDeathParticleSurface({rgba:new Uint8Array([255,255,255,255]),width:1,height:1,anchor:{x:305.9,y:372.6},mode,seed:'scaled-source'});
    effect.step();effect.step();assert.ok(Number.isInteger(effect.particles[0].x));assert.ok(Number.isFinite(effect.particles[0].y));
  }}finally{globalThis.document=originalDocument;}
});

test('cached glyph bitmaps upload once per revision and release after their idle allowance',()=>{
  let uploads=0,removed=0,images=0,canvases=0;
  const texture={source:[{width:8,height:8}],setFilter(){},refresh(){uploads++;}},scene={textures:{addImage(){images++;return texture;},addCanvas(){canvases++;return texture;},remove(){removed++;}}};
  const cache=new TextureCache(scene,{idleFrames:0}),canvas={width:8,height:8,gpuRasterRevision:0};cache.begin();cache.texture(canvas);cache.texture(canvas);
  assert.equal(canvases,1);assert.equal(images,0);assert.equal(uploads,0);
  canvas.gpuRasterRevision++;cache.texture(canvas);cache.texture(canvas);assert.equal(uploads,1);
  cache.begin();cache.prune();assert.equal(removed,1);assert.equal(cache.entries.size,0);
});

test('appearance3 particle progression completes early at stable30/60/144Hz, while headless fallback keeps the source hard ceiling',()=>{
  for(const hz of [30,60,144]){
    const effect=new AppearanceParticles({pixels:[{x:0,y:20,rgb:[255,255,255]}],random:()=>0}),
      playback=new DeathParticlePlayback({mode:3,clock_ms:60,started:0,effect});let now=0;
    while(playback.advance(now)&&now<1800)now+=1000/hz;
    assert.ok(now<1800);assert.ok(effect.calls<35);assert.equal(playback.advance(2000),false);
  }
  const empty=new DeathParticlePlayback({mode:3,clock_ms:60,started:0,effect:new AppearanceParticles({pixels:[],random:()=>0})});
  assert.equal(empty.advance(0),false);
  const bounded=new DeathParticlePlayback({mode:3,clock_ms:60,started:0,effect:{reset(){},step:()=>true}});
  assert.equal(bounded.advance(1799),true);assert.equal(bounded.advance(1800),false);
});

test('appearance2 empty pixels finish immediately and its source clock retains the hard ceiling',()=>{
  const empty=new DeathParticlePlayback({mode:2,clock_ms:60,started:0,effect:new AppearanceParticles({mode:2,pixels:[],random:()=>0})});
  assert.equal(empty.advance(0),false);
  const ceiling=new DeathParticlePlayback({mode:2,clock_ms:60,started:0,effect:{reset(){},step:()=>true}});
  assert.equal(ceiling.advance(1799),true);assert.equal(ceiling.advance(1800),false);
});
