import {STORY_RESOURCE_TABLES,hydrateStoryTable,storyDigest} from './story_packages.mjs';
import {validateStoryBindings} from './content_dependencies.mjs';
import {hydrateStoryFlow} from './story_flow.mjs';
import {validateQuests,questJournal} from './story_quests.mjs';

const need=(ok,message)=>{if(!ok)throw new Error(`剧情加载：${message}`);};
// One repository admits both TLK maps and standalone NPC events. A failed load
// never installs half a map; rejected requests are retryable. World state is
// owned by WorldStore and is never cached or modified here.
export class StoryRepository {
  static async create({read,index,content,definition,capacity=4,currentMap=()=>null}){
    need(index?.schema==='seventh-seal-story-index'&&index.version===2,'清单版本无效，请重新构建 story-pack');
    need(index.definition_sha256===await storyDigest(definition),'剧情清单与内容登记不同，请重新构建 story-pack');
    need(index.maps&&Object.keys(index.maps).length===Object.keys(content.maps).length
      &&Object.keys(content.maps).every(id=>index.maps[id]),'地图清单与内容登记不同');
    need(Number.isInteger(capacity)&&capacity>=2,'缓存容量至少为两张地图');
    const repository=new StoryRepository({read,index,content,capacity,currentMap});
    const shared=await repository.verified(index.shared);
    need(shared?.schema==='seventh-seal-story-shared'&&shared.version===1,'共享数据版本无效');
    repository.story={schema:'seventh-seal-chapter-story',version:2,...shared.chapter,maps:{},programs:{},flows:{}};
    repository.resources={roles:shared.roles};
    for(const key of STORY_RESOURCE_TABLES)repository.resources[key]={};
    repository.quests=validateQuests(shared.quests,content);
    return repository;
  }
  constructor({read,index,content,capacity,currentMap}){
    Object.assign(this,{read,index,content,capacity,currentMap});
    this.pending=new Map();this.loaded=new Map();this.events=[];this.routes={};this.protected=new Set();this.pins=new Map();
  }
  retainMap(id){
    this.pins.set(id,(this.pins.get(id)??0)+1);let released=false;
    return ()=>{if(released)return;released=true;const count=this.pins.get(id)-1;if(count)this.pins.set(id,count);else this.pins.delete(id);};
  }
  async verified(reference){
    need(reference&&/^data\/story\/[a-z0-9_/-]+\.json$/.test(reference.path??'')&&/^[a-f0-9]{64}$/.test(reference.sha256??''),'包路径或指纹无效');
    const value=await this.read(reference.path);
    need(await storyDigest(value)===reference.sha256,`包指纹不一致：${reference.path}`);
    return value;
  }
  async opening(){
    // Keep a successful immutable source package; a failed fetch can retry.
    if(!this.openingData){
      const value=await this.verified(this.index.opening);
      need(value.schema==='seventh-seal-story-opening'&&value.version===1,'序章包版本无效');
      const program=structuredClone(value.program);
      program.dialogues=Object.fromEntries(Object.entries(program.dialogues).map(([id,table])=>[id,hydrateStoryTable(table,value.texts)]));
      this.openingData=program;
    }
    return this.openingData;
  }
  async ensureMap(id,{protect=[]}={}){
    need(/^M\d{5}$/.test(id)&&Object.hasOwn(this.index.maps,id),`地图 ${id} 尚未登记`);
    this.protected=new Set([...protect,id]);
    if(this.loaded.has(id)){
      const value=this.loaded.get(id);this.loaded.delete(id);this.loaded.set(id,value);this.trim();return value;
    }
    if(!this.pending.has(id)){
      const promise=this.loadMap(id).finally(()=>{this.pending.delete(id);this.trim();});this.pending.set(id,promise);
    }
    return this.pending.get(id);
  }
  async loadMap(id){
    const value=await this.verified(this.index.maps[id]);
    need(value.schema==='seventh-seal-story-map'&&value.version===2&&value.map_id===id,'地图包身份无效');
    const table=hydrateStoryTable(value.chapter,value.texts);
    const events=structuredClone(value.events);
    need(Array.isArray(events)&&events.every(event=>event.map_id===id),'事件归属无效');
    need(value.flows&&typeof value.flows==='object'&&!Array.isArray(value.flows),'流程表缺失');
    const flows=Object.fromEntries(Object.entries(value.flows).map(([key,source])=>{
      const flow=hydrateStoryFlow(source,value.texts);need(flow.id===key&&flow.map_id===id,'流程归属无效');return [key,flow];
    }));
    if(table)need(flows[table.flow_id]&&table.records.every(row=>flows[table.flow_id].entries?.[row.id]),'原剧情流程入口缺失');
    for(const event of events)need(event.schema==='seventh-seal-story-event-binding'&&event.flow_id===event.id&&flows[event.flow_id]
      &&event.program===undefined&&event.commit_policy===undefined,'NPC 流程入口无效');
    const resources={roles:this.resources.roles};
    for(const key of STORY_RESOURCE_TABLES){need(Array.isArray(value.resources?.[key]),`地图 ${id} 缺少 ${key}`);resources[key]={[id]:value.resources[key]};}
    const data={...this.story,maps:table?{[id]:table}:{},programs:value.programs};
    validateStoryBindings({...this.content,maps:{[id]:this.content.maps[id]},programs:Object.fromEntries(Object.keys(value.programs).map(key=>[key,this.content.programs[key]]))},data,resources);
    // All validation completes before the shared adapters can observe the map.
    if(table)this.story.maps[id]=table;
    Object.assign(this.story.programs,value.programs);
    Object.assign(this.story.flows,flows);
    for(const key of STORY_RESOURCE_TABLES)this.resources[key][id]=value.resources[key];
    if(table||value.route)this.routes[id]=table??value.route;
    this.events.push(...events);this.loaded.set(id,{table,events,programs:Object.keys(value.programs),flows:Object.keys(flows)});
    this.trim();return this.loaded.get(id);
  }
  trim(){
    for(const [id,value]of this.loaded){
      if(this.loaded.size<=this.capacity)break;
      if(this.protected.has(id)||this.pending.has(id)||this.pins.has(id)||this.currentMap()===id)continue;
      delete this.story.maps[id];delete this.routes[id];
      value.programs.forEach(key=>delete this.story.programs[key]);
      value.flows.forEach(key=>delete this.story.flows[key]);
      for(const key of STORY_RESOURCE_TABLES)delete this.resources[key][id];
      for(let i=this.events.length-1;i>=0;i--)if(this.events[i].map_id===id)this.events.splice(i,1);
      this.loaded.delete(id);
    }
  }
  journal(world){return questJournal(this.quests,world);}
}
