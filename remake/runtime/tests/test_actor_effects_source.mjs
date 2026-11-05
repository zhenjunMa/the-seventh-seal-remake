// Original ANM bytes through the actual actor renderer hooks. The retained
// wrapper instructions independently establish draw count/coefficient/offset;
// GPU ADD and alpha are adapters, not an RGB565 framebuffer comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {OpeningView} from '../web/opening_view.mjs';
import {AnmActions} from '../web/core/story/anm_runtime.mjs';
import {ActionClock} from '../web/phaser/components/action_clock.mjs';
import {validateChapterAnimation} from '../web/core/story/chapter_animation.mjs';
import {inspectContentReadiness} from '../web/core/content/content_readiness.mjs';
import {runtimeContent} from '../web/core/content/content_registry.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
import {readContentDefinition} from '../tools/resolve_content_definition.mjs';

const root=new URL('../../../',import.meta.url),read=path=>readFile(new URL(path,root));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const story=JSON.parse(await read('remake/runtime/web/data/chapter_story.json'));
const {content:sourceContent}=await readContentDefinition();
const proof=JSON.parse(await read('remake/runtime/tests/fixtures/anm_actor_blend_native.json'));
class BlendOracle extends NativeAssemblyOracle{
  constructor(entry,assembly){super({[entry]:Array.isArray(assembly)?assembly:assembly.trim().split(/\r?\n/)},[],()=>assert.fail('no RNG in blend wrappers'));this.draws=[];}
  external(target){
    assert.ok([0x53f9d0,0x54421c].includes(target));
    this.draws.push({target,coefficient:this.read(this.reg.ESP+0x104)&255,y:this.read(this.reg.ESP+0xf4)});
  }
}
function fixture(slot,{clock=null}={}){
  const role={frame_width:1,frame_height:1,anchor:{x:0,y:0},actions:[{index:0,frame_count:1,directions:8,bitmap:{name:'source-body'}}]};
  const view=new OpeningView({resources:{roles:{}},prepared:new Map(),install(){},camera(){},clock});
  const actor={x:80,y:120,role,direction:0,action:0,frame:0,visible:false,alpha:1};view.actors.set(slot,actor);
  return {view,actor};
}

test('ANM49 renderer matches every native coefficient, body offset and completion of55259B/552437/5524E2',async()=>{
  assert.equal(hash(await read('GAME.exe')),proof.game_sha256);
  for(const [state,row]of Object.entries(proof.functions)){
    const oracle=new BlendOracle(row.entry,row.assembly),native=[];
    for(let tick=0;;tick++){
      const {eax}=oracle.run(Number(row.entry),[0x30000000,40,60,10,12,0,tick]);native.push(oracle.draws.at(-1));
      if(!eax)break;
    }
    assert.equal(native.length,Number(state)===7?40:8);
    const {view,actor}=fixture(10),frames=[];
    view.tween=async(duration,update)=>{
      assert.equal(duration,native.length*20);
      for(let tick=0;tick<native.length;tick++){
        update(tick/native.length);const draw=view.drawQueue()[0],calls=[];
        draw.draw({save(){},restore(){},drawImage(bitmap,...coordinates){calls.push({bitmap,coordinates,blend:this.globalCompositeOperation});}});
        frames.push({alpha:draw.alpha,offsetY:draw.pose.body_offset.y,blend:draw.blend});
        assert.equal(calls[0].coordinates[5],120+draw.pose.body_offset.y);
        assert.equal(calls[0].blend,draw.blend);
      }
    };
    await view.hooks().actor({kind:'facing',nativeStateRaw:Number(state),actor:10});
    assert.deepEqual(frames,native.map(draw=>({alpha:(255-draw.coefficient)/255,offsetY:(draw.y-60)*2,
      blend:draw.target===0x53f9d0?'lighter':'source-over'})));
    assert.equal(actor.visible,true);assert.equal(actor.alpha,1);assert.equal(actor.y,120);assert.equal(actor.blendEffect,null);
    assert.equal(view.drawQueue()[0].pose.body_offset.y,0);view.dispose();
  }
});

