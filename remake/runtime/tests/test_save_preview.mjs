import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {attachSavePreview,savedPreviewPng,validPreviewPng,SAVE_PREVIEW_WIDTH,SAVE_PREVIEW_HEIGHT} from '../web/core/save_preview.mjs';
import {encodeSave,decodeSave} from '../web/core/world.mjs';
import {drawMapScene} from '../web/map_scene_view.mjs';
import {createServicesController} from '../web/controllers/services.mjs';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGgAAABMCAIAAAAOQ2XWAAAAuUlEQVR4nO3SMREAIAADMUASclCCfDTwc7J3+evc5w7+rbBBuM7jIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhRvMAV4QBnCTMUicAAAAASUVORK5CYII=';
const seed=JSON.parse(readFileSync(new URL('../web/data/world_seed.json',import.meta.url)));

test('save screenshots round trip without changing the v1 world payload or legacy compatibility',async()=>{
  const legacy=await encodeSave(seed),saved=attachSavePreview(legacy,png);
  assert.equal(saved.payload,legacy.payload);assert.equal(saved.sha256,legacy.sha256);
  assert.equal(savedPreviewPng(saved),png);assert.equal(savedPreviewPng(legacy),null);
  assert.deepEqual(await decodeSave(JSON.parse(JSON.stringify(saved))),await decodeSave(legacy));
  assert.equal(SAVE_PREVIEW_WIDTH,104);assert.equal(SAVE_PREVIEW_HEIGHT,76);
});

test('preview rejects foreign URLs, mismatched payloads, overlarge images and wrong dimensions',()=>{
  assert.equal(validPreviewPng(png),true);
  assert.equal(validPreviewPng('https://example.test/preview.png'),false);
  assert.equal(validPreviewPng('data:image/svg+xml;base64,AAAA'),false);
  assert.equal(validPreviewPng(png+'A'.repeat(100_000)),false);
  const bytes=Buffer.from(png.split(',')[1],'base64');bytes.writeUInt32BE(640,16);
  assert.equal(validPreviewPng('data:image/png;base64,'+bytes.toString('base64')),false);
  assert.equal(savedPreviewPng({sha256:'new',preview:{version:1,width:104,height:76,payload_sha256:'old',png}}),null);
});

test('save adapter captures the same snapshot it checksums and does not write browser storage',async()=>{
  let captures=0,snapshots=0;
  const state={scenes:{canSave:()=>true},world:{snapshot:()=>{snapshots++;return structuredClone(seed);}}};
  const services=createServicesController({state,actions:{captureSavePreview:world=>{captures++;assert.deepEqual(world,seed);return png;}}});
  const saved=await services.saveEnvelope();assert.equal(captures,1);assert.equal(snapshots,1);
  assert.equal(savedPreviewPng(saved),png);assert.deepEqual(await decodeSave(saved),await decodeSave(await encodeSave(seed)));
  state.scenes.canSave=()=>false;await assert.rejects(services.saveEnvelope(),/地图探索/);assert.equal(captures,1);
});

test('shared map drawing respects saved flags, object state, depth and facing without mutating the snapshot',()=>{
  const calls=[],image=name=>({name}),ctx={clearRect(){},fillRect(){},save(){},restore(){},translate(){},scale(){},drawImage:(...args)=>calls.push(args)};
  const world={location:{map_id:'M01010',x:20,y:30,direction:3},object_states:{'M01010:2':{visible:false}},flags:[0,1]};
  const resource={frame_width:16,frame_height:24,frames_per_direction:1,anchor_x:8,anchor_y:12};
  const scene={data:{id:'M01010',role_layer_preview:2},bitmap:image('background'),objects:[
    {index:1,layer:3,sort_y:80,draw_x:10,draw_y:10,bitmap:image('foreground')},
    {index:2,layer:1,sort_y:0,draw_x:0,draw_y:0,bitmap:image('hidden-object')}],npcs:[
    {x:10,y:10,direction:0,layer:1,bitmap:image('npc'),resource,event:{conditions:[{index:1,value:1}]}},
    {x:10,y:10,direction:0,bitmap:image('hidden-npc'),resource,event:{conditions:[{index:1,value:0}]}}]};
  const before=structuredClone(world);
  drawMapScene(ctx,{scene,world,role:{frame_width:32,frame_height:48,map_draw_offset:{x:0,y:-24}},action:{bitmap:image('hero')},
    view:{zoom:1,x:20,y:30,frame:0},width:640,height:480,time:0});
  assert.deepEqual(calls.map(call=>call[0].name),['background','npc','hero','foreground']);
  assert.equal(calls[2][2],3*48);assert.deepEqual(world,before);
});
