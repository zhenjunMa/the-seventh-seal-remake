// Inventory the existing verified renderer inputs; never reinterpret original DGP data.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {BattleView} from '../web/battle_view.mjs';
import {readContentDefinition} from './resolve_content_definition.mjs';

const runtime=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const web=path.join(runtime,'web'),prototype=path.resolve(runtime,'../prototype/web');
const canonical=p=>'/'+p.replace(/^\/+/, '');
const local=p=>p.startsWith('/prototype/')?path.join(prototype,p.slice(11)):path.join(web,p.replace(/^\//,''));
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifests={},assets=new Map();
const {content}=await readContentDefinition();
async function jsonLoader(p,expected){
  const bytes=await fs.readFile(local(p)),sha256=hash(bytes);
  if(expected&&expected!==sha256)throw Error('Manifest fingerprint mismatch: '+p);
  const value=JSON.parse(bytes);manifests[p]={sha256,value};return structuredClone(value);
}
function add(row){
  const previous=assets.get(row.path);
  if(previous&&(previous.sha256!==row.sha256||previous.width!==row.width||previous.height!==row.height))throw Error('Conflicting image: '+row.path);
  assets.set(row.path,{...previous,...row});
}
for(const [metadataPath,itemMetadataPath,stageMetadataPath,lifecycleMetadataPath]of [
  ...Object.values(content.stages).map(stage=>['/data/party_battle_view.json','/data/item_presentation.json','/'+stage.path,'/data/battle_lifecycle.json']),
  ['/data/forest_full_battle_view.json',null,'/data/forest_stage.json',null],
  ['/data/enemy_battle_view.json',null,'/data/forest_stage.json',null],
  ['/data/battle_view.json',null,null,null],
]){
  const view=new BattleView({canvas:{getContext:()=>({})},metadataPath,itemMetadataPath,stageMetadataPath,lifecycleMetadataPath,jsonLoader,content,
    assetLoader:async a=>{add(a);return {image:{width:a.width,height:a.height},sha256:a.sha256};}});
  await view.prepare();
  for(const role of view.meta.roles)for(const action of role.actions)add({...assets.get(action.sheet),group:'role-'+role.id,tile_width:role.frame_width,tile_height:role.frame_height});
  for(const effect of view.meta.effects)add({...assets.get(effect.sheet),group:'effects',tile_width:effect.frame_width,tile_height:effect.frame_height});
  for(const bank of [view.layers,...view.alternateLayers.values()])for(const pair of bank.frames)for(const layer of [pair.main,pair.intrinsic]){
    const p='/'+layer.path;add({...assets.get(p),group:'role-'+bank.role_id,tile_width:bank.frame_width,tile_height:bank.frame_height});
  }
}
for(const [p,group]of [['/data/battle_ui.json','hud'],['/data/battle_result.json','result']]){
  const manifest=await jsonLoader(p),paths=new Set();
  for(const menu of manifest.menus??[])for(const image of menu.images)paths.add(image.image);
  for(const a of Object.values(manifest.assets))for(const f of a.frames)for(const image of [f.image,f.indexed_image,f.inverse_mask_image,f.render_image].filter(Boolean))paths.add(image);
  for(const image of paths){const p=canonical(image),bytes=await fs.readFile(local(p));add({path:p,sha256:hash(bytes),width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),group,trim:group!=='hud'});}
}
for(const row of assets.values()){
  row.group??=row.path.includes('skill_test_stage')?'test-stage':'forest-stage';
  row.tile_width??=row.width;row.tile_height??=row.height;
}
process.stdout.write(JSON.stringify({manifests,assets:[...assets.values()]}));
