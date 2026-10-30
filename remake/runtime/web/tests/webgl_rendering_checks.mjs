import {drawingContext,registerGlyph} from '../phaser/rendering/recorded_surface.mjs';
import {createDeathParticleSurface} from '../death_particles.mjs';
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
const pixel=(renderer,x,y)=>{const data=new Uint8Array(4);renderer.gl.readPixels(x,renderer.height-1-y,1,1,renderer.gl.RGBA,renderer.gl.UNSIGNED_BYTE,data);return [...data];};
const near=(actual,expected)=>actual.every((value,index)=>Math.abs(value-expected[index])<=1);
const flush=game=>{const r=game.renderer;r.preRender();game.scene.render(r);r.postRender();};
async function until(test,message){for(let count=0;!test();count++){assert(count<180,message);await frame();}}

export async function checkWebglRendering(runtime,record){
  const stage=runtime.parent,oldPosition=stage.style.position;stage.style.position='relative';
  runtime.setPhase('battle-active');const surface=runtime.battle.surface;
  const paint=(top=[50,90,140],bottom=top)=>{surface.beginFrame();surface.fillStyle=`rgb(${top})`;surface.fillRect(0,0,640,240);surface.fillStyle=`rgb(${bottom})`;surface.fillRect(0,240,640,240);surface.endFrame();};
  paint();runtime.flush();assert(near(pixel(runtime.game.renderer,20,20),[50,90,140,255]),'WebGL 基础颜色错误');
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
  for(let kind=0;kind<7;kind++){
    paint([50,90,140],[140,90,50]);const before=runtime.captureTexture('battle');let draws=0,shaderFailure=null;
    const clock={time:0,requestFrame(callback){let stopped=false;requestAnimationFrame(()=>{if(stopped)return;runtime.flush();
      if(draws===0&&kind===1&&!near(pixel(runtime.game.renderer,20,20),[66,98,156,255]))shaderFailure=new Error(`白闪着色器方向／颜色错误：${pixel(runtime.game.renderer,20,20)}`);
      draws++;clock.time+=250;callback(clock.time);});return {cancel(){stopped=true;}};}};
    await runtime.transitions.run(before,()=>{paint([20,40,60],[60,40,20]);return runtime.captureTexture('battle');},{kind,random:()=>.5,clock});
    if(shaderFailure)throw shaderFailure;
    assert(!runtime.transitions.active&&!runtime.snapshots.size,'转场未清理 GPU 快照');
    runtime.flush();assert(near(pixel(runtime.game.renderer,20,20),[20,40,60,255]),`转场 ${kind} 未完整显露战场`);
    assert(draws>0,'转场没有播放逻辑帧');
  }
  record('七种 GPU 入战转场：白闪颜色／纹理方向、结束画面及快照释放通过');
  const cancellation=new AbortController();paint();const before=runtime.captureTexture('battle');
  const interrupted=runtime.transitions.run(before,()=>runtime.captureTexture('battle'),{kind:6,signal:cancellation.signal});cancellation.abort(new Error('验收取消'));
  let cancelled=false;try{await interrupted;}catch(error){cancelled=error.message==='验收取消';}
  assert(cancelled&&!runtime.snapshots.size&&!runtime.transitions.active,'取消转场没有释放 GPU 资源');
  record('转场取消：等待拒绝、覆盖层关闭与 GPU 快照释放通过');
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
