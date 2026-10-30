// Actual late Fire Valley ANM bytes, replayed through reconstructed handlers.
// This is static source conformance, not an observation of GAME.exe execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ChapterAnimationRunner,validateChapterAnimation} from '../web/core/chapter_animation.mjs';
import {applyNativeAnmFlagCommand} from '../web/core/native_anm_commands.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {OpeningView} from '../web/opening_view.mjs';
import {ActionClock} from '../web/phaser/components/action_clock.mjs';
import {AnmActions} from '../web/core/anm_runtime.mjs';
const read=name=>readFile(new URL(`../../../${name}`,import.meta.url));
const story=JSON.parse(await readFile(new URL('../web/data/chapter_story.json',import.meta.url)));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function sourceProgram(id){
  const bytes=await read(`Animate/${id}.anm`),source={path:`Animate/${id}.anm`,sha256:hash(bytes),bytes:bytes.length};
  const commands=Array.from({length:bytes.readUInt32LE(2)},(_,index)=>{
    const offset=67+index*74,raw=bytes.subarray(offset,offset+74),row={index,opcode:raw[0],raw_hex:raw.toString('hex'),
      source:{...source,offset,record_index:index}};
    for(const at of [1,5,9,13,17,21,25])row[`u32_plus${at}`]=raw.readUInt32LE(at);
    for(let at=29;at<34;at++)row[`byte_plus${at}`]=raw[at];
    if([10,60,62].includes(row.opcode))row.filename=raw.subarray(54).toString().split('\0')[0];return row;
  });
  const controlMaps=[...new Set(commands.filter(row=>row.opcode===10).map(row=>row.filename.slice(0,-4).toUpperCase()))];
  const callers=Object.entries(story.maps).filter(([,table])=>table.records.some(row=>row.kind===1&&row.text_raw.toLowerCase().replace(/\.anm$/,'')===id)
    ||table.descriptors.some(row=>row.state_raw===1&&row.filename_raw.toLowerCase()===`${id}.anm`)).map(([mapId])=>mapId);
  assert.ok(callers.length>0,'source TLK/DAT caller retained');
  const program={schema:'seventh-seal-chapter-anm',version:1,id,source,commands,maps:[...new Set([...callers,...controlMaps])],
    expected:{caller_maps:callers,control_maps:controlMaps,control_map:controlMaps.at(-1)??callers[0]}};
  const content=structuredClone(runtimeContent);content.programs[id]=source;
  for(const roleId of ['004','006'])content.roles[roleId]={side:'player',native_slot:Number(roleId)-1,
    source:{path:`Fight_Role/${roleId}.CHR`,sha256:hash(await read(`Fight_Role/${roleId}.CHR`))}};
  validateChapterAnimation(program,content);return {program,content,bytes};
}
function hooks(trace){return Object.fromEntries(['map','actor','move','camera','wait','fade','media','sound'].map(name=>[name,async payload=>trace.push({hook:name,...payload})]));}

test('real m17010-3 executes both camera modes and continues after source annotation255',async()=>{
  const {program,content,bytes}=await sourceProgram('m17010-3'),trace=[];
  const runner=new ChapterAnimationRunner({program,content,hooks:hooks(trace),initialLocation:{map_id:'M17020',x:1240,y:1456,direction:0},
    joinActor:async row=>trace.push({hook:'join',...row}),leaveActor:async row=>trace.push({hook:'leave',...row}),
    runTlk:async row=>trace.push({hook:'tlk',...row})});
  const result=await runner.run();assert.equal(result.location.map_id,'M17032');assert.equal(result.steps,program.commands.length);
  assert.deepEqual(trace.filter(row=>row.hook==='camera'&&row.kind==='position').map(row=>[row.command.index,row.modeRaw,row.x,row.y]),[[44,0,912,960],[54,2,720,864]]);
  assert.equal(program.commands[58].opcode,255);assert.equal(bytes[67+58*74],255);
  assert.ok(trace.some(row=>row.hook==='map'&&row.command.index===59&&row.mapId==='M17032'));
  assert.ok(trace.some(row=>row.hook==='actor'&&row.command.index===65&&row.kind==='restore'));
});

