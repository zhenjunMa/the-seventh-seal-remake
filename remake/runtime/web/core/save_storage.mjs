// File persistence is supplied by serve.py, independently of browser profiles/ports.
import {decodeSave} from './world.mjs';

export function createSaveStorage({fetchImpl=globalThis.fetch,legacyStorage,legacyKey}={}) {
  function url(slot) {
    if(!['manual','quick'].includes(slot))throw new Error('存档槽不存在');
    return `/api/saves/${slot}`;
  }
  async function request(slot,options={}) {
    const endpoint=url(slot);
    let response;
    try { response=await fetchImpl(endpoint,{cache:'no-store',...options}); }
    catch { throw new Error('无法连接本地存档服务，请启动 remake/start.cmd'); }
    if(response.status===404&&!(options.method))return null;
    let value;
    try { value=await response.json(); }
    catch { throw new Error('本地存档服务不可用，请重启 remake/start.cmd'); }
    if(!response.ok){const error=new Error(value.error??`存档操作失败（${response.status}）`);error.status=response.status;throw error;}
    return value;
  }
  async function write(envelope,slot='manual',createOnly=false) {
    await decodeSave(envelope);
    return request(slot,{method:'PUT',headers:{'Content-Type':'application/json',...(createOnly?{'If-None-Match':'*'}:{})},body:JSON.stringify(envelope)});
  }
  async function read(slot='manual') {
    const envelope=await request(slot);
    if(envelope){await decodeSave(envelope);return envelope;}
    if(slot!=='manual')return null;
    let raw;
    try {raw=legacyStorage?.getItem(legacyKey);} catch {return null;}
    if(!raw)return null;
    let legacy;
    try {legacy=JSON.parse(raw);} catch {throw new Error('旧浏览器存档格式无效');}
    // Migrate only to an empty manual slot. Keep the browser copy intact.
    try {await write(legacy,slot,true);}
    catch(error){if(error.status===412)return read(slot);throw error;}
    return legacy;
  }
  return {read,write};
}
