const assert=(ok,message)=>{if(!ok)throw new Error(message);};
const bitmap=(w,h,paint)=>{const c=document.createElement('canvas');c.width=w;c.height=h;paint?.(c.getContext('2d'));return c;};
const same=(a,b)=>a.length===b.length&&a.every((n,i)=>n===b[i]);

// Source pixels deliberately include single-pixel eyes, seams and diagonal
// hair, cloth, blade and horns. These are synthetic geometry, not original art.
function actor(monster=false){return bitmap(32,48,c=>{
  const row=(y,x,w,color)=>{c.fillStyle=color;c.fillRect(x,y,w,1);};
  for(let y=4;y<19;y++)row(y,9-Math.min(y-4,3),13+Math.min(y-4,3),'#18202c');
  for(let y=8;y<18;y++)row(y,11,10,'#e5bc92');
  row(12,12,2,'#16212c');row(12,18,2,'#16212c');row(16,15,3,'#984957');
  for(let y=3;y<11;y++)row(y,7+Math.floor((y-3)/2),17-Math.floor((y-3)/2),'#633d55');
  for(let y=19;y<38;y++)row(y,11-Math.floor((y-19)/4),10+Math.floor((y-19)/4)*2,monster?'#699f70':'#5883b4');
  for(let y=20;y<38;y++){row(y,15,1,'#c6d1bc');if(y%4===0)row(y,12,2,'#2a4c6c');}
  for(let y=38;y<45;y++){row(y,8,6,'#232e44');row(y,18,6,'#232e44');}
  for(let n=0;n<18;n++){row(28-n,24+Math.floor(n/3),2,'#ecdbad');row(28-n,23+Math.floor(n/3),1,'#5e7081');}
  row(29,22,6,'#ae7941');
  if(monster)for(let n=0;n<8;n++){row(9-n,6-Math.floor(n/2),3,'#caca99');row(9-n,24+Math.floor(n/2),3,'#caca99');}
});}