test('elf ANM41 state10 matches555CAD alpha, unclamped rise offset, final draw and hide completion',async()=>{
  const proof=JSON.parse(await read('remake/runtime/tests/fixtures/guild_actor_fade_native.json'));
  assert.equal(hash(await read('GAME.exe')),proof.game_sha256);
  const oracle=new BlendOracle(proof.entry,proof.assembly),native=[];
  for(let tick=0;;tick++){
    const {eax}=oracle.run(Number(proof.entry),[0x30000000,40,60,10,12,0,tick]);native.push(oracle.draws.at(-1));
    if(!eax)break;
  }
  assert.equal(native.length,9);assert.equal(native.at(-1).coefficient,240);assert.equal(native.at(-1).y,60-66);
  const {view,actor}=fixture(11),frames=[];
  view.tween=async(duration,update)=>{
    assert.equal(duration,180);
    for(let tick=0;tick<native.length;tick++){
      update(tick/native.length);const draw=view.drawQueue()[0];frames.push({alpha:draw.alpha,offsetY:draw.pose.body_offset.y,blend:draw.blend});
    }
  };
  await view.hooks().actor({kind:'behavior',nativeStateRaw:10,actor:11});
  assert.deepEqual(frames,native.map(draw=>({alpha:(255-draw.coefficient)/255,offsetY:(draw.y-60)*2,blend:'source-over'})));
  assert.equal(actor.visible,false);assert.equal(actor.alpha,1);assert.equal(actor.blendEffect,null);assert.equal(actor.y,120);view.dispose();
});

test('seal ANM41 state9 matches555C02 on all40 draws and fades in place before hiding',async()=>{
  const proof=JSON.parse(await read('remake/runtime/tests/fixtures/seal_actor_pixels_native.json'));
  assert.equal(hash(await read('GAME.exe')),proof.game_sha256);
  const row=proof.functions.fade,oracle=new BlendOracle(row.entry,row.assembly),native=[];
  for(let tick=0;;tick++){
    const {eax}=oracle.run(Number(row.entry),[0x30000000,40,60,10,12,0,tick]);native.push(oracle.draws.at(-1));
    if(!eax)break;
  }
  assert.equal(native.length,40);assert.equal(native.at(-1).coefficient,240);
  const {view,actor}=fixture(11),frames=[];
  view.tween=async(duration,update)=>{
    assert.equal(duration,800);
    for(let tick=0;tick<native.length;tick++){
      update(tick/native.length);const draw=view.drawQueue()[0];frames.push({alpha:draw.alpha,offsetY:draw.pose.body_offset.y});
    }
  };
  await view.hooks().actor({kind:'behavior',nativeStateRaw:9,actor:11});
  assert.deepEqual(frames,native.map(draw=>({alpha:(255-draw.coefficient)/255,offsetY:(draw.y-60)*2})));
  assert.equal(actor.visible,false);assert.equal(actor.alpha,1);assert.equal(actor.y,120);view.dispose();
});

test('source DAT draw dimensions and55430A instructions use DGP pixels rather than doubled map coordinates',async()=>{
  for(const [mapId,slot,roleId,expected]of [['JUDGELIGH-S01',10,'199',[123,142]],['M03011',11,'053',[193,171]],['M72065',11,'208',[710,561]]]){
    const table=story.maps[mapId],npc=table.npc_records.find(row=>row.slot_zero_based===slot),dat=await read(table.map_source.path);
    assert.equal(hash(dat),table.map_source.sha256);assert.equal(dat.subarray(npc.offset,npc.offset+0x4c5).toString('hex'),npc.raw_hex);
    const role=await read(`ROLE/${roleId}.dgp`),geometry=0x43+role[2]*(role[0]===9?0xac:0x90);
    const dimensions=[role.readUInt16LE(geometry),role.readUInt16LE(geometry+2)];assert.deepEqual(dimensions,expected);
    assert.deepEqual([dat.readUInt32LE(npc.offset+0xac),dat.readUInt32LE(npc.offset+0xb0)],dimensions);
  }
  const evidence=JSON.parse(await read('remake/runtime/evidence/seal_assessment_20261104/actor_pixel_native.json'));
  const dispatcher=evidence.records.flatMap(row=>row.normalized_result?.items??[]).find(row=>row.address==='0x4ac1b0').pseudocode;
  const call=dispatcher.indexOf('local_2c = FUN_00555d65'),argumentsBeforeCall=dispatcher.slice(call-1300,call);
  assert.match(argumentsBeforeCall,/0xac \+ local_c \* 0x4c5/);assert.match(argumentsBeforeCall,/0xb0 \+ local_c \* 0x4c5/);
  const proof=JSON.parse(await read('remake/runtime/tests/fixtures/seal_actor_pixels_native.json')),row=proof.functions.rise;
  assert.equal(hash(await read('GAME.exe')),proof.game_sha256);
  const oracle=new NativeAssemblyOracle({rise:row.assembly.split('\n')},[],()=>assert.fail('no RNG in rising light'));
  const dgp=0x30000000,pixel=0x31000000;
  oracle.write(0x5659104,1);oracle.write(dgp+0x4b,1);oracle.write(dgp+0xc9,1);oracle.write(dgp+0xdd,pixel);
  oracle.write(0x56590fc,0x32000000);oracle.write(0x5659108,1280);oracle.write(0x67c3a0,640,2);oracle.write(0x67c3a2,480,2);
  oracle.write(pixel,123);oracle.write(pixel+4,142);oracle.write(pixel+8,123);oracle.write(pixel+12,142);oracle.write(pixel+0x19,28);
  const result=oracle.run(Number(row.entry),[dgp,320,240,123,142,0,1]);
  assert.equal(result.eax,1);assert.equal(oracle.read(pixel+4),137);assert.equal(oracle.read(pixel+12),142,'source body remains at the original pixel');
});

