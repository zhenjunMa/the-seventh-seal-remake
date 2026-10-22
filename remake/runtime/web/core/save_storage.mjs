// File persistence is supplied by serve.py, independently of browser profiles/ports.
import {decodeSave} from './world.mjs';
import {MANUAL_SAVE_SLOTS,normalizeSaveSlot} from './save_slots.mjs';

const ALL_SAVE_SLOTS=[...MANUAL_SAVE_SLOTS,'quick'];

export function createSaveStorage({fetchImpl=globalThis.fetch,legacyStorage,legacyKey}={}) {
  async function request(endpoint,options={}) {
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
  async function write(envelope,slot='00',createOnly=false,{expectedSha}={}) {
    slot=normalizeSaveSlot(slot);
    if(expectedSha!==undefined&&!/^[0-9a-f]{64}$/.test(expectedSha))throw new Error('覆盖存档的校验指纹无效');
    await decodeSave(envelope);
    return request(`/api/saves/${slot}`,{method:'PUT',headers:{'Content-Type':'application/json',...(createOnly?{'If-None-Match':'*'}:{}),...(expectedSha?{'If-Match':`"${expectedSha}"`}:{})},body:JSON.stringify(envelope)});
  }
  async function migrateLegacy() {
    let raw;
    try {raw=legacyStorage?.getItem(legacyKey);} catch {return null;}
    if(!raw)return null;
    let legacy;
    try {legacy=JSON.parse(raw);} catch {throw new Error('旧浏览器存档格式无效');}
    // The old single browser slot belongs to 00. Keep the browser copy intact.
    try {await write(legacy,'00',true);}
    catch(error){
      if(error.status!==412)throw error;
      const current=await request('/api/saves/00');
      if(current)await decodeSave(current);
      return current;
    }
    return legacy;
  }
  async function read(slot='00') {
    slot=normalizeSaveSlot(slot);
    const envelope=await request(`/api/saves/${slot}`);
    if(envelope){await decodeSave(envelope);return envelope;}
    return slot==='00'?migrateLegacy():null;
  }
  async function list() {
    const value=await request('/api/saves');
    if(!Array.isArray(value?.slots)||value.slots.length!==ALL_SAVE_SLOTS.length)throw new Error('本地存档列表格式无效');
    const bySlot=new Map(value.slots.map(row=>[row?.slot,row]));
    if(bySlot.size!==ALL_SAVE_SLOTS.length||ALL_SAVE_SLOTS.some(slot=>!bySlot.has(slot)))throw new Error('本地存档列表格式无效');
    const slots=await Promise.all(ALL_SAVE_SLOTS.map(async slot=>{
      const row=bySlot.get(slot);
      if(row.error)return {slot,envelope:null,error:String(row.error)};
      try {
        if(row.envelope!==null&&row.envelope!==undefined)await decodeSave(row.envelope);
        return {slot,envelope:row.envelope??null,error:null};
      } catch(error){return {slot,envelope:null,error:error.message};}
    }));
    if(!slots[0].envelope&&!slots[0].error){
      try {slots[0].envelope=await migrateLegacy();}
      catch(error){slots[0].error=error.message;}
    }
    return slots;
  }
  return {read,write,list};
}
