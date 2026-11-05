// Real local-browser acceptance for first-time media builds; uses only visible
// DOM controls and keyboard/mouse events, never a private game-state shortcut.
import fs from 'node:fs/promises';
import path from 'node:path';

const args=process.argv.slice(2),option=(name,fallback)=>{const at=args.indexOf(name);return at<0?fallback:args[at+1];};
const profile=option('--profile','/private/tmp/seventh-browser-first-build');
const url=option('--url','http://127.0.0.1:8786/');
if(!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(url))throw Error('验收只访问本机游戏服务');
const output=path.resolve(option('--output','remake/runtime/evidence/first_build_browser_20261106'));
await fs.mkdir(output,{recursive:true});
const port=Number((await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);
const endpoint=`http://127.0.0.1:${port}`;
const targets=await(await fetch(endpoint+'/json/list')).json();
let target=targets.find(row=>row.type==='page'&&row.url===url),created=!target;
if(!target)target=await(await fetch(endpoint+'/json/new?about:blank',{method:'PUT'})).json();
const socket=new WebSocket(target.webSocketDebuggerUrl),pending=new Map(),errors=[],requests=[];let sequence=0;
socket.addEventListener('message',event=>{
  const value=JSON.parse(event.data);
  if(value.id){const task=pending.get(value.id);if(task){pending.delete(value.id);clearTimeout(task.timeout);value.error?task.reject(Error(JSON.stringify(value.error))):task.resolve(value.result);}return;}
  if(value.method==='Runtime.exceptionThrown')errors.push(value.params.exceptionDetails);
  if(value.method==='Network.responseReceived'&&value.params.response.status>=400&&!value.params.response.url.endsWith('/favicon.ico'))
    requests.push({url:value.params.response.url,status:value.params.response.status});
});
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
function send(method,params={}){return new Promise((resolve,reject)=>{
  const id=++sequence,timeout=setTimeout(()=>{pending.delete(id);reject(Error('浏览器命令超时：'+method));},20000);
  pending.set(id,{resolve,reject,timeout});socket.send(JSON.stringify({id,method,params}));
});}
async function evaluate(expression){const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});
  if(result.exceptionDetails)throw Error(result.exceptionDetails.text+': '+result.exceptionDetails.exception?.description);
  return result.result.value;
}
try{
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:960,deviceScaleFactor:1,mobile:false});
  const action=option('--action','inspect');
  if(created||action==='navigate')await send('Page.navigate',{url});
  await send('Page.bringToFront');
  await send('Emulation.setFocusEmulationEnabled',{enabled:true});
  if(action==='download')await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:output});
  if(action==='click'||action==='download'){
    const selector=option('--selector');if(!selector)throw Error('缺少 --selector');
    const rect=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('按钮不可用');e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
    await send('Input.dispatchMouseEvent',{type:'mouseMoved',...rect});
    await send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...rect});
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...rect});
  }
  if(action==='key'||action==='advance'){
    const key=option('--key','Enter'),codes={Enter:13,Escape:27,Tab:9,' ':32,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,F4:115,F5:116};
    if(!codes[key])throw Error('未声明的验收按键：'+key);
    const params={key,code:key===' '?'Space':key,windowsVirtualKeyCode:codes[key],nativeVirtualKeyCode:codes[key]};
    const count=action==='advance'?40:1;
    for(let index=0;index<count;index++){
      if(action==='advance'&&await evaluate("document.getElementById('scenePhase')?.textContent!=='序章演出'"))break;
      await send('Input.dispatchKeyEvent',{type:'keyDown',...params});await send('Input.dispatchKeyEvent',{type:'keyUp',...params});
      if(action==='advance')await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  const delay=Number(option('--wait','1500'));if(!Number.isFinite(delay)||delay<0||delay>25000)throw Error('等待范围应为 0～25000ms');
  await new Promise(resolve=>setTimeout(resolve,delay));
  const state=await evaluate(`(()=>{
    const visible=e=>Boolean(e&&e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
    const text=id=>document.getElementById(id)?.textContent??'';
    return {title:document.title,url:location.href,visibility:document.visibilityState,focused:document.hasFocus(),phase:text('scenePhase'),map:text('mapName'),
      startup:visible(document.getElementById('startMenu')),
      startupStage:document.getElementById('startMenu')?.dataset.stage,
      announcement:text('startupAnnouncement'),
      caption:visible(document.getElementById('storyCaption'))?text('captionText'):null,
      dialogue:visible(document.getElementById('dialogue'))?text('dialogueText'):null,
      menu:visible(document.getElementById('partyMenu')),saveStatus:text('saveStatus'),
      status:[...document.querySelectorAll('[role=status]')].map(e=>e.textContent),
      buttons:[...document.querySelectorAll('button')].filter(visible).map(e=>({id:e.id,label:e.getAttribute('aria-label')||e.textContent,disabled:e.disabled})),
      report:text('report').slice(0,10000),poseReport:text('poseReport').slice(0,3000),
      canvases:[...document.querySelectorAll('canvas')].filter(visible).map(e=>({width:e.width,height:e.height,id:e.id})),
      brokenImages:[...document.images].filter(e=>e.getAttribute('src')&&e.complete&&!e.naturalWidth).map(e=>e.src)
    };
  })()`);
  const image=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  const ident=new Date().toISOString().replace(/[:.]/g,'-')+'-'+action;
  await fs.writeFile(path.join(output,ident+'.png'),Buffer.from(image.data,'base64'));
  const result={action,target:target.id,state,errors,requests,screenshot:path.join(output,ident+'.png')};
  await fs.writeFile(path.join(output,ident+'.json'),JSON.stringify(result,null,2)+'\n');
  await fs.writeFile(path.join(output,'latest.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}finally{socket.close();}