test('seal source commands use the actual pixel queue and pausable clock for scan reveal, rising trail and stationary fade',async()=>{
  const previous=globalThis.document,pixels=new Uint8ClampedArray(4*5*4);
  pixels.set([255,255,255,255],4);pixels.set([82,121,165,255],(4*4+2)*4);
  globalThis.document={createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:pixels})})})};
  try{
    for(const [id,index]of [['judgeligh-s01',2],['judgeligh-s01',8],['m03011',12],['m72065',51]]){
      const program=story.programs[id],command=program.commands[index],source=await read(program.source.path);
      validateChapterAnimation(program,sourceContent);assert.equal(hash(source),program.source.sha256);
      assert.equal(source.subarray(command.source.offset,command.source.offset+74).toString('hex'),command.raw_hex);
      const clock=new ActionClock();clock.update(0);
      const {view,actor}=fixture(command.u32_plus5,{clock});Object.assign(actor.role,{frame_width:4,frame_height:5});
      const actions=new AnmActions({hooks:view.hooks(),context:()=>({mapId:program.expected.control_map}),positions:new Map()});
      await actions.execute(command);let complete=false;const done=actions.flush().then(()=>{complete=true;});
      assert.equal(actor.visible,true);const first=structuredClone(view.drawQueue().map(row=>({blend:row.blend,pixels:row.pose.image.pixels?.(),offset:row.pose.body_offset,alpha:row.alpha})));
      clock.paused=true;clock.advance(2000);await Promise.resolve();
      assert.deepEqual(view.drawQueue().map(row=>({blend:row.blend,pixels:row.pose.image.pixels?.(),offset:row.pose.body_offset,alpha:row.alpha})),first);assert.equal(complete,false);
      clock.paused=false;clock.advance(20);await Promise.resolve();
      if(command.opcode===49){
        assert.equal(actor.effect.ticks,33);assert.equal(first[0].pixels[0].alpha,1/255);
        assert.deepEqual(actor.effect.visible.map(point=>point.alpha),[9/255,5/255]);
        clock.advance(620);assert.equal(actor.effect.visible[1].alpha,253/255);assert.equal(complete,false);
        clock.advance(20);
      }else if(command.byte_plus29===3){
        assert.deepEqual(first.map(row=>row.blend),['source-over','lighter']);
        assert.deepEqual(actor.effect.sourceImage.pixels()[0],{x:1,y:280,rgb:[255,255,255],alpha:1});
        assert.deepEqual(actor.effect.visible[0],{x:1,y:275,rgb:[239,247,239],alpha:1});
        clock.advance(540);assert.equal(actor.effect.visible.length,0);assert.equal(actor.effect.sourceImage.pixels().length,0);assert.equal(complete,false);
        clock.advance(20);
      }else{
        assert.equal(first[0].alpha,245/255);assert.equal(actor.alpha,239/255);assert.equal(actor.blendEffect.offsetY,0);
        clock.advance(780);
      }
      await done;assert.equal(complete,true);assert.equal(actor.visible,command.opcode===49);assert.equal(actor.alpha,1);assert.equal(actor.effect??null,null);assert.equal(clock.tasks.size,0);
      actions.dispose();view.dispose();clock.destroy();
    }
  }finally{globalThis.document=previous;}
});

