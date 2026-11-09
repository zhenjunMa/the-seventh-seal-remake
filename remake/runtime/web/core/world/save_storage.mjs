// File persistence is supplied by serve.py, independently of browser profiles/ports.
import {decodeSave} from './world.mjs';
import {MANUAL_SAVE_SLOTS,normalizeSaveSlot} from './save_slots.mjs';

const ALL_SAVE_SLOTS=[...MANUAL_SAVE_SLOTS,'quick'];

export function createSaveStorage({fetchImpl=globalThis.fetch}={}) {
  async function request(endpoint,options={},binary=false) {
    let response;
    try { response=await fetchImpl(endpoint,{cache:'no-store',...options}); }
    catch { throw new Error('无法连接本地存档服务，请从仓库根目录运行 python -B remake/runtime/serve.py'); }
    if(response.status===404&&!(options.method))return null;
    if(response.ok&&binary)return response.blob();
    let value;
    try { value=await response.json(); }
    catch { throw new Error('本地存档服务不可用，请重启 Python 游戏服务'); }
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
    if(value.slots.some(row=>!Object.hasOwn(row,'summary')))throw new Error('本地存档列表格式无效，请重启游戏服务');
    return ALL_SAVE_SLOTS.map(slot=>{
      const row=bySlot.get(slot);
      if(row.error)return {slot,summary:null,error:String(row.error)};
      try {
        const summary=row.summary??null;
        if(summary!==null&&(summary.schema!=='seventh-seal-save-summary'||summary.version!==1
          ||!/^[0-9a-f]{64}$/.test(summary.sha256)||!Array.isArray(summary.party)||summary.party.length<1||summary.party.length>10
          ||summary.party.some(role=>typeof role?.name!=='string'||role.name.length>20)
          ||typeof summary.location?.map_id!=='string'||!summary.location.map_id||summary.location.map_id.length>20
          ||summary.location.map_name!==undefined&&(typeof summary.location.map_name!=='string'||summary.location.map_name.length>20)
          ||!Number.isSafeInteger(summary.play_time_ms)||summary.play_time_ms<0))throw new Error('存档摘要格式无效');
        return {slot,summary,error:null};
      } catch(error){return {slot,summary:null,error:error.message};}
    });
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
