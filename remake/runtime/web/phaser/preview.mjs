import {PhaserRuntime} from './runtime.mjs';
import {drawGameScene} from '../map_scene_view.mjs';
import {BattleView} from '../battle_view.mjs';
import {BattleController} from '../core/combat.mjs';
import {WorldStore} from '../core/world.mjs';
import {resolveAction,applyNativeDamage,createNativeRng} from '../core/combat_rules.mjs';
import {createBattleSample,resourcesForWorld,consumeBattleMp} from '../combat_sample.mjs';
import {MovementMap,MAP_FOOTPRINT,mapActorPosition} from '../core/movement.mjs';
import {MapLocomotion,mapMotionProfile} from '../core/map_locomotion.mjs';
import {MapNpcRuntime} from '../core/map_npcs.mjs';

const $=id=>document.getElementById(id),keys=new Set(),json=async path=>{
  const response=await fetch(path);if(!response.ok)throw new Error(`定义读取失败：${path}`);return response.json();
};
const canvas=(width,height,paint)=>{const image=document.createElement('canvas');image.width=width;image.height=height;
  paint?.(image.getContext('2d'));return image;};
const status=value=>$('status').textContent=typeof value==='string'?value:JSON.stringify(value,null,2);
const movement={schema:'seventh-seal-map-movement',version:1,width:60,height:50,cell_size:16,
  native_coordinate_shift:3,native_step_shift:1,native_to_pixel_scale:2,triggers:[],
  terrain_rows:Array.from({length:50},(_,y)=>Array.from({length:60},(_,x)=>
    x===34&&y>=18&&y<=31||y===31&&x>=24&&x<=34?'1':'0').join(''))};
const background=canvas(960,800,c=>{c.fillStyle='#203c36';c.fillRect(0,0,960,800);
  for(let y=0;y<800;y+=16)for(let x=0;x<960;x+=16){c.fillStyle=(x+y)%32?'#2b4940':'#345349';c.fillRect(x,y,15,15);}});
const ground=background.getContext('2d');ground.fillStyle='#805249';
for(let y=0;y<50;y++)for(let x=0;x<60;x++)if(movement.terrain_rows[y][x]==='1')ground.fillRect(x*16,y*16,16,16);
const sheet=canvas(128,384,c=>{for(let direction=0;direction<8;direction++)for(let frame=0;frame<4;frame++){
  const x=frame*32,y=direction*48;c.fillStyle='#d8b678';c.fillRect(x+9,y+6,14,12);
  c.fillStyle=direction%2?'#688dc7':'#7fa8de';c.fillRect(x+6,y+18,20,20);
  c.fillStyle='#e7dfbd';c.fillRect(x+7+frame%2*2,y+38,6,8);c.fillRect(x+19-frame%2*2,y+38,6,8);}});
const glow=canvas(128,384,c=>{for(let y=0;y<384;y+=48)for(let x=0;x<128;x+=32){c.fillStyle='#141a30';c.fillRect(x+6,y+18,20,20);}});
const object=canvas(48,60,c=>{c.fillStyle='#593b27';c.fillRect(18,30,12,30);c.fillStyle='#436b40';c.fillRect(0,0,48,40);});
const world={location:{map_id:'M17010',x:480,y:400,direction:1},object_states:{},flags:[]};
const viewState={x:480,y:400,zoom:1,frame:0,action:0,collision:false};
const hex=bytes=>Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
// Synthetic contracts for the placeholder only; no source record is rewritten.
const mapRole={frame_width:32,frame_height:48,map_draw_offset:{x:-16,y:-40},anchor:{x:32,y:40},
  actions:[180,250,130].map((interval,index)=>{const raw=new Uint8Array(172);raw[0x7e]=index;
    return {index,interval_raw:interval,frame_count:index?4:1,frames_per_direction:index?4:1,raw_hex:hex(raw),bitmap:sheet};})};
const scene={data:{id:'M17010',role_layer_preview:2,movement},movement:new MovementMap(movement),bitmap:background,
  objects:[{index:0,bitmap:object,draw_x:300,draw_y:230,layer:2,sort_y:290}],npcs:[]};