test('real m03021 executes all 280 source commands, both videos and the final arriving-map sequence',async()=>{
  const {program,content,bytes}=await sourceProgram('m03021'),trace=[];
  assert.equal(bytes.readUInt32LE(2),280);assert.equal(bytes.length,67+280*74);
  const result=await new ChapterAnimationRunner({program,content,hooks:hooks(trace),initialActor:2,
    initialLocation:{map_id:program.expected.caller_maps[0],x:400,y:400,direction:0},
    joinActor:async row=>trace.push({hook:'join',...row}),leaveActor:async()=>{},runTlk:async row=>trace.push({hook:'tlk',...row})}).run();
  assert.deepEqual([result.commands,result.steps,result.controlled_actor,result.location.map_id],[280,280,2,'M03023']);
  assert.deepEqual(trace.filter(row=>row.hook==='map'&&!row.bootstrap).map(row=>row.mapId),['M03020-1','M03021-2','M03021-3','M03021-4','M03023']);
  assert.deepEqual(trace.filter(row=>row.hook==='media').map(row=>[row.command.index,row.filename]),[[68,'09.bik'],[96,'10.bik']]);
  assert.deepEqual(trace.filter(row=>row.hook==='join').map(row=>[row.command.index,row.actorSlot,row.modeRaw]),[[269,3,0]]);
  assert.ok(trace.some(row=>row.hook==='actor'&&row.command.index===278&&row.kind==='restore'));
});

test('real finale follows both flag23 paths and plays each original video and deferred voice command',async()=>{
  const {program,content}=await sourceProgram('m17030-1');
  for(const flag of [0,1]){
    const trace=[],draft={flags:Array(2000).fill(0)};draft.flags[23]=flag;
    const runner=new ChapterAnimationRunner({program,content,hooks:hooks(trace),initialLocation:{map_id:'M17032',x:640,y:480,direction:0},
      joinActor:async row=>trace.push({hook:'join',...row}),leaveActor:async row=>trace.push({hook:'leave',...row}),
      runTlk:async row=>trace.push({hook:'tlk',...row}),
      flagCommand:({command,mapId})=>applyNativeAnmFlagCommand(draft,command,story.maps[mapId].map_flag_index)});
    const result=await runner.run();assert.equal(result.location.map_id,'M17023');
    assert.deepEqual(trace.filter(row=>row.hook==='media').map(row=>[row.command.index,row.filename]),[[96,'20.bik'],[107,'24.bik'],[182,'25.bik']]);
    assert.deepEqual(trace.filter(row=>row.hook==='sound').map(row=>[row.command.index,row.kind,row.modeRaw,row.filename,row.persistent]),
      [[61,'release',1,undefined,undefined],[62,'play',2,'MANYANSHORT.wav',true],[64,'release',2,undefined,undefined],[66,'restore-music',1,'',false]]);
    assert.deepEqual(trace.filter(row=>row.hook==='camera'&&row.kind==='shake').map(row=>[row.command.index,row.modeRaw,row.cycles,row.amplitude]),[[119,1,40,20]]);
    assert.equal(trace.some(row=>row.hook==='fade'&&row.command.index===119),false);
    assert.equal(trace.some(row=>row.hook==='join'&&row.command.index===8),flag===0);
    assert.equal(trace.some(row=>row.hook==='tlk'&&row.mapId==='M17030-2'&&row.recordId===33),flag===0);
    assert.equal(draft.flags[23],flag,'tests must not invent a phase flag write');
  }
});

