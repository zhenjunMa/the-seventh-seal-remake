// Quest definitions describe existing world state. Rewards and mutations stay
// in the story transaction, so loading a journal cannot grant rewards twice.
const need=(ok,message)=>{if(!ok)throw new Error(`任务定义：${message}`);};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value);
export function validateQuestCondition(condition,content,depth=0){
  need(depth<16&&plain(condition)&&Object.keys(condition).length===1,'条件必须包含一个受支持的判断');
  const [kind,value]=Object.entries(condition)[0];
  if(kind==='all'||kind==='any'){
    need(Array.isArray(value)&&value.length<=100&&(kind==='all'||value.length>0),'组合条件无效');
    value.forEach(child=>validateQuestCondition(child,content,depth+1));
  }else if(kind==='not')validateQuestCondition(value,content,depth+1);
  else if(kind==='flag')need(plain(value)&&Object.keys(value).every(key=>['index','bit','value'].includes(key))
    &&Number.isInteger(value.index)&&value.index>=0&&value.index<2000
    &&Number.isInteger(value.bit)&&value.bit>=1&&value.bit<=32&&typeof value.value==='boolean','旗标条件无效');
  else if(kind==='party_member')need(typeof value==='string'&&content.roles[value]?.side==='player','队员条件无效');
  else throw new Error(`任务定义：条件 ${kind} 尚未支持`);
  return condition;
}
export function questConditionMet(condition,world){
  const [kind,value]=Object.entries(condition)[0];
  switch(kind){
    case 'all':return value.every(child=>questConditionMet(child,world));
    case 'any':return value.some(child=>questConditionMet(child,world));
    case 'not':return !questConditionMet(value,world);
    case 'flag':return Boolean(world.flags[value.index]&(1<<(value.bit-1)))===value.value;
    case 'party_member':return world.party.some(role=>role.id===value);
    default:throw new Error(`任务定义：条件 ${kind} 尚未支持`);
  }
}
export function validateQuests(quests,content){
  need(Array.isArray(quests),'任务表无效');
  const ids=new Set();
  for(const quest of quests){
    need(plain(quest)&&Object.keys(quest).every(key=>['id','name','maps','stages'].includes(key)), '任务包含未知字段');
    need(identity(quest.id)&&!ids.has(quest.id)&&typeof quest.name==='string'&&quest.name.length>0,'任务编号重复或名称无效');ids.add(quest.id);
    need(Array.isArray(quest.maps)&&quest.maps.length>0&&new Set(quest.maps).size===quest.maps.length&&quest.maps.every(id=>Object.hasOwn(content.maps,id)),`${quest.id} 引用未登记地图`);
    need(Array.isArray(quest.stages)&&quest.stages.length>0&&quest.stages.length<=100,`${quest.id} 缺少阶段`);
    const stages=new Set();
    for(const stage of quest.stages){
      need(plain(stage)&&Object.keys(stage).every(key=>['id','status','text','when'].includes(key)),`${quest.id} 阶段包含未知字段`);
      need(identity(stage.id)&&!stages.has(stage.id)&&['hidden','available','active','completed','failed'].includes(stage.status)
        &&typeof stage.text==='string',`${quest.id} 阶段无效`);stages.add(stage.id);
      validateQuestCondition(stage.when,content);
    }
  }
  return quests;
}
export function questJournal(quests,world){
  return quests.map(quest=>{
    const stage=quest.stages.find(row=>questConditionMet(row.when,world));
    return {id:quest.id,name:quest.name,maps:[...quest.maps],stage:stage?.id??null,status:stage?.status??'hidden',text:stage?.text??''};
  });
}
