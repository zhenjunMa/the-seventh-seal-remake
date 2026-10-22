import {PhaserRuntime} from './runtime.mjs';
import {drawGameScene} from '../map_scene_view.mjs';
import {BattleView} from '../battle_view.mjs';
import {BattleController} from '../core/combat.mjs';
import {WorldStore} from '../core/world.mjs';
import {resolveAction,applyNativeDamage,createNativeRng} from '../core/combat_rules.mjs';
import {createBattleSample,resourcesForWorld,consumeBattleMp} from '../combat_sample.mjs';

const $=id=>document.getElementById(id),keys=new Set(),json=async path=>{
  const response=await fetch(path);if(!response.ok)throw new Error(`定义读取失败：${path}`);return response.json();
};
const canvas=(width,height,paint)=>{const image=document.createElement('canvas');image.width=width;image.height=height;
  paint?.(image.getContext('2d'));return image;};
const status=value=>$('status').textContent=typeof value==='string'?value:JSON.stringify(value,null,2);
const background=canvas(960,800,c=>{c.fillStyle='#203c36';c.fillRect(0,0,960,800);
  for(let y=0;y<800;y+=16)for(let x=0;x<960;x+=16){c.fillStyle=(x+y)%32?'#2b4940':'#345349';c.fillRect(x,y,15,15);}});
const sheet=canvas(128,384,c=>{for(let direction=0;direction<8;direction++)for(let frame=0;frame<4;frame++){
  const x=frame*32,y=direction*48;c.fillStyle='#d8b678';c.fillRect(x+9,y+6,14,12);
  c.fillStyle=direction%2?'#688dc7':'#7fa8de';c.fillRect(x+6,y+18,20,20);
  c.fillStyle='#e7dfbd';c.fillRect(x+7+frame%2*2,y+38,6,8);c.fillRect(x+19-frame%2*2,y+38,6,8);}});
const glow=canvas(128,384,c=>{for(let y=0;y<384;y+=48)for(let x=0;x<128;x+=32){c.fillStyle='#141a30';c.fillRect(x+6,y+18,20,20);}});
const object=canvas(48,60,c=>{c.fillStyle='#593b27';c.fillRect(18,30,12,30);c.fillStyle='#436b40';c.fillRect(0,0,48,40);});
const world={location:{map_id:'M17010',x:480,y:400,direction:1},object_states:{},flags:[]};
const viewState={x:480,y:400,zoom:1,frame:0,collision:false};
const scene={data:{id:'M17010',role_layer_preview:2},bitmap:background,objects:[{index:0,bitmap:object,draw_x:500,draw_y:355,layer:2,sort_y:415}],
  npcs:[{id:'preview-npc',x:420,y:410,direction:2,bitmap:sheet,resource:{frame_width:32,frame_height:48,frames_per_direction:4,interval_ms:180,anchor_x:16,anchor_y:40}}]};
const mapOptions=()=>({scene,world,role:{frame_width:32,frame_height:48,map_draw_offset:{x:0,y:-40}},action:{bitmap:sheet},view:viewState,
  objectBitmap:(_s,o)=>o.bitmap,openingQueue:null,nearest:null,time:0});
let mode='exploration',battle,view,lastError=null,manualPause=false;
const listeners=new AbortController(),inputOptions={signal:listeners.signal};
const runtime=await PhaserRuntime.create({parent:$('phaserHost'),focusTarget:$('focus'),onError:error=>{lastError=error.message;status(error.stack);}});
const images=new Map(),imageHints=new Map();
function placeholder(asset){
  const hint=imageHints.get(asset.path),kind=/intrinsic|indexed/i.test(asset.path)?'light':hint?.kind??'actor';
  const fw=hint?.width??asset.width,fh=hint?.height??asset.height;
  const anchor=hint?.anchor??{x:fw/2,y:fh*.85},color=asset.owners?.includes('001')?'#d8b678':'#79aeb5';
  const key=JSON.stringify([asset.width,asset.height,fw,fh,anchor,kind,color]);
  if(!images.has(key))images.set(key,canvas(asset.width,asset.height,c=>{
    for(let y=0;y<asset.height;y+=fh)for(let x=0;x<asset.width;x+=fw){
      const w=Math.min(48,fw*.4),h=Math.min(80,fh*.6),cx=x+Math.max(w/2,Math.min(fw-w/2,anchor.x));
      const foot=y+Math.min(fh-2,anchor.y);
      if(kind==='effect'){
        c.strokeStyle='#ead39b';c.lineWidth=3;c.beginPath();c.arc(cx,Math.max(y+12,foot-30),Math.min(30,fw/3,fh/3),0,Math.PI*2);c.stroke();
      }else{
        c.fillStyle=kind==='light'?'#142420':color;c.fillRect(cx-w/2,foot-h*.7,w,h*.7);
        c.fillRect(cx-w*.3,foot-h,w*.6,h*.25);
      }
    }
  }));
  return images.get(key);
}
function showMap(){mode='exploration';runtime.setPhase('map');runtime.presentMap(mapOptions());$('attack').disabled=true;}
const battlePhase=phase=>`battle-${['command','action','charging'].includes(phase)?phase:'result'}`;
function showBattle(){
  mode='battle';runtime.setPhase(battlePhase(battle.state.phase));
  drawBattle(runtime.battle.clock.time);$('attack').disabled=runtime.paused||!battle.canChoose('yantu');status(report());
}
function report(){return {engine:runtime.snapshot(),mode,error:lastError,
  battle:battle?{phase:battle.state.phase,contacts:battle.state.history.filter(h=>h.impact).length,
    hp:battle.state.actors.map(a=>({id:a.id,hp:a.hp.current,mp:a.mp.current}))}:null};}