const mapMotion=new MapLocomotion();let input={dx:0,dy:0},lastTravel={dx:0,dy:0},blocked=false;
function movementSample(kind='npc'){
  keys.clear();mapMotion.reset();Object.assign(world.location,{x:kind==='wall'?520:475,y:kind==='wall'?464:400,direction:1});
  Object.assign(viewState,{action:0,frame:0,collisionFeedback:null});
  scene.npcs=[{id:'preview-npc',resource_id:'preview',slot_zero_based:10,x:464,y:400,direction:1,bitmap:sheet,
    resource:{frame_width:32,frame_height:48,frames_per_direction:4,interval_ms:180,anchor_x:32,anchor_y:40}}];
  const record=new Uint8Array(1221);
  scene.npcRuntime=new MapNpcRuntime({scene,table:{npc_records:[{slot_zero_based:10,raw_hex:hex(record)}]},
    roles:{preview:mapRole},random:createNativeRng(21)});
  const actor=scene.npcRuntime.actors.get('preview-npc');actor.wait=0;
  actor.path=Array.from({length:4},(_,index)=>({x:30+index,y:25}));
  input={dx:0,dy:0};lastTravel={dx:0,dy:0};blocked=false;
}
movementSample();
const mapOptions=()=>({scene,world,role:mapRole,action:mapRole.actions[viewState.action],view:viewState,
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
function showMap(){mode='exploration';runtime.setPhase('map');viewState.x=world.location.x;viewState.y=world.location.y;
  runtime.presentMap(mapOptions());drawMovementOverlay();$('attack').disabled=true;}
const battlePhase=phase=>`battle-${['command','action','charging'].includes(phase)?phase:'result'}`;
function showBattle(){
  mode='battle';runtime.setPhase(battlePhase(battle.state.phase));
  drawMovementOverlay();
  drawBattle(runtime.battle.clock.time);$('attack').disabled=runtime.paused||!battle.canChoose('yantu');status(report());
}
function report(){return {engine:runtime.snapshot(),mode,error:lastError,
  movement:{location:{...world.location},action:viewState.action,frame:viewState.frame,blocked,
    input:{...input},travel:{...lastTravel},feedback:viewState.collisionFeedback,npcs:scene.npcs.map(npc=>({
      ...mapActorPosition(npc),role:undefined,logical:{x:npc.x,y:npc.y}}))},
  resources:view?{...view.resourceSnapshot(),textures:runtime.battle.surface.textures.snapshot()}:null,
  battle:battle?{phase:battle.state.phase,contacts:battle.state.history.filter(h=>h.impact).length,
    hp:battle.state.actors.map(a=>({id:a.id,hp:a.hp.current,mp:a.mp.current}))}:null};}
function drawBattle(now){view.draw(battle.presentationSnapshot(),now);runtime.battle.surface.endFrame();}
function drawMovementOverlay(){
  const overlay=$('movementOverlay'),c=overlay.getContext('2d');c.clearRect(0,0,640,480);
  if(mode!=='exploration')return;
  if($('feet').checked){c.save();c.translate(320,240);c.scale(viewState.zoom,viewState.zoom);c.translate(-viewState.x,-viewState.y);
    const feet=(at,color)=>{c.strokeStyle=color;c.lineWidth=1/viewState.zoom;
      c.strokeRect(at.x-MAP_FOOTPRINT.halfWidth,at.y-MAP_FOOTPRINT.halfHeight,MAP_FOOTPRINT.halfWidth*2,MAP_FOOTPRINT.halfHeight*2);};
    feet(world.location,'#ffd27a');for(const npc of scene.npcs)feet(mapActorPosition(npc),'#7cffff');
    const arrow=(dx,dy,color)=>{const length=Math.hypot(dx,dy);if(!length)return;
      c.strokeStyle=color;c.beginPath();c.moveTo(world.location.x,world.location.y);
      c.lineTo(world.location.x+dx/length*24,world.location.y+dy/length*24);c.stroke();};
    arrow(input.dx,input.dy,'#ffd27a');arrow(lastTravel.dx,lastTravel.dy,'#8bdf9c');c.restore();}
  $('motionStatus').textContent=`位置 ${world.location.x.toFixed(1)}, ${world.location.y.toFixed(1)} · ${blocked?'受阻踏步':['待机','行走','奔跑'][viewState.action]} · 动画帧 ${viewState.frame} · 回缩 ${(viewState.collisionFeedback?.x??0).toFixed(2)}, ${(viewState.collisionFeedback?.y??0).toFixed(2)}`;
}
function compareMap(){
  const before=mode,smoothing=runtime.actorSmoothing,renderScale=runtime.fixedRenderScale;
  runtime.setActorSmoothing(false);runtime.fixedRenderScale=1;runtime.resize();showMap();
  const expected=canvas(640,480,c=>{c.imageSmoothingEnabled=false;drawGameScene(c,{...mapOptions(),width:640,height:480});});
  const actual=canvas(640,480);runtime.capture('exploration',actual);
  const a=actual.getContext('2d').getImageData(0,0,640,480).data,b=expected.getContext('2d').getImageData(0,0,640,480).data;
  let different=0,maxDelta=0;
  for(let i=0;i<a.length;i+=4){let diff=false;for(let c=0;c<4;c++){const delta=Math.abs(a[i+c]-b[i+c]);maxDelta=Math.max(maxDelta,delta);if(delta>1)diff=true;}if(diff)different++;}
  const result={differentPixels:different,totalPixels:640*480,maxChannelDelta:maxDelta};
  runtime.fixedRenderScale=renderScale;runtime.resize();runtime.setActorSmoothing(smoothing);if(before==='battle')showBattle();
  status({...report(),mapComparison:result});return result;
}
$('map').onclick=showMap;
$('actorSmoothing').onclick=()=>{const enabled=runtime.setActorSmoothing(!runtime.actorSmoothing);
  $('actorSmoothing').textContent=`人物平滑：${enabled?'开':'关'}`;$('actorSmoothing').setAttribute('aria-pressed',String(enabled));status(report());};
$('actorSmoothing').textContent=`人物平滑：${runtime.actorSmoothing?'开':'关'}`;$('actorSmoothing').setAttribute('aria-pressed',String(runtime.actorSmoothing));
$('battle').onclick=showBattle;
$('wallSample').onclick=()=>{movementSample('wall');showMap();};
$('npcSample').onclick=()=>{movementSample();showMap();};
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
    scene.npcRuntime.update(now,{player:world.location});
    const from={...world.location},running=keys.has('Shift'),length=Math.hypot(dx,dy);
    const speed=mapMotionProfile(mapRole.actions[running?2:1],movement).speed;
    const moved=length?scene.movement.moveAndSlide(from.x,from.y,dx/length*speed*dt,dy/length*speed*dt,
      {obstacles:scene.movement.actorObstacles(scene.npcs)}):null;
    const pose=mapMotion.advance(moved,{from,dx,dy,running,elapsedMs:dt*1000,role:mapRole,movement});
    if(moved)Object.assign(world.location,{x:moved.x,y:moved.y,direction:pose.direction??from.direction});
    Object.assign(viewState,{action:pose.action,frame:pose.frame,collisionFeedback:pose.feedback});
    input={dx,dy};lastTravel={dx:world.location.x-from.x,dy:world.location.y-from.y};blocked=pose.blocked;
    viewState.x=world.location.x;viewState.y=world.location.y;runtime.presentMap(mapOptions());
    drawMovementOverlay();
  },battle:now=>{drawMovementOverlay();if(view&&battle)drawBattle(now);}});
