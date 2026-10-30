// Original ANM bytes through the actual actor renderer hooks. The retained
// wrapper instructions independently establish draw count/coefficient/offset;
// GPU ADD and alpha are adapters, not an RGB565 framebuffer comparison.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {OpeningView} from '../web/opening_view.mjs';
import {AnmActions} from '../web/core/anm_runtime.mjs';
import {ActionClock} from '../web/phaser/components/action_clock.mjs';
import {validateChapterAnimation} from '../web/core/chapter_animation.mjs';
import {inspectContentReadiness} from '../web/core/content_readiness.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';

const root=new URL('../../../',import.meta.url),read=path=>readFile(new URL(path,root));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const story=JSON.parse(await read('remake/runtime/web/data/chapter_story.json'));
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

test('every registered source ANM41/49 command reaches its real renderer and retains show/hide semantics',async()=>{
  // Pixel extraction is a one-pixel fixture; particle displacement is covered
  // by its existing source tests. This regression exercises the actual hook,
  // including construction of the real particle renderer, instead of no-ops.
  const previous=globalThis.document;
  globalThis.document={createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:Uint8ClampedArray.from([80,120,160,255])})})})};
  const visited=[];
  try{
    for(const program of Object.values(story.programs)){
      if(!runtimeContent.programs[program.id])continue;
      const commands=program.commands.filter(command=>[41,49].includes(command.opcode));if(!commands.length)continue;
      const bytes=await read(program.source.path);assert.equal(hash(bytes),program.source.sha256);validateChapterAnimation(program);
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
  assert.equal(visited.length,14);
  assert.deepEqual([...new Set(visited.filter(row=>row[2]===49).map(row=>row[3]))].sort((a,b)=>a-b),[1,2,7,8]);
  assert.deepEqual([...new Set(visited.filter(row=>row[2]===41).map(row=>row[3]))].sort(),[1,2]);
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

test('new additive and descending effects pause with the action clock and cancellation restores transient rendering',async()=>{
  for(const nativeStateRaw of [1,8]){
    const clock=new ActionClock(),{view,actor}=fixture(10,{clock}),controller=new AbortController();
    const running=view.hooks().actor({kind:'facing',nativeStateRaw,actor:10,signal:controller.signal});
    const first={...actor.blendEffect};clock.paused=true;clock.advance(2000);assert.deepEqual(actor.blendEffect,first);
    clock.paused=false;clock.advance(40);assert.ok(actor.alpha>15/255);
    controller.abort(new Error('cancel native blend'));await assert.rejects(running,/cancel native blend/);
    assert.equal(actor.alpha,1);assert.equal(actor.blendEffect,null);assert.equal(actor.y,120);assert.equal(clock.tasks.size,0);
    view.dispose();clock.destroy();
  }
});