test('shake parameters retain native defaults and session updates, and failed programs leave the shared session unchanged',async()=>{
  const {program,content}=await sourceProgram('m17030-1'),trace=[],session={};
  const command=program.commands[119],defaults={...command,u32_plus13:0,u32_plus17:0};
  const first=new AnmActions({hooks:hooks(trace),context:()=>({mapId:'M17030-2'}),positions:new Map()});
  await first.execute(defaults);assert.deepEqual([trace[0].cycles,trace[0].amplitude],[10,8]);first.dispose();
  const options={program,content,visualState:session,initialLocation:{map_id:'M17032',x:640,y:480,direction:0},
    joinActor:async()=>{},leaveActor:async()=>{},runTlk:async()=>{},flagCommand:()=>({nextIndex:null})};
  const failed=new ChapterAnimationRunner({...options,hooks:{...hooks([]),camera:async row=>{if(row.kind==='shake')throw new Error('shake render failed');}}});
  await assert.rejects(failed.run(),/shake render failed/);assert.deepEqual(session,{});
  await new ChapterAnimationRunner({...options,hooks:hooks([])}).run();assert.deepEqual(session,{shakeCycles:40,shakeAmplitudeNative:10});
  const nextTrace=[],next=new AnmActions({hooks:hooks(nextTrace),context:()=>({mapId:'M17023'}),positions:new Map(),visualState:session});
  await next.execute(defaults);assert.deepEqual([nextTrace[0].cycles,nextTrace[0].amplitude],[40,20]);next.dispose();
});

test('shake source modes alternate displacement and restoration and respect pause, cancel and disposed camera ownership',async()=>{
  const role={anchor:{x:0,y:0},actions:[{index:0,first_frame:0,frame_count:1,directions:8}]};
  const scene={data:{id:'M17010',opening_npcs:[]},npcs:[],bitmap:{width:1600,height:1504}};
  const make=async(cameraRenderMode=0)=>{
    const clock=new ActionClock(),positions=[],view=new OpeningView({resources:{roles:{'001':role}},prepared:new Map([['M17010',scene]]),
      clock,nativeViewport:true,cameraRenderMode,install(){},camera:(x,y)=>positions.push({x,y})});
    await view.hooks().map({mapId:'M17010',initialLocation:{x:1000,y:1000,direction:0}});return {clock,positions,view};
  };
  for(const [cameraRenderMode,modeRaw,dx,dy]of [[0,0,8,8],[0,1,-8,8],[1,0,0,8],[1,1,8,0]]){
    const {clock,positions,view}=await make(cameraRenderMode),origin={...positions.at(-1)};
    view.tween=async()=>{};await view.hooks().camera({kind:'shake',cycles:2,amplitude:8,modeRaw});
    assert.deepEqual(positions.slice(1),[{x:origin.x+dx,y:origin.y+dy},origin,{x:origin.x+dx,y:origin.y+dy},origin,origin]);
    assert.equal(view.focus,0);view.dispose();clock.destroy();
  }
  const {clock,positions,view}=await make(),origin={...positions.at(-1)},abort=new AbortController();
  const running=view.hooks().camera({kind:'shake',cycles:40,amplitude:20,modeRaw:1,signal:abort.signal});
  clock.paused=true;const held={...positions.at(-1)};clock.advance(2000);await Promise.resolve();assert.deepEqual(positions.at(-1),held);
  clock.paused=false;clock.advance(17);await Promise.resolve();await Promise.resolve();assert.deepEqual(positions.at(-1),origin);
  abort.abort(new Error('shake cancelled'));await assert.rejects(running,/shake cancelled/);
  assert.deepEqual(positions.at(-1),origin);assert.equal(view.focus,0);assert.equal(clock.tasks.size,0);
  const disposed=view.hooks().camera({kind:'shake',cycles:40,amplitude:20,modeRaw:1});
  view.dispose();const count=positions.length;await assert.rejects(disposed,/演出已关闭/);
  assert.equal(positions.length,count);assert.equal(view.focus,null);assert.equal(clock.tasks.size,0);clock.destroy();
});

