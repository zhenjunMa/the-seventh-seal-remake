import {drawingContext,registerGlyph} from '../phaser/rendering/recorded_surface.mjs';
import {createDeathParticleSurface} from '../death_particles.mjs';
import {BattleLifecyclePlayback} from '../core/battle/battle_lifecycle.mjs';
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const pixel=(renderer,x,y)=>{const data=new Uint8Array(4),scale=renderer.width/640;
  renderer.gl.readPixels(Math.floor((x+.5)*scale),renderer.height-1-Math.floor((y+.5)*scale),1,1,renderer.gl.RGBA,renderer.gl.UNSIGNED_BYTE,data);return [...data];};
const near=(actual,expected)=>actual.every((value,index)=>Math.abs(value-expected[index])<=1);
const nonBlackRows=(renderer,x)=>{const gl=renderer.gl,data=new Uint8Array(renderer.height*4),scale=renderer.width/640;
  gl.readPixels(Math.floor((x+.5)*scale),0,1,renderer.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
  let rows=0;for(let at=0;at<data.length;at+=4)if(data[at]+data[at+1]+data[at+2]>3)rows++;return rows;};
const flush=game=>{const r=game.renderer;r.preRender();game.scene.render(r);r.postRender();};
async function until(test,message){for(let count=0;!test();count++){assert(count<180,message);await frame();}}

export async function checkWebglRendering(runtime,record){
  const stage=runtime.parent,oldPosition=stage.style.position;stage.style.position='relative';
  runtime.setPhase('battle-active');const surface=runtime.battle.surface;
  const paint=(top=[50,90,140],bottom=top)=>{surface.beginFrame();surface.fillStyle=`rgb(${top})`;surface.fillRect(0,0,640,240);surface.fillStyle=`rgb(${bottom})`;surface.fillRect(0,240,640,240);surface.endFrame();};
  paint();runtime.flush();assert(near(pixel(runtime.game.renderer,20,20),[50,90,140,255]),'WebGL 基础颜色错误');
  //034 CHR12/action3:5130D0 case0, mask7, default step2.52B2FD
  // subtracts each RGB565 channel separately, without darkening the foreground.
  const dim=document.createElement('canvas');dim.width=4;dim.height=4;
  dim.getContext('2d').fillStyle='rgb(165,130,66)';dim.getContext('2d').fillRect(0,0,4,4);
  for(const [mask,amount,expected]of [[7,4,[132,113,33,255]],[2,6,[165,105,66,255]],[7,40,[0,0,0,255]],[0,0,[165,130,66,255]]]){
    surface.beginFrame();surface.nativeColorSubtract=mask*512+amount;surface.drawImage(dim,20,20,8,8);
    surface.nativeColorSubtract=0;surface.drawImage(dim,40,20,8,8);surface.endFrame();runtime.flush();
    assert(near(pixel(runtime.game.renderer,22,22),expected),`034 原背景逐通道减色错误：${pixel(runtime.game.renderer,22,22)}`);
    assert(near(pixel(runtime.game.renderer,42,22),[165,130,66,255]),'背景减色泄露到前景');
  }
  surface.beginFrame();assert(surface.nativeColorSubtract===0,'背景减色没有随帧状态释放');surface.endFrame();
  for(const entry of [...surface.textures.entries])surface.textures.remove(entry);
  record('034 来源背景减色：实际 WebGL 的RGB565逐通道相减、绿通道选择、下限与前景隔离通过');
  const rgba=new Uint8ClampedArray(8*8*4);for(let i=0;i<rgba.length;i+=4){rgba[i]=248;rgba[i+1]=128;rgba[i+2]=64;rgba[i+3]=255;}
  for(let mode=1;mode<=7;mode++){
    const effect=createDeathParticleSurface({rgba,width:8,height:8,anchor:{x:0,y:0},mode,seed:23});effect.step();
    surface.beginFrame();surface.fillStyle='#000';surface.fillRect(0,0,640,480);effect.draw(surface,100,100);surface.endFrame();runtime.flush();
    assert(surface.pools.particle.some(object=>object.visible),'死亡粒子没有使用 GPU 批量对象');
    assert(!surface.textures.entries.size,'死亡粒子仍在创建动态图像纹理');
    assert(near(pixel(runtime.game.renderer,100,100),mode===4?[255,255,130,255]:[255,130,66,255]),`死亡粒子 ${mode} 的颜色／位置错误：${pixel(runtime.game.renderer,100,100)}`);
  }
  record('七类死亡粒子：实际 WebGL 几何、源颜色与零动态图像上传通过');
  const sparse={width:2,height:2,pixels:()=>[{x:0,y:0,rgb:[255,0,0]},{x:1,y:0,rgb:[0,255,0]},{x:0,y:1,rgb:[255,255,0]},{x:1,y:1,rgb:[0,0,255]}]};
  const fractional=()=>{surface.beginFrame();surface.drawImage(sparse,120.25,120.25,4/3,4/3);surface.endFrame();runtime.flush();};
  fractional();assert(near(pixel(runtime.game.renderer,120,120),[255,0,0,255])&&near(pixel(runtime.game.renderer,121,121),[0,0,255,255]),`粒子实例化没有保持小数缩放的像素覆盖：${pixel(runtime.game.renderer,120,120)}；${pixel(runtime.game.renderer,121,121)}`);
  assert(runtime.game.renderer.gl.getError()===0,'实例化绘制污染了 WebGL 状态');
  const strip=document.createElement('canvas');strip.width=8360;strip.height=8;strip.getContext('2d').fillStyle='#a02040';strip.getContext('2d').fillRect(8352,0,8,8);
  surface.beginFrame();surface.drawImage(strip,8352,0,8,8,40,40,8,8);surface.endFrame();runtime.flush();
  assert(near(pixel(runtime.game.renderer,42,42),[160,32,64,255]),'超长图集的帧裁切错误');
  assert([...surface.textures.entries].every(entry=>entry.source.width<=2048),'上传了未分页的超长图集');
  surface.beginFrame();for(const entry of [...surface.textures.entries])surface.textures.remove(entry);surface.endFrame();
  record('粒子小数缩放、GL 状态隔离及 8360 像素图集的按帧裁切通过');
  const white=runtime.transitions.scene.textures.getFrame('__WHITE'),whiteSize=[white.glTexture.width,white.glTexture.height];
  for(const kind of [0,1,2,3,4,5,6,5,6]){
    runtime.setPhase('battle-loading');const held=runtime.battle.clock.time;
    paint([50,90,140],[140,90,50]);const before=runtime.captureTexture('battle');let draws=0,shaderFailure=null,preparing=false,releasePreparation;
    const preparation=new Promise(resolve=>{releasePreparation=resolve;}),count=[16,64,16,16,20,30,20][kind];let firstRows,seed=7;
    const random=kind===5?()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/0x100000000;}:()=>.5;
    const clock={time:0,requestFrame(callback){let stopped=false;requestAnimationFrame(()=>{if(stopped)return;runtime.flush();
      if(draws===0&&preparing)shaderFailure=new Error('资源准备阻塞了转场首帧');
      if(draws===6&&!preparing)shaderFailure=new Error(`转场 ${kind} 播放期间没有开始准备战场`);
      if(draws===0&&kind===1&&!near(pixel(runtime.game.renderer,20,20),[66,98,156,255]))shaderFailure=new Error(`白闪着色器方向／颜色错误：${pixel(runtime.game.renderer,20,20)}`);
      if(kind===5&&draws===0){firstRows=nonBlackRows(runtime.game.renderer,320);
        if(firstRows<=runtime.game.renderer.height*.7||firstRows>=runtime.game.renderer.height)shaderFailure=new Error('逐行消隐首帧没有保留大部分地图或未开始逐行变化');}
      if(kind===5&&draws===6){const rows=nonBlackRows(runtime.game.renderer,320);
        if(rows<=0||rows>=firstRows)shaderFailure=new Error('逐行消隐中间帧没有继续移除地图行');}
      if(kind===6&&draws===0&&(!near(pixel(runtime.game.renderer,20,20),[0,0,0,255])||!near(pixel(runtime.game.renderer,620,20),[50,90,140,255])))shaderFailure=new Error('逐行滑动首帧没有移动地图');
      if(kind===6&&draws===6&&(!near(pixel(runtime.game.renderer,100,20),[0,0,0,255])||!near(pixel(runtime.game.renderer,500,20),[50,90,140,255])))shaderFailure=new Error('逐行滑动中间帧没有继续移动地图');
      if(draws===28){
        if(!preparing||!runtime.transitions.active||runtime.transitions.frame!==(kind===1?31:count-1))shaderFailure=new Error(`转场 ${kind} 没有在慢加载期间推进并等待战场`);
        if(runtime.battle.clock.time!==held)shaderFailure=new Error('资源准备期间战斗时钟提前运行');
        releasePreparation();
      }
      draws++;clock.time+=40;callback(clock.time);});return {cancel(){stopped=true;}};}};
    await runtime.transitions.run(before,async signal=>{preparing=true;await preparation;signal.throwIfAborted();paint([20,40,60],[60,40,20]);return runtime.captureTexture('battle');},{kind,random,clock});
    if(shaderFailure)throw shaderFailure;
    assert(!runtime.transitions.active&&!runtime.snapshots.size,'转场未清理 GPU 快照');
    runtime.flush();assert(near(pixel(runtime.game.renderer,20,20),[20,40,60,255]),`转场 ${kind} 未完整显露战场`);
    assert(draws>0,'转场没有播放逻辑帧');
    assert(white.glTexture.width===whiteSize[0]&&white.glTexture.height===whiteSize[1],'转场清理污染了共享白纹理的尺寸');
  }
  runtime.setPhase('battle-active');
  record('七种 GPU 入战转场：逐行效果首帧／中间帧像素、重复切换、共享纹理保持、慢加载等待、战斗时钟冻结及快照释放通过');
  const menu=document.createElement('div');menu.className='operation-frame';
  menu.style.cssText='position:absolute;left:0;top:0;width:640px;height:480px;transform:none';stage.append(menu);
  const background=document.createElement('canvas');background.width=640;background.height=480;
  background.getContext('2d').fillStyle='rgb(80,32,16)';background.getContext('2d').fillRect(0,0,640,480);
  const menuImage=new Image();menuImage.src=background.toDataURL();await menuImage.decode();menu.append(menuImage);
  const panelGlyph=document.createElement('canvas');panelGlyph.width=8;panelGlyph.height=8;
  panelGlyph.style.cssText='position:absolute;left:100px;top:80px;width:8px;height:8px';
  panelGlyph.getContext('2d').fillStyle='#00ff00';panelGlyph.getContext('2d').fillRect(0,0,8,8);registerGlyph(panelGlyph);menu.append(panelGlyph);
  const menuPlane=document.createElement('canvas');menuPlane.width=40;menuPlane.height=40;
  menuPlane.style.cssText='position:absolute;left:200px;top:100px;width:40px;height:40px';menu.append(menuPlane);
  const menuCommands=drawingContext(menuPlane);menuCommands.fillStyle='#0000ff';menuCommands.fillRect(0,0,40,40);
  const menuStarted=performance.now(),menuBefore=runtime.captureInterface(menu),menuObjects=runtime.transitions.scene.children.length,menuTiming=[];
  menuBefore.redraw();let menuFrames=0,menuPreparing=false,coverCalls=0,menuFailure=null;
  const menuClock={time:0,requestFrame(callback){let stopped=false;requestAnimationFrame(()=>{
    if(stopped)return;runtime.flush();
    if(menuFrames===0){
      if(menuPreparing||!menu.hidden||!near(pixel(runtime.game.renderer,20,20),[96,40,32,255])||
        !near(pixel(runtime.game.renderer,102,82),[16,255,16,255])||!near(pixel(runtime.game.renderer,210,110),[16,8,255,255]))menuFailure=new Error('技巧测试转场没有保留菜单图片、字形与绘制列表');
    }
    menuFrames++;menuClock.time+=250;callback(menuClock.time);
  });return {cancel(){stopped=true;}};}};
  await runtime.transitions.run(menuBefore,()=>{
    menuPreparing=true;if(menuFrames<2)throw new Error('菜单启动的资源准备抢占了首个可见转场帧');
    paint([20,40,60]);return runtime.captureTexture('battle');
  },{kind:1,clock:menuClock,startedAt:menuStarted,log:event=>menuTiming.push(event),onCovered:()=>{coverCalls++;menu.hidden=true;}});
  if(menuFailure)throw menuFailure;
  assert(coverCalls===1&&runtime.transitions.scene.children.length===menuObjects&&!runtime.snapshots.size,'菜单转场没有清理捕获对象或快照');
  const firstFrame=menuTiming.findIndex(event=>event.type==='battle-transition-first-frame'),preparationFrame=menuTiming.findIndex(event=>event.type==='battle-transition-preparation-start');
  assert(firstFrame>=0&&preparationFrame>firstFrame,'资源准备没有等到实际 Phaser 首帧绘制完成');
  menu.remove();runtime.setPhase('battle-active');
  record(`菜单入战：图片、GPU字形与保留绘制列表完整捕获，覆盖后隐藏菜单、首帧后准备及快照释放通过（示意菜单，首帧 ${menuTiming[firstFrame].elapsed_ms.toFixed(1)}ms）`);
  const lifecycleManifest=await (await fetch('/data/battle_lifecycle.json')).json();
  const roster=[{id:'entry-player',resource_id:'001',side:'player'},{id:'entry-enemy',resource_id:'012',side:'enemy'}];
  const entryState={id:'webgl-entry',actors:roster.map(actor=>({...actor,life_epoch:0})),
    lifecycle_events:roster.map(actor=>({actor_id:actor.id,token:actor.id,life_epoch:0,kind:'entry',source_skill_index:11,source_id_raw:11}))};
  const lifecycle=new BattleLifecyclePlayback(lifecycleManifest,{appearanceBounds:()=>({min_x:200,max_y:200,empty:false})});
  runtime.setPhase('battle-loading');const entryTime=runtime.battle.clock.time;
  const paintEntry=()=>{
    paint([20,40,60]);surface.globalAlpha=lifecycle.alpha('entry-player');surface.fillStyle='#ff0000';surface.fillRect(100,280,80,80);
    surface.globalAlpha=lifecycle.alpha('entry-enemy');surface.fillStyle='#00ff00';surface.fillRect(380,280,80,80);surface.globalAlpha=1;surface.endFrame();
  };
  await runtime.transitions.run(runtime.captureTexture('battle'),()=>{paint([20,40,60]);return runtime.captureTexture('battle');},{kind:4});
  runtime.flush();
  assert(near(pixel(runtime.game.renderer,140,300),[20,40,60,255]),'转场底图提前绘制了入场人物');
  assert(runtime.battle.clock.time===entryTime&&!lifecycle.snapshot().active.length,'转场提前启动了战斗时钟或入场动作');
  lifecycle.advance(entryState,roster,entryTime);
  assert(lifecycle.pose('entry-player').source_frame===170&&lifecycle.pose('entry-enemy').source_frame===0,'入场未从各角色第一帧开始');
  for(const elapsed of [120,180])lifecycle.advance(entryState,roster,entryTime+elapsed);
  paintEntry();runtime.flush();
  assert(pixel(runtime.game.renderer,140,300)[0]>20&&pixel(runtime.game.renderer,420,300)[1]>40,'转场后的显形没有绘制');
  runtime.setPhase('battle-active');
  record('入场衔接：转场完成后从各角色第一帧播放，显形按原顺序绘制（示意人物）');
  const cancellation=new AbortController();paint();const before=runtime.captureTexture('battle');
  const interrupted=runtime.transitions.run(before,()=>runtime.captureTexture('battle'),{kind:6,signal:cancellation.signal});cancellation.abort(new Error('验收取消'));
  let cancelled=false;try{await interrupted;}catch(error){cancelled=error.message==='验收取消';}
  assert(cancelled&&!runtime.snapshots.size&&!runtime.transitions.active,'取消转场没有释放 GPU 资源');
  record('转场取消：等待拒绝、覆盖层关闭与 GPU 快照释放通过');
  const loadingCancellation=new AbortController();let preparationStarted=false,releaseLate;
  const loading=runtime.transitions.run(runtime.captureTexture('battle'),()=>{
    preparationStarted=true;return new Promise(resolve=>{releaseLate=resolve;});
  },{kind:1,signal:loadingCancellation.signal});
  await until(()=>preparationStarted,'转场没有开始异步资源准备');
  const late=runtime.captureTexture('battle');loadingCancellation.abort(new Error('准备中取消'));
  let loadingCancelled=false;try{await loading;}catch(error){loadingCancelled=error.message==='准备中取消';}
  releaseLate(late);await frame();
  assert(loadingCancelled&&!runtime.transitions.active&&!runtime.snapshots.size,'取消后的迟到战场重新安装或泄露了快照');
  const preparationFailure=new Error('受控资源准备失败');let failure=null;
  try{await runtime.transitions.run(runtime.captureTexture('battle'),async()=>{throw preparationFailure;},{kind:4});}catch(error){failure=error;}
  assert(failure===preparationFailure&&!runtime.transitions.active&&!runtime.snapshots.size,'资源准备失败后没有恢复并释放转场');
  record('异步资源准备：取消后的迟到快照释放、失败退出与覆盖层清理通过');
  const panel=document.createElement('div');panel.className='dialogue-viewport';panel.style.cssText='position:absolute;inset:0;width:640px;height:480px';
  const plane=document.createElement('canvas');plane.width=640;plane.height=480;plane.style.cssText='position:absolute;inset:0;width:640px;height:480px';panel.append(plane);stage.append(panel);
  let rasterRequests=0;const nativeGetContext=plane.getContext.bind(plane);plane.getContext=(kind,...args)=>{if(kind==='2d')rasterRequests++;return nativeGetContext(kind,...args);};
  const context=drawingContext(plane);context.fillStyle='#123456';context.fillRect(0,0,640,480);
  const glyph=document.createElement('canvas');glyph.width=4;glyph.height=4;glyph.style.cssText='position:absolute;left:100px;top:80px;width:4px;height:4px';
  glyph.getContext('2d').fillStyle='#00ff00';glyph.getContext('2d').fillRect(0,0,4,4);registerGlyph(glyph);panel.append(glyph);
  await until(()=>runtime.ui.visible?.length===2,'共享界面合成器没有收集可见平面');await frame();flush(runtime.ui.game);
  assert(near(pixel(runtime.ui.game.renderer,20,20),[18,52,86,255]),'界面主平面位置／颜色错误');
  assert(near(pixel(runtime.ui.game.renderer,101,81),[0,255,0,255]),'字形纹理没有对齐 DOM 位置');
  assert(rasterRequests===0,'正式界面平面意外取得 Canvas 2D 上下文');
  panel.hidden=true;await until(()=>runtime.ui.canvas.style.display==='none','关闭界面后 GPU 输出没有隐藏');panel.remove();stage.style.position=oldPosition;
  record('共享界面：主平面／缓存字形定位、显隐与独立 WebGL 输出通过');
  const ext=runtime.game.renderer.gl.getExtension('WEBGL_lose_context');
  if(ext){ext.loseContext();await until(()=>runtime.pauseReasons.has('webgl-main'),'上下文丢失没有暂停游戏');const held=runtime.battle.clock.time;
    await frame();await frame();assert(runtime.battle.clock.time===held,'上下文丢失期间战斗仍在推进');ext.restoreContext();
    await until(()=>!runtime.pauseReasons.has('webgl-main'),'WebGL 上下文未恢复');await until(()=>runtime.battle.clock.time>held,'上下文恢复后战斗时钟未恢复');
    fractional();assert(near(pixel(runtime.game.renderer,120,120),[255,0,0,255]),'上下文恢复后自定义粒子管线没有重建');
    record('真实 WebGL 上下文丢失／重建：游戏暂停与恢复通过');}
}