test('every registered source ANM41/49 command reaches its real renderer and retains show/hide semantics',async()=>{
  // Pixel extraction is a one-pixel fixture; particle displacement is covered
  // by its existing source tests. This regression exercises the actual hook,
  // including construction of the real particle renderer, instead of no-ops.
  const previous=globalThis.document;
  globalThis.document={createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:Uint8ClampedArray.from([80,120,160,255])})})})};
  const visited=[];
  try{
    for(const program of Object.values(story.programs)){
      if(!sourceContent.programs[program.id])continue;
      const commands=program.commands.filter(command=>[41,49].includes(command.opcode));if(!commands.length)continue;
      const bytes=await read(program.source.path);assert.equal(hash(bytes),program.source.sha256);validateChapterAnimation(program,sourceContent);
      for(const command of commands){
        assert.equal(bytes.subarray(67+command.index*74,67+(command.index+1)*74).toString('hex'),command.raw_hex);
        const {view,actor}=fixture(command.u32_plus5),draws=[];
        view.tween=async(_duration,update)=>{for(const progress of [0,.25,.5,.75,1]){
          update(progress);const row=view.drawQueue()[0];assert.ok(row);row.draw({save(){},restore(){},drawImage(image){draws.push(image);}});
        }};
        const actions=new AnmActions({hooks:{...view.hooks(),wait:async()=>{}},context:()=>({mapId:program.expected.control_map}),positions:new Map()});
        await actions.execute(command);await actions.flush();
        assert.ok(draws.length>0);assert.equal(actor.visible,command.opcode===49);assert.equal(actor.alpha,1);
        visited.push([program.id,command.index,command.opcode,command.byte_plus29+1]);actions.dispose();view.dispose();
      }
    }
  }finally{globalThis.document=previous;}
  assert.equal(visited.length,103);
  assert.deepEqual([...new Set(visited.filter(row=>row[2]===49).map(row=>row[3]))].sort((a,b)=>a-b),[1,2,5,7,8]);
  assert.deepEqual([...new Set(visited.filter(row=>row[2]===41).map(row=>row[3]))].sort((a,b)=>a-b),[1,2,4,9,10]);
});

test('unknown raw pixel modes fail chapter validation and entrance readiness before rendering',()=>{
  for(const [opcode,rawMode]of [[49,2],[49,8],[41,2]]){
    const program=structuredClone(story.programs['m01040-5']),command=program.commands.find(row=>row.opcode===opcode);
    const bytes=Buffer.from(command.raw_hex,'hex');bytes[29]=rawMode;command.raw_hex=bytes.toString('hex');command.byte_plus29=rawMode;
    assert.throws(()=>validateChapterAnimation(program),/人物像素效果模式未恢复/);
    const content={...runtimeContent,maps:Object.fromEntries(program.maps.map(mapId=>[mapId,{triggers:[],objects:[],rests:[],routes:[],npcs:mapId==='M01040'?[10]:[]}]))};
    const table={map_flag_index:4,index_nonzero:[{slot:10,record:1}],records:[{id:1,kind:1,text_raw:'m01040-5.anm',condition_type:0,condition_bit:0,mutation_type:0,mutation_bit:0,next:0}]};
    const report=inspectContentReadiness(content,{maps:{M01040:table},programs:{'m01040-5':program}},{npcs_by_map:{},trigger_regions:{}});
    assert.equal(report.passed,false);assert.ok(report.errors.some(error=>/人物像素效果模式未恢复/.test(error.message)),JSON.stringify(report.errors));
  }
});

test('additive, descending and fade-out effects pause with the action clock and cancellation restores transient rendering',async()=>{
  for(const [kind,nativeStateRaw] of [['facing',1],['facing',8],['behavior',9],['behavior',10]]){
    const clock=new ActionClock(),{view,actor}=fixture(10,{clock}),controller=new AbortController();
    const running=view.hooks().actor({kind,nativeStateRaw,actor:10,signal:controller.signal});
    const first={...actor.blendEffect};clock.paused=true;clock.advance(2000);assert.deepEqual(actor.blendEffect,first);
    clock.paused=false;clock.advance(40);assert.ok(actor.alpha>15/255);
    controller.abort(new Error('cancel native blend'));await assert.rejects(running,/cancel native blend/);
    assert.equal(actor.alpha,1);assert.equal(actor.blendEffect,null);assert.equal(actor.y,120);assert.equal(clock.tasks.size,0);
    view.dispose();clock.destroy();
  }
});