test('flag mutation uses the current-map fallback, preserves uint32 and validates branch bounds',()=>{
  const draft={flags:Array(2000).fill(0)},command={opcode:20,u32_plus5:0,u32_plus25:32,byte_plus29:0,u32_plus13:2,u32_plus17:3};
  assert.deepEqual(applyNativeAnmFlagCommand(draft,command,11),{nextIndex:null});assert.equal(draft.flags[11],0x80000000);
  command.byte_plus29=2;assert.equal(applyNativeAnmFlagCommand(draft,command,11).nextIndex,1);
  command.byte_plus29=1;applyNativeAnmFlagCommand(draft,command,11);assert.equal(draft.flags[11],0);
  command.byte_plus29=2;assert.equal(applyNativeAnmFlagCommand(draft,command,11).nextIndex,2);
  command.u32_plus25=0;assert.equal(applyNativeAnmFlagCommand(draft,command,11).nextIndex,1);
  command.u32_plus13=0;assert.throws(()=>applyNativeAnmFlagCommand(draft,command,11),/缺少目标/);
});

test('camera scrolling respects source+145 step, engine pause and cancellation; control restore keeps the selected actor',async()=>{
  const clock=new ActionClock(),cameras=[],role={anchor:{x:0,y:0},actions:[{index:0,first_frame:0,frame_count:1,directions:8}]};
  const scene={data:{id:'M17010',movement:{native_camera_step_shift:1,native_to_pixel_scale:2},opening_npcs:[]},npcs:[],bitmap:{width:1600,height:1504}};
  const view=new OpeningView({resources:{roles:{'001':role,'005':role}},prepared:new Map([['M17010',scene]]),clock,nativeViewport:true,
    install(){},camera:(x,y)=>cameras.push({x,y})});
  const h=view.hooks();await h.map({mapId:'M17010',initialLocation:{x:1000,y:1000,direction:4}});
  const start=cameras.at(-1),running=h.camera({kind:'position',x:912,y:960,modeRaw:0});
  clock.paused=true;clock.advance(1000);assert.deepEqual(cameras.at(-1),start);
  clock.paused=false;clock.advance(16);assert.deepEqual(cameras.at(-1),{x:start.x-4,y:start.y-4});
  clock.advance(1000);await running;assert.deepEqual(cameras.at(-1),{x:912,y:960});
  const abort=new AbortController(),cancelled=h.camera({kind:'position',x:720,y:864,modeRaw:2,signal:abort.signal});
  abort.abort(new Error('cancel camera'));await assert.rejects(cancelled,/cancel camera/);assert.equal(clock.tasks.size,0);
  view.getActor(4).direction=2;await h.actor({kind:'control',actor:4,previousActor:0});
  assert.equal(view.getActor(0).visible,false);assert.equal(view.getActor(4).visible,true);assert.equal(view.getActor(4).direction,2);
  view.getActor(0).visible=true;await h.actor({kind:'restore',controlledActor:4});assert.equal(view.getActor(0).visible,false);assert.equal(view.getActor(4).visible,true);
  view.dispose();clock.destroy();
});

test('source m17010-3 command43 restores opcode48 zero defaults from the actual DGP logical action count',async()=>{
  const {program}=await sourceProgram('m17010-3'),command=program.commands[43];
  assert.deepEqual([command.opcode,command.u32_plus13,command.u32_plus17,command.u32_plus25],[48,0,0,1]);
  const resources=JSON.parse(await readFile(new URL('../web/data/opening_map_resources.json',import.meta.url))),clock=new ActionClock();
  const role=resources.roles['001'],scene={data:{id:'M17010',opening_npcs:[]},npcs:[],bitmap:{width:1600,height:1504}};
  const view=new OpeningView({resources:{roles:{'001':role}},prepared:new Map([['M17010',scene]]),clock,nativeViewport:true,install(){},camera(){}});
  await view.hooks().map({mapId:'M17010',initialLocation:{x:1000,y:1000,direction:0}});
  const actions=new AnmActions({hooks:view.hooks(),context:()=>({mapId:'M17010'}),positions:new Map()});
  await actions.execute(command);const complete=actions.flush();clock.advance(2000);await complete;
  assert.equal(view.getActor(0).action,0);assert.equal(view.getActor(0).frame,role.actions[0].logical_count-2);
  actions.dispose();view.dispose();clock.destroy();
});
