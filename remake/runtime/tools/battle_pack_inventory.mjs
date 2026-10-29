// Inventory the existing verified renderer inputs; never reinterpret original DGP data.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {BattleView,selectBattleAssets} from '../web/battle_view.mjs';
import {BattleAssetPlan} from '../web/core/battle_asset_plan.mjs';
import {runtimeContent,runtimeContentDefinition,validateContentRegistration} from '../web/core/content_registry.mjs';
import {readContentDefinition} from './resolve_content_definition.mjs';

const runtime=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const web=path.join(runtime,'web');
const canonical=p=>'/'+p.replace(/^\/+/, '');
const local=p=>path.join(web,p.replace(/^\//,''));
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifests={},assets=new Map();
const args=process.argv.slice(2),planning=args.includes('--plan');
const option=name=>{const at=args.indexOf(name);if(at<0)return null;if(!args[at+1]||args[at+1].startsWith('--'))throw Error(`Missing ${name}`);return args[at+1];};
const roleIds=option('--roles')?.split(','),stageId=option('--stage');
if((roleIds||stageId)&&(!planning||!roleIds||!stageId))throw Error('--roles and --stage require --plan and must be supplied together');
let content,packed;
if(planning){
  content=validateContentRegistration(runtimeContent);
  if(JSON.stringify(JSON.parse(await fs.readFile(path.join(web,'data/runtime_content.json'))))!==JSON.stringify(runtimeContentDefinition))throw Error('Rebuild content registration before planning');
  packed=JSON.parse(await fs.readFile(path.join(web,'data/battle_packs.json')));
  if(roleIds&&(!content.stages[stageId]||!roleIds.length||new Set(roleIds).size!==roleIds.length||roleIds.some(id=>!content.roles[id])))throw Error('Unknown or duplicate battle roles / stage');
}else ({content}=await readContentDefinition());
let selection=null;
async function jsonLoader(p,expected){
  const bytes=await fs.readFile(local(p)),sha256=hash(bytes);
  if(expected&&expected!==sha256)throw Error('Manifest fingerprint mismatch: '+p);
  const value=JSON.parse(bytes);manifests[p]={sha256,value};return structuredClone(value);
}
function add(row){
  const previous=assets.get(row.path);
  if(previous&&(previous.sha256!==row.sha256||previous.width!==row.width||previous.height!==row.height))throw Error('Conflicting image: '+row.path);
  if(previous?.group&&row.group&&previous.group!==row.group)throw Error('Conflicting packing group: '+row.path);
  assets.set(row.path,{...previous,...row,owners:[...new Set([...(previous?.owners??[]),...(row.owners??[])])]});
}
for(const [metadataPath,itemMetadataPath,stageMetadataPath,lifecycleMetadataPath]of [
  ...Object.values(content.stages).map(stage=>['/data/party_battle_view.json','/data/item_presentation.json','/'+stage.path,'/data/battle_lifecycle.json']),
  ['/data/forest_full_battle_view.json',null,'/data/forest_stage.json',null],
  ['/data/enemy_battle_view.json',null,'/data/forest_stage.json',null],
  ['/data/battle_view.json',null,null,null],
]){
  // Keep the frozen four-role forest preview packable alongside the current
  // enemy/party banks. Its scope does not redefine the runtime's live roster.
  const viewContent=metadataPath==='/data/forest_full_battle_view.json'?structuredClone(content):content;
  if(viewContent!==content)viewContent.battle_rosters['forest-source-group']=['001','011','012','013'];
  const view=new BattleView({canvas:{getContext:()=>({})},metadataPath,itemMetadataPath,stageMetadataPath,lifecycleMetadataPath,jsonLoader,content:viewContent,
    assetLoader:async a=>{add(a);return {image:{width:a.width,height:a.height},sha256:a.sha256};}});
  await view.prepare();
  for(const role of view.meta.roles)for(const action of role.actions)add({...assets.get(action.sheet),group:'role-'+role.id,tile_width:role.frame_width,tile_height:role.frame_height});
  for(const role of view.meta.roles)if(role.shadow)add({...assets.get(role.shadow.sheet),group:'role-'+role.id,tile_width:role.shadow.frame_width,tile_height:role.shadow.frame_height});
  for(const effect of view.meta.effects)for(const sheet of effect.layer_order?effect.layer_order.map(layer=>effect[`${layer}_sheet`]):[effect.sheet])
    add({...assets.get(sheet),group:'effect-'+effect.id,tile_width:effect.frame_width,tile_height:effect.frame_height});
  for(const bank of [view.layers,...view.alternateLayers.values()])for(const pair of bank.frames)for(const layer of [pair.main,pair.intrinsic]){
    const p='/'+layer.path;add({...assets.get(p),group:'role-'+bank.role_id,tile_width:bank.frame_width,tile_height:bank.frame_height});
  }
  if(view.stageMeta)for(const asset of view.stageMeta.layers.flatMap(layer=>layer.frames.map(frame=>canonical(frame.path))))
    add({...assets.get(asset),group:'stage-'+view.stageMeta.stage_id});
  if(roleIds&&metadataPath==='/data/party_battle_view.json'&&view.stageMeta?.stage_id===stageId){
    const paths=selectBattleAssets(view.assetDescriptors,roleIds.map(id=>({id}))).map(asset=>asset.path);
    const allEffects=view.meta.effects.flatMap(effect=>effect.layer_order?effect.layer_order.map(layer=>effect[`${layer}_sheet`]):[effect.sheet]);
    const entry=new BattleAssetPlan({meta:view.meta,itemMeta:view.itemMeta,lifecycleMeta:view.lifecycleMeta,
      descriptors:view.assetDescriptors,layers:[view.layers,...view.alternateLayers.values()],actors:roleIds.map(id=>({id})),skills:{},inventory:[]});
    selection={role_ids:roleIds,stage_id:stageId,paths,entry_paths:[...entry.base],legacy_paths:[...new Set([...paths,...allEffects])]};
  }
}
for(const [p,group]of [['/data/battle_ui.json','hud'],['/data/battle_result.json','result']]){
  const manifest=await jsonLoader(p),paths=new Set();
  for(const menu of manifest.menus??[])for(const image of menu.images)paths.add(image.image);
  for(const a of Object.values(manifest.assets))for(const f of a.frames)for(const image of [f.image,f.indexed_image,f.inverse_mask_image,f.render_image].filter(Boolean))paths.add(image);
  for(const image of paths){
    const p=canonical(image);
    const bytes=planning?null:await fs.readFile(local(p)),retained=packed?.images[p];
    if(planning&&!retained)throw Error('Image absent from retained atlas: '+p);
    add({path:p,sha256:retained?.sha256??hash(bytes),width:retained?.width??bytes.readUInt32BE(16),height:retained?.height??bytes.readUInt32BE(20),group,trim:group!=='hud'});
  }
}
for(const row of assets.values()){
  if(!row.group)throw Error('Image has no packing group: '+row.path);
  row.tile_width??=row.width;row.tile_height??=row.height;
}
if(roleIds&&!selection)throw Error('No matching runtime battle view');
process.stdout.write(JSON.stringify({manifests,assets:[...assets.values()],...(selection?{selection}:{})}));
