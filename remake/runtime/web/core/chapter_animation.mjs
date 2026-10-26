import {AnmActions, COMMON_ANM_OPCODES,anmFilename} from './anm_runtime.mjs';
import {runtimeContent,mapId as validMapId} from './content_registry.mjs';
// Registered source programs share the recovered opcode handlers. Unknown
// opcodes/modes remain errors; TLK and joining use the caller's world draft.
const OPCODES = new Set([10,11,14,16,17,20,30,31,32,33,35,36,37,48,49,60,62,63,255]);
const need = (value, message) => { if (!value) throw new Error(message); };
export function chapterAnimationContext(program){
  const loadedMaps=(program.commands??[]).filter(command=>command.opcode===10).map(command=>command.filename?.slice(0,-4).toUpperCase());
  const controlMaps=[...new Set(loadedMaps)];
  const callerMaps=program.expected?.caller_maps??[program.expected?.control_map];
  const maps=program.maps??[program.expected?.control_map];
  return {controlMaps,callerMaps,maps,finalMap:loadedMaps.at(-1)??callerMaps[0]};
}
export function validateChapterAnimation(program,content=runtimeContent) {
  need(program?.schema === 'seventh-seal-chapter-anm' && program.version === 1
    && program.source?.sha256 === content.programs[program.id]?.sha256
    && program.source.path.toLowerCase() === `animate/${program.id}.anm`, '剧情动画来源不兼容');
  need(program.commands?.length > 0 && program.commands.length <= 256
    && program.source.bytes === 67 + program.commands.length * 74, '剧情动画长度无效');
  const {controlMaps,callerMaps,maps,finalMap}=chapterAnimationContext(program);
  need(Array.isArray(maps)&&maps.length>0&&maps.length<=256&&new Set(maps).size===maps.length&&maps.every(id=>validMapId(id)&&content.maps[id]),'剧情动画地图依赖未登记');
  need(Array.isArray(callerMaps)&&new Set(callerMaps).size===callerMaps.length&&callerMaps.every(id=>maps.includes(id))
    &&(controlMaps.length>0||callerMaps.length===1),'剧情动画调用地图不明确');
  need(controlMaps.every(id=>maps.includes(id))&&program.expected?.control_map===finalMap,'剧情动画结束地图与命令不同');
  if(program.expected.control_maps!==undefined)need(JSON.stringify(program.expected.control_maps)===JSON.stringify(controlMaps),'剧情动画控制地图与命令不同');
  need(maps.length===new Set([...callerMaps,...controlMaps]).size,'剧情动画包含无来源地图依赖');
  if(program.context_sources){
    const callers=[...(program.context_sources.caller_records??[]),...(program.context_sources.caller_descriptors??[])];
    need(JSON.stringify([...new Set(callers.map(caller=>caller.map_id))])===JSON.stringify(callerMaps),'剧情动画调用地图与来源不同');
    const loads=program.commands.filter(command=>command.opcode===10),sources=program.context_sources.map_commands;
    need(Array.isArray(sources)&&sources.length===loads.length&&sources.every((source,index)=>source.command_index===loads[index].index
      &&source.map_id===loads[index].filename.slice(0,-4).toUpperCase()&&JSON.stringify(source.source)===JSON.stringify(loads[index].source)),'剧情动画地图命令来源不同');
  }
  for (const [index, c] of program.commands.entries()) {
    need(c.index === index && OPCODES.has(c.opcode) && /^[0-9a-f]{148}$/.test(c.raw_hex), `剧情动画 ${program.id} 命令 ${index}（opcode ${c.opcode}）未支持`);
    const b = Uint8Array.from(c.raw_hex.match(/../g), part => parseInt(part,16)), v = new DataView(b.buffer);
    need(c.opcode === b[0] && c.source.offset === 67 + index*74
      && c.source.sha256 === program.source.sha256 && c.source.path === program.source.path, '剧情动画记录来源不符');
    for (const offset of [1,5,9,13,17,21,25]) need(c[`u32_plus${offset}`] === v.getUint32(offset,true), '剧情动画字段不符');
    for (const offset of [29,30,31,32,33]) need(c[`byte_plus${offset}`] === b[offset], '剧情动画字节不符');
    if ([32,33,35,36,37,48,49].includes(c.opcode)) need(c.u32_plus5>=10||Object.values(content.roles).some(role=>role.side==='player'&&role.native_slot===c.u32_plus5), '剧情动画人物未接入');
    if (c.opcode === 10) need(/^M\d{5}(?:-\d+)?\.DAT$/i.test(c.filename??'')
      &&c.filename===new TextDecoder().decode(b.slice(54,74)).split('\0')[0]
      &&maps.includes(c.filename.slice(0,-4).toUpperCase())&&c.u32_plus5 === 0, '剧情动画地图入口未支持');
    // Native 0x473E30 case0x21 selects the explicit DGP action when +29 is nonzero.
    if (c.opcode === 33) need([0,1,2].includes(c.byte_plus29) && (c.u32_plus25&255) <= 8, '剧情移动模式／到达朝向未支持');
    if(c.opcode===17)need([0,3].includes(c.u32_plus5)&&c.byte_plus29<=1,'剧情画面效果模式未支持');
    if (c.opcode === 36) need(Object.values(content.roles).some(role=>role.side==='player'&&role.native_slot===c.u32_plus5)&&[0,3].includes(c.byte_plus29), '剧情队伍操作未支持');
    if (c.opcode === 37) need(Object.values(content.roles).some(role=>role.side==='player'&&role.native_slot===c.u32_plus5), '剧情离队人物未接入');
    if(c.opcode===20){
      need(c.u32_plus5<2000&&c.u32_plus25<=32,'剧情旗标索引或位无效');
      if(c.byte_plus29>=2)for(const target of [c.u32_plus13,c.u32_plus17])need(target>=0&&target<=program.commands.length,'剧情旗标跳转越界');
      if(c.byte_plus29>=2&&c.u32_plus25===0)need(c.u32_plus13>0,'剧情旗标无条件跳转缺少目标');
    }
    if([60,62].includes(c.opcode)){
      const filename=anmFilename(c);if(c.filename!==undefined)need(c.filename===filename,'剧情媒体文件名与来源不同');
      if(c.opcode===60)need(/^[a-z0-9_-]+\.bik$/i.test(filename),'剧情影片文件名无效');
      if(c.opcode===62){need([0,1,2].includes(c.byte_plus29),'剧情声音模式未恢复');
        if(c.byte_plus29!==1)need(/^[a-z0-9_-]+\.(?:wav|mp3)$/i.test(filename),'剧情声音文件名无效');}
    }
    // 473E30 defaults start0 to1, repetitions0 to1, and end0 to the
    // selected DGP action's native logical count (46A110).
    if (c.opcode === 48) need(c.u32_plus13 >= 0 && c.u32_plus13 <= 512
      && (c.u32_plus17===0||c.u32_plus17>(c.u32_plus13||1))
      && c.u32_plus17 <= 512 && c.u32_plus25 >= 0, '剧情动作帧范围无效');
  }
  return program;
}
// Loader ANMs may include camera focus and a barrier around their placements.
// Those affect the transient presentation only; map-stage projection consumes
// the same validated program while retaining the saved player and camera state.
export function validateChapterSetupAnimation(program,mapId,content=runtimeContent){
  validateChapterAnimation(program,content);
  const layoutOpcodes=new Set([10,16,30,31,32,35]);
  for(const command of program.commands){
    need(layoutOpcodes.has(command.opcode),`布局演出 ${program.id}:${command.index} 含非布局指令 ${command.opcode}`);
    if(command.opcode===10)need(command.u32_plus5===0&&command.filename.toUpperCase()===`${mapId}.DAT`,'布局演出不能切换地图');
  }
  return program;
}
export class ChapterAnimationRunner {
  constructor({program,hooks,runTlk,joinActor,leaveActor,flagCommand,initialLocation,initialActor=0,playback=null,content=runtimeContent,visualState={}}) {
    validateChapterAnimation(program,content);
    for (const name of ['map','actor','move','camera','wait']) need(typeof hooks?.[name] === 'function', `剧情动画接口缺失：${name}`);
    Object.assign(this,{program,hooks,runTlk,joinActor,leaveActor,flagCommand,initialLocation,initialActor,playback,visualState}); this.phase = 'idle';
  }
  async run() {
    need(this.phase === 'idle','剧情动画已执行'); this.phase = 'running';
    const positions = new Map([[this.initialActor,{...this.initialLocation}]]);
    let mapId = this.initialLocation.map_id,controlledActor=this.initialActor,steps=0;
    const actions = new AnmActions({hooks:this.hooks, context:() => ({mapId,controlledActor}), positions,playback:this.playback,visualState:this.visualState});
    try {
      const {callerMaps}=chapterAnimationContext(this.program);
      need(callerMaps.length===0||callerMaps.includes(mapId),'剧情动画调用地图与当前场景不同');
      // Programs without opcode10 inherit the actual caller's actor table.
      // Bootstrap the presentation only; no native map-load event is invented.
      if(this.program.commands[0].opcode!==10)await actions.call('map',this.program.commands[0],{mapId,initialLocation:this.initialLocation,bootstrap:true});
      for (let cursor=0;cursor<this.program.commands.length;cursor++) {
        need(++steps<=10000,'剧情动画分支执行超过上限');
        const c=this.program.commands[cursor];
        if(this.playback?.paused)await this.playback.ready();
        actions.check();
        if (COMMON_ANM_OPCODES.has(c.opcode)) { await actions.execute(c); continue; }
        switch(c.opcode) {
          case 10:
            await actions.flush(); mapId = c.filename.slice(0,-4).toUpperCase();
            positions.clear();positions.set(controlledActor,{...this.initialLocation,map_id:mapId});
            await actions.call('map', c, {mapId, initialLocation:this.initialLocation}); break;
          case 14:
            await this.runTlk({mapId, recordId:c.u32_plus5}); await actions.frame(c); break;
          case 20: {
            need(typeof this.flagCommand==='function','剧情动画旗标接口缺失');
            const result=await this.flagCommand({command:c,mapId});actions.check();
            if(result?.nextIndex!==null&&result?.nextIndex!==undefined){
              need(Number.isInteger(result.nextIndex)&&result.nextIndex>=0&&result.nextIndex<this.program.commands.length,'剧情旗标跳转越界');
              cursor=result.nextIndex-1;
            }
            break;
          }
          case 36:
            await this.joinActor({actorSlot:c.u32_plus5,modeRaw:c.byte_plus29,command:c});
            if(c.byte_plus29===3){
              await actions.flush();
              const at=positions.get(controlledActor)??this.initialLocation;
              await actions.call('actor',c,{kind:'control',actor:c.u32_plus5,previousActor:controlledActor});
              controlledActor=c.u32_plus5;positions.set(controlledActor,{...at,map_id:mapId});
            }
            break;
          case 37:
            need(typeof this.leaveActor==='function','剧情动画离队接口缺失');
            await this.leaveActor({actorSlot:c.u32_plus5,command:c});
            await actions.call('actor',c,{kind:'hide',actor:c.u32_plus5});break;
          default: throw new Error(`剧情动画指令${c.opcode}尚未支持`);
        }
      }
      await actions.flush(); actions.check();Object.assign(this.visualState,actions.visualState);this.phase = 'complete';
      return {location:positions.get(controlledActor)??positions.get(0),controlled_actor:controlledActor,
        commands:this.program.commands.length,steps,source:this.program.source};
    } catch(error) { actions.abort(error); this.phase = this.playback?.phase==='cancelled'?'cancelled':'failed'; throw error; }
    finally {actions.dispose();}
  }
}
