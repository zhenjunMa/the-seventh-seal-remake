// File persistence is supplied by serve.py, independently of browser profiles/ports.
import {decodeSave} from './world.mjs';
import {MANUAL_SAVE_SLOTS,normalizeSaveSlot} from './save_slots.mjs';

const ALL_SAVE_SLOTS=[...MANUAL_SAVE_SLOTS,'quick'];

export function createSaveStorage({fetchImpl=globalThis.fetch}={}) {
  async function request(endpoint,options={},binary=false) {
    let response;
    try { response=await fetchImpl(endpoint,{cache:'no-store',...options}); }
    catch { throw new Error('无法连接本地存档服务，请启动 remake/start.cmd'); }
    if(response.status===404&&!(options.method))return null;
    if(response.ok&&binary)return response.blob();
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
  async function read(slot='00') {
    slot=normalizeSaveSlot(slot);
    const envelope=await request(`/api/saves/${slot}`);
    if(envelope){await decodeSave(envelope);return envelope;}
    return null;
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
    return slots;
  }
  async function decodeFile(file) {
    const envelope=await request('/api/saves/decode',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
    await decodeSave(envelope);
    return envelope;
  }
  function encodeFile(envelope) {
    return request('/api/saves/encode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(envelope)},true);
  }
  return {read,write,list,decodeFile,encodeFile};
}
