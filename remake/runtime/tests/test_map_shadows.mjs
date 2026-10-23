import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {mapPresentation} from '../web/core/map_presentation.mjs';
import {drawMapScene} from '../web/map_scene_view.mjs';
import {MapActor} from '../web/phaser/actors/map_actor.mjs';
import {ImageResources} from '../web/core/image_resources.mjs';
import {drawMapSprite,shadowRectangle} from '../web/map_sprite.mjs';
registerHooks({resolve(specifier,context,next){
  if(specifier==='/prototype/movement.mjs')return {url:new URL('../../prototype/web/movement.mjs',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {OpeningView}=await import('../web/opening_view.mjs');
const root=new URL('../',import.meta.url),read=async path=>JSON.parse(await readFile(new URL(path,root),'utf8'));
const manifest=await read('web/data/map_shadows.json');
const image=name=>({name,width:160,height:160});

test('export independently verifies all selected source mask frames and leaves original rasters intact',async()=>{
  const report=await read('evidence/movement_optimization_20261023/shadow_export.json');
  assert.equal(report.passed,true);assert.equal(report.independent_source_mask_replay,true);
  assert.equal(report.source_bytes_unchanged,true);assert.equal(report.main_and_light_pngs_unchanged,true);
  assert.equal(report.compact_atlas_reconstruction_verified,true);
  assert.ok(report.compact_atlas_rgba_bytes<100*1048576);
  assert.ok(report.compact_atlas_rgba_bytes<report.full_frame_rgba_bytes*.15);
  assert.equal(report.frame_checks.length,7079);
  assert.deepEqual(['001','002','003','070'].map(id=>Boolean(manifest.roles[id])),[true,true,true,true]);
  assert.equal(manifest.roles['070'].event_only,true);
  assert.equal(manifest.alpha,128);
  for(const [path,hash] of Object.entries(report.output_hashes))
    assert.equal(createHash('sha256').update(await readFile(new URL('web'+path,root))).digest('hex'),hash,path);
  for(const [path,hash] of Object.entries(report.main_and_light_png_hashes))
    assert.equal(createHash('sha256').update(await readFile(new URL('../../../'+path,import.meta.url))).digest('hex'),hash,path);
});

function fixture(){
  const role={frame_width:160,frame_height:160,anchor:{x:80,y:111},actions:[]};
  const action={index:1,bitmap:image('leader'),shadow_bitmap:image('leader-shadow')};
  const npcAction={index:0,bitmap:image('npc'),intrinsic_bitmap:image('light'),shadow_bitmap:image('npc-shadow')};
  const npc={id:'npc',x:120,y:180,direction:6,motion:{role:{...role,actions:[npcAction]},action:0,frame:3}};
  const scene={data:{id:'M01010',role_layer_preview:2},bitmap:image('map'),objects:[
    {index:0,bitmap:image('foreground'),layer:2,sort_y:500,draw_x:0,draw_y:0}],npcs:[npc]};
  const world={location:{x:100,y:150,direction:2},object_states:{},flags:[]};
  return {scene,world,role,action,view:{frame:4,zoom:1,x:320,y:240}};
}

function drawing(){
  const calls=[],stack=[],ctx={globalCompositeOperation:'source-over',
    clearRect(){},fillRect(){},translate(){},scale(){},
    save(){stack.push(this.globalCompositeOperation);},restore(){this.globalCompositeOperation=stack.pop();},
    drawImage(...args){calls.push({args,blend:this.globalCompositeOperation});}};
  return {ctx,calls};
}

test('leader, ordinary NPC and read-only preview use the same source frame, anchor and actor depth',()=>{
  const options=fixture(),before=structuredClone(options.world),queue=mapPresentation({...options,time:0});
  assert.deepEqual(queue.map(row=>row.key),['leader','npc:npc','object:0']);
  assert.equal(queue[0].pose.shadow,options.action.shadow_bitmap);
  assert.deepEqual([queue[0].pose.x,queue[0].pose.y],[36,39]); // anchor fallback for chapter roles
  const {ctx,calls}=drawing();drawMapScene(ctx,{...options,width:640,height:480,time:0});
  assert.deepEqual(calls.map(row=>[row.args[0].name,row.blend]),[
    ['map','source-over'],['leader-shadow','source-over'],['leader','source-over'],
    ['npc-shadow','source-over'],['npc','source-over'],['light','lighter'],['foreground','source-over']]);
  assert.deepEqual(calls[1].args.slice(1),calls[2].args.slice(1));
  assert.deepEqual(calls[3].args.slice(1),calls[4].args.slice(1));
  assert.deepEqual(calls[4].args.slice(1),calls[5].args.slice(1));
  assert.equal(calls[1].args[1],4*160);assert.equal(calls[3].args[2],6*160);
  Object.assign(options.scene.npcs[0].motion,{x:118.5,y:178.25,direction:4});
  const displayed=mapPresentation(options).find(row=>row.key==='npc:npc');
  assert.equal(displayed.sort_y,210.25);assert.equal(displayed.pose.sy,4*160);
  assert.deepEqual([displayed.pose.x,displayed.pose.y],[54.5,67.25]);
  assert.equal(displayed.pose.shadow,options.scene.npcs[0].motion.role.actions[0].shadow_bitmap);
  assert.deepEqual(options.world,before);
  options.scene.npcs[0].hidden=true;assert.equal(mapPresentation(options).length,2);
});

test('event NPC shadow uses its separate source atlas and ANM emits the same mask before main/light',()=>{
  const options=fixture(),{ctx,calls}=drawing(),resource={frame_width:160,frame_height:160,anchor_x:80,anchor_y:111,frames_per_direction:10};
  options.scene.npcs=[{id:'event',bitmap:image('event'),shadow_bitmap:image('event-shadow'),resource,x:120,y:180,direction:1}];
  assert.equal(mapPresentation({...options,time:0}).find(row=>row.key==='npc:event').pose.shadow.name,'event-shadow');
  const role={...options.role,actions:[{index:1,bitmap:image('actor'),shadow_bitmap:image('mask'),intrinsic_bitmap:image('glow')}]};
  const queue=OpeningView.prototype.drawQueue.call({actors:new Map([[1,{visible:true,alpha:.6,role,action:1,frame:7,direction:4,x:10,y:20}]])});
  queue[0].draw(ctx);
  assert.equal(queue[0].pose.shadow.name,'mask');
  assert.deepEqual(calls.map(row=>[row.args[0].name,row.blend]),[['mask','source-over'],['actor','source-over'],['glow','lighter']]);
  assert.deepEqual(calls[0].args.slice(1),calls[1].args.slice(1));
  assert.deepEqual(calls[1].args.slice(1),calls[2].args.slice(1));
});

test('Phaser keeps mask below the body in the same container and hides it when a pose has no mask',()=>{
  const sprites=[],containers=[],regions=[];
  const scene={add:{sprite(){const sprite={};
    for(const method of ['setOrigin','setPosition','setBlendMode','setTexture','setDisplaySize','setVisible'])sprite[method]=function(...args){this[method.slice(3)]=args;return this;};
    sprites.push(sprite);return sprite;},container(){const container={add(children){this.children=children;}};
    for(const method of ['setPosition','setDepth','setAlpha','setVisible'])container[method]=function(...args){this[method.slice(3)]=args;return this;};
    containers.push(container);return container;}}};
  const textures={region(...args){regions.push(args);return {key:args[0].name,frame:'source'};}};
  const actor=new MapActor(scene,textures,'leader'),entry=mapPresentation(fixture())[0];
  actor.sync({...entry,alpha:.75},9);
  assert.deepEqual(containers[0].children,[actor.pose.shadow,actor.pose.body,actor.pose.light]);
  assert.deepEqual(containers[0].Depth,[9]);assert.deepEqual(containers[0].Alpha,[.75]);
  assert.deepEqual(actor.pose.shadow.Visible,[true]);assert.deepEqual(actor.pose.shadow.Texture,['leader-shadow','source']);
  assert.deepEqual(regions[0].slice(1),regions[1].slice(1));
  actor.pose.apply({...entry.pose,sx:7*160,sy:6*160,displayWidth:320,displayHeight:80,
    shadow_geometry:{x:50,y:100,width:30,height:16}});
  assert.deepEqual(regions.at(-2).slice(1),[210,96,30,16]);
  assert.deepEqual(actor.pose.shadow.Position,[100,50]);
  assert.deepEqual(actor.pose.shadow.DisplaySize,[60,8]);
  actor.sync({...entry,blend:'lighter',pose:{...entry.pose,shadow:null}},9);
  assert.deepEqual(actor.pose.shadow.Visible,[false]);assert.deepEqual(actor.pose.body.BlendMode,['ADD']);
  assert.equal(actor.pose.shadow.BlendMode,undefined);
});

test('compact shadow source selection restores nonzero frame offset for Canvas, ANM and map poses',()=>{
  const geometry={x:50,y:100,width:30,height:16},options=fixture(),{ctx,calls}=drawing();
  options.action.shadow_geometry=geometry;
  const pose=mapPresentation(options)[0].pose;
  assert.equal(pose.shadow_geometry,geometry);
  assert.deepEqual(shadowRectangle(7*160,6*160,160,160,geometry,2,.5),
    {sx:210,sy:96,width:30,height:16,x:100,y:50,displayWidth:60,displayHeight:8});
  drawMapSprite(ctx,image('main'),image('light'),7*160,6*160,160,160,36,39,image('mask'),geometry);
  assert.deepEqual(calls[0].args.slice(1),[210,96,30,16,86,139,30,16]);
  assert.deepEqual(calls[1].args.slice(1),[1120,960,160,160,36,39,160,160]);
  assert.deepEqual(calls[1].args.slice(1),calls[2].args.slice(1));
  const role={...options.role,actions:[{...options.action,index:1}]};
  const queue=OpeningView.prototype.drawQueue.call({actors:new Map([[1,{visible:true,alpha:1,role,action:1,frame:7,direction:6,x:100,y:150}]])});
  calls.length=0;queue[0].draw(ctx);
  assert.equal(queue[0].pose.shadow_geometry,geometry);
  assert.deepEqual(calls[0].args.slice(1),[210,96,30,16,86,139,30,16]);
});

test('shadow resource attachments obey the existing scene scope release contract',async()=>{
  const images=[],resources=new ImageResources({createImage:()=>{const image={};images.push(image);return image;}});
  const action={bitmap:image('body')},loading=resources.attach(action,'mask.png','role:001','shadow_bitmap');
  resources.retainScopes([]);images[0].onload();await loading;
  assert.equal(action.shadow_bitmap,undefined);assert.equal(action.bitmap.name,'body');
  const current=resources.attach(action,'mask.png','role:001','shadow_bitmap');images[1].onload();await current;
  assert.equal(action.shadow_bitmap,images[1]);assert.equal(action.bitmap.name,'body');
});