showMap();status('Phaser 探索场景已准备；正在读取现有战斗定义…');
window.phaserPreview={runtime,mapOptions,compareMap,report,showMap,glow};
try{
  const [seed,data,metadata]=await Promise.all([json('/data/world_seed.json'),json('/data/combat_sample.json'),json('/data/battle_view.json')]);
  for(const role of metadata.roles)for(const action of role.actions)imageHints.set(action.sheet,{kind:'actor',width:role.frame_width,height:role.frame_height,anchor:role.anchor});
  for(const effect of metadata.effects)imageHints.set(effect.sheet,{kind:'effect',width:effect.frame_width,height:effect.frame_height,anchor:effect.anchor});
  const store=new WorldStore(seed,['M01010','M01030']),sample=createBattleSample(store.snapshot(),data);
  view=new BattleView({canvas:runtime.battle.surface.canvas,assetLoader:placeholder,jsonLoader:json});
  await view.prepare({actors:sample.actors,skills:sample.skills,inventory:seed.inventory,staged:true});view.setRoster(sample.actors,sample.skills);
  runtime.battle.surface.prepareImages(view.images);
  battle=new BattleController({world:store,resolveAction,applyDamage:applyNativeDamage,
    playAction:async(result,hooks)=>{
      const reason=Symbol('preview-resources');runtime.pause(reason);let lease;
      try{lease=await view.prepareAction(result);runtime.battle.surface.prepareImages(lease.images);}
      finally{runtime.resume(reason);}
      const pending=view.playAction(result,hooks);if(view.run)view.run.resourceLease=lease;else lease.release();return pending;
    },resourcesForWorld,consumeResources:consumeBattleMp,
    now:()=>runtime.battle.clock.time,notify:snapshot=>{if(mode==='battle')runtime.setPhase(battlePhase(snapshot.phase));}});
  battle.start({...sample,rng:createNativeRng(12345)});
  $('battle').disabled=false;Object.assign(window.phaserPreview,{battle,view});status({...report(),mapComparison:compareMap()});
}catch(error){lastError=error.message;status(error.stack);}
window.addEventListener('pagehide',event=>{if(event.persisted)return;listeners.abort();view?.destroy();runtime.destroy();},{once:true});
