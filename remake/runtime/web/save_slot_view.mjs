const dateFormat=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});

function savedDate(summary){
  const date=typeof summary.saved_at==='string'?new Date(summary.saved_at):null;
  if(!date||!Number.isFinite(date.getTime()))return {text:'—',detail:'保存时间未知'};
  const parts=Object.fromEntries(dateFormat.formatToParts(date).map(({type,value})=>[type,value]));
  const text=`${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  return {text,detail:`${summary.saved_at_source==='file'?'旧存档，使用文件修改时间':'保存时间'}：${text}:${parts.second}（北京时间）`};
}

function span(className,value){
  const node=document.createElement('span');node.className=className;node.textContent=value;return node;
}

// Shared row content for the title picker and the communications crystal.
export function renderSaveSlotText(button,{label,summary,error}={}){
  if(error||!summary){
    const heading=`${label}　${error?'无法读取':'空白存档'}`;
    button.replaceChildren(span('save-slot-heading',heading));button.setAttribute('aria-label',heading);return;
  }
  const map=summary.location?.map_name||summary.location?.map_id||'';
  const heading=span('save-slot-heading',`${label}${map?'　'+map:''}`);heading.setAttribute('title',heading.textContent);
  const party=span('save-slot-party',(summary.party??[]).map(role=>role.name).join('　'));party.setAttribute('title',party.textContent);
  const saved=savedDate(summary),seconds=Math.floor((summary.play_time_ms??0)/1000);
  const duration=[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(value=>String(value).padStart(2,'0')).join(':');
  const times=span('save-slot-times',''),date=span('save-slot-date',`保存 ${saved.text}`),elapsed=span('save-slot-duration',`时长 ${duration}`);
  date.setAttribute('title',saved.detail);times.append(date,elapsed);
  button.replaceChildren(heading,party,times);
  button.setAttribute('aria-label',[heading.textContent,party.textContent,date.textContent,elapsed.textContent].filter(Boolean).join('，'));
}