function drawBattle(now){view.draw(battle.presentationSnapshot(),now);runtime.battle.surface.endFrame();}
function compareMap(){
  const before=mode;showMap();
  const expected=canvas(640,480,c=>drawGameScene(c,{...mapOptions(),width:640,height:480}));
  const actual=canvas(640,480);runtime.capture('exploration',actual);
  const a=actual.getContext('2d').getImageData(0,0,640,480).data,b=expected.getContext('2d').getImageData(0,0,640,480).data;
  let different=0,maxDelta=0;
  for(let i=0;i<a.length;i+=4){let diff=false;for(let c=0;c<4;c++){const delta=Math.abs(a[i+c]-b[i+c]);maxDelta=Math.max(maxDelta,delta);if(delta>1)diff=true;}if(diff)different++;}
  const result={differentPixels:different,totalPixels:640*480,maxChannelDelta:maxDelta};
  if(before==='battle')showBattle();
  status({...report(),mapComparison:result});return result;
}
$('map').onclick=showMap;
$('battle').onclick=showBattle;
$('attack').onclick=async()=>{try{$('attack').disabled=true;await battle.choose('yantu');status(report());}
  catch(error){lastError=error.message;status(error.stack);}finally{$('attack').disabled=runtime.paused||mode!=='battle'||!battle.canChoose('yantu');}};
$('pause').onclick=()=>{
  manualPause=!manualPause;if(manualPause)runtime.pause();else runtime.resume();
  $('pause').textContent=manualPause?'继续运行':'暂停运行';
  $('attack').disabled=runtime.paused||mode!=='battle'||!battle?.canChoose('yantu');status(report());
};
$('compare').onclick=compareMap;
$('capture').onclick=()=>{const image=canvas(640,480);runtime.capture(mode,image);const link=document.createElement('a');
  link.download='phaser-preview.png';link.href=image.toDataURL('image/png');link.click();};
window.addEventListener('keydown',event=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d','Shift'].includes(event.key)){
  event.preventDefault();if(!runtime.paused)keys.add(event.key);}},inputOptions);
window.addEventListener('keyup',event=>keys.delete(event.key),inputOptions);window.addEventListener('blur',()=>keys.clear(),inputOptions);
$('focus').addEventListener('wheel',event=>{event.preventDefault();if(!runtime.paused)viewState.zoom=Math.max(.4,Math.min(3,viewState.zoom*(event.deltaY<0?1.1:1/1.1)));},{...inputOptions,passive:false});
runtime.start({phase:'map',suspend:()=>keys.clear(),exploration:(now,delta)=>{
    const dt=Math.min(delta/1000,.08);
    const dx=Number(keys.has('ArrowRight')||keys.has('d'))-Number(keys.has('ArrowLeft')||keys.has('a'));
    const dy=Number(keys.has('ArrowDown')||keys.has('s'))-Number(keys.has('ArrowUp')||keys.has('w'));
    if(dx||dy){const speed=keys.has('Shift')?250:140;world.location.x+=dx*speed*dt;world.location.y+=dy*speed*dt;viewState.frame=Math.floor(now/120)%4;}
    viewState.x=world.location.x;viewState.y=world.location.y;runtime.presentMap(mapOptions());
  },battle:now=>{if(view&&battle)drawBattle(now);}});
showMap();status('Phaser 探索场景已准备；正在读取现有战斗定义…');
window.phaserPreview={runtime,mapOptions,compareMap,report,showMap,glow};
try{
  const [seed,data,metadata]=await Promise.all([json('/data/world_seed.json'),json('/data/combat_sample.json'),json('/data/battle_view.json')]);
  for(const role of metadata.roles)for(const action of role.actions)imageHints.set(action.sheet,{kind:'actor',width:role.frame_width,height:role.frame_height,anchor:role.anchor});
  for(const effect of metadata.effects)imageHints.set(effect.sheet,{kind:'effect',width:effect.frame_width,height:effect.frame_height,anchor:effect.anchor});
  const store=new WorldStore(seed,['M01010','M01030']),sample=createBattleSample(store.snapshot(),data);
  view=new BattleView({canvas:runtime.battle.surface.canvas,assetLoader:placeholder,jsonLoader:json});
  await view.prepare();view.setRoster(sample.actors,sample.skills);
  battle=new BattleController({world:store,resolveAction,applyDamage:applyNativeDamage,
    playAction:(result,hooks)=>view.playAction(result,hooks),resourcesForWorld,consumeResources:consumeBattleMp,
    now:()=>runtime.battle.clock.time,notify:snapshot=>{if(mode==='battle')runtime.setPhase(battlePhase(snapshot.phase));}});
  battle.start({...sample,rng:createNativeRng(12345)});
  $('battle').disabled=false;Object.assign(window.phaserPreview,{battle,view});status({...report(),mapComparison:compareMap()});
}catch(error){lastError=error.message;status(error.stack);}
window.addEventListener('pagehide',event=>{if(event.persisted)return;listeners.abort();view?.destroy();runtime.destroy();},{once:true});