export async function checkCharacterSmoothing(runtime,record){
  const surface=runtime.battle.surface,renderer=runtime.game.renderer;
  runtime.setPhase('battle-active');runtime.fixedRenderScale=3;runtime.resize();
  assert(runtime.canvas.width===1920&&runtime.canvas.height===1440,'人物平滑没有提高实际绘制分辨率');
  const read=(x,y,w,h)=>{const data=new Uint8Array(w*h*4);renderer.gl.readPixels(x,renderer.height-y-h,w,h,renderer.gl.RGBA,renderer.gl.UNSIGNED_BYTE,data);return data;};
  const human=actor(),monster=actor(true);
  const paint=enabled=>{
    runtime.setActorSmoothing(enabled);surface.beginFrame();surface.fillStyle='#243539';surface.fillRect(0,0,640,480);
    surface.drawActorImage(human,0,0,32,48,40,30,32,48);
    surface.drawActorImage(monster,0,0,32,48,90,30,32,48);
    surface.drawImage(human,140,30);surface.endFrame();runtime.flush();
    return read(0,0,600,270);
  };
  const plain=paint(false),filtered=paint(true);
  const crop=(data,x,w)=>{const pixels=[];for(let y=90;y<234;y++)for(let dx=x;dx<x+w;dx++)for(let c=0;c<4;c++)pixels.push(data[(y*600+dx)*4+c]);return pixels;};
  assert(!same(crop(plain,120,96),crop(filtered,120,96)),'人物 xBR 开关没有改变放大后的轮廓');
  assert(same(crop(plain,420,96),crop(filtered,420,96)),'普通图像被人物平滑开关改变');
  // Pixel centres keep the source face details while diagonal boundaries change.
  const eye=read(40*3+12*3+1,30*3+12*3+1,1,1);
  assert(eye[0]<45&&eye[1]<55&&eye[2]<65,'xBR 抹掉了示意图的眼睛像素');
  const uploads=surface.textures.snapshot().uploads;for(let i=0;i<20;i++)paint(true);
  assert(surface.textures.snapshot().uploads===uploads,'人物平滑每帧重新上传了纹理');
  record('人物 xBR：3 倍真实输出、开关生效、非人物不变、眼睛细节及稳定帧零纹理上传通过');

  // Keep A/B images from the actual WebGL framebuffer for visual inspection.
  document.querySelector('#xbrComparison')?.remove();
  const panel=document.createElement('section');panel.id='xbrComparison';
  panel.innerHTML='<h2>人物平滑对比（示意素材）</h2><p>左：原像素；右：xBR。上：人物；下：怪物。均来自实际 WebGL 输出。</p>';
  const grid=document.createElement('div');grid.style.cssText='display:grid;grid-template-columns:repeat(2,144px);gap:16px';
  for(const image of [human,monster])for(const enabled of [false,true]){
    runtime.setActorSmoothing(enabled);surface.beginFrame();surface.fillStyle='#243539';surface.fillRect(0,0,640,480);
    surface.drawActorImage(image,0,0,32,48,40,30,32,48);surface.endFrame();runtime.flush();
    const capture=bitmap(144,216,c=>{c.imageSmoothingEnabled=false;c.drawImage(runtime.canvas,40*3,30*3,32*3,48*3,0,0,144,216);});capture.style.imageRendering='pixelated';grid.append(capture);
  }
  panel.append(grid);document.querySelector('#result').after(panel);

  // Neighbouring map atlas frames contain strong red; none may leak into green.
  const atlas=bitmap(64,48,c=>{c.fillStyle='#ff0000';c.fillRect(32,0,32,48);for(let y=0;y<48;y++){c.fillStyle='#00ff00';c.fillRect(31-y%12,y,1+y%12,1);}});
  const f=surface.textures.region(atlas,0,0,32,48),sprite=runtime.battle.add.sprite(200,50,f.key,f.frame).setOrigin(0);sprite.smoothActor=true;
  runtime.flush();const isolated=read(200*3,50*3,96,144);
  for(let i=0;i<isolated.length;i+=4)assert(isolated[i]<=36,'xBR 读取了地图相邻动画帧');sprite.destroy();

  // Split a character across two atlas pages. The result must equal the same
  // single bitmap, including fractional scaling and viewport clipping.
  const page0=bitmap(18,48,c=>c.drawImage(human,0,0,16,48,1,0,16,48));
  const page1=bitmap(18,48,c=>c.drawImage(human,16,0,16,48,1,0,16,48));
  const packed={packed:true,width:32,height:48,regions:[[0,0,16,48,0,1,0],[16,0,16,48,1,1,0]],pool:{pages:new Map([[0,{bitmap:page0}],[1,{bitmap:page1}]])}};
  const draw=source=>{surface.beginFrame();surface.drawActorImage(source,0,0,32,48,-4,40,48,72);surface.endFrame();runtime.flush();return read(0,120,144,216);};
  assert(same(draw(human),draw(packed)),'xBR 在战斗图集分块／裁切处产生接缝');
  const mark=surface.pools.sprite[0];assert(mark.smoothActor,'战斗角色主体没有标记');
  surface.beginFrame();surface.drawImage(human,0,0);surface.endFrame();assert(!surface.pools.sprite[0].smoothActor,'对象池把人物平滑传给了普通特效');
  record('图集边界：地图相邻帧隔离、战斗跨页拼接、小数缩放／裁切与对象池标记清理通过');

  const map={data:{id:'xbr-check'},bitmap:bitmap(640,480,c=>{c.fillStyle='#243539';c.fillRect(0,0,640,480);}),
    movement:{width:1,height:1},objects:[{index:0,bitmap:human,draw_x:100,draw_y:80}],
    npcs:[{id:'npc',x:160,y:100,direction:0,bitmap:human,
      resource:{frame_width:32,frame_height:48,frames_per_direction:1,anchor_x:16,anchor_y:44}}]};
  const options={scene:map,world:{location:{x:200,y:120,direction:0},object_states:{},flags:[]},
    role:{frame_width:32,frame_height:48,anchor:{x:16,y:44}},action:{bitmap:human},
    view:{x:320,y:240,zoom:1,frame:0},openingQueue:null,time:0};
  runtime.setPhase('map');runtime.presentMap(options);runtime.flush();
  const actors=runtime.exploration.actors;
  assert(actors.get('leader').pose.body.smoothActor&&actors.get('npc:npc').pose.body.smoothActor,'地图主角或 NPC 没有启用人物平滑');
  assert(!actors.get('object:0').pose.body.smoothActor&&!actors.get('leader').pose.light.smoothActor,'地图物件或加色层被误标为人物');
  Object.assign(options.view,{x:380,y:260,zoom:.75});runtime.presentMap(options);runtime.flush();
  const camera=runtime.exploration.cameras.main,centre=camera.getWorldPoint(960,720);
  assert(Math.abs(centre.x-380)<.01&&Math.abs(centre.y-260)<.01,'高分辨率探索相机改变了逻辑中心');
  runtime.fixedRenderScale=2;runtime.resize();runtime.flush();const resized=camera.getWorldPoint(640,480);
  assert(Math.abs(resized.x-380)<.01&&Math.abs(resized.y-260)<.01,'分辨率切换移动了探索视野');
  runtime.fixedRenderScale=3;runtime.resize();runtime.exploration.clearActors();runtime.setPhase('battle-active');
  record('正式地图显示入口：主角／NPC 分类、物件／加色层排除、小数缩放及分辨率切换后的相机中心通过');

  surface.beginFrame();surface.fillStyle='#124c7a';surface.fillRect(0,0,640,480);surface.endFrame();
  const shot=runtime.captureTexture('battle');assert(runtime.game.textures.get(shot.key).source[0].width===1920,'高分辨率快照被压回低分辨率');
  const snapshotImage=runtime.battle.add.image(0,0,shot.key).setOrigin(0).setDisplaySize(640,480).setDepth(999);
  runtime.flush();assert(same([...read(900,600,1,1)],[18,76,122,255]),'高分辨率快照的相机／显示尺寸错误');
  snapshotImage.destroy();shot.destroy();
  surface.beginFrame();for(const entry of [...surface.textures.entries])surface.textures.remove(entry);surface.endFrame();
  assert(surface.textures.actorOwners.size===0,'人物帧的 CPU 缓存未随 GPU 纹理释放');
  runtime.fixedRenderScale=1;runtime.resize();runtime.setActorSmoothing(false);
  assert(runtime.battle.cameras.main.zoom===1&&runtime.battle.cameras.main.scrollX===0,'分辨率恢复改变了战斗逻辑相机');
  runtime.fixedRenderScale=3;runtime.resize();
  record('绘制分辨率切换：640×480 逻辑坐标、高分辨率快照与纹理清理通过');
}
