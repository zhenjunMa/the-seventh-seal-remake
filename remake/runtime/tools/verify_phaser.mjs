// Portable preflight: no original game installation or browser package needed.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {BattleResources} from '../web/core/battle_resources.mjs';

const runtime=fileURLToPath(new URL('../',import.meta.url)),web=path.join(runtime,'web');
const args=process.argv.slice(2),strict=args.includes('--assets'),reportAt=args.indexOf('--report');
const report={engine:'Phaser 3.90.0',code:{passed:false,modules:0},assets:{required:0,present:0,missing:[],invalid:[],non_file_hashes:[]},errors:[]};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const resolveUrl=url=>url.startsWith('/prototype/')?path.join(runtime,'../prototype/web',url.slice(11)):path.join(web,url.replace(/^\//,''));
const exists=async file=>{try{return (await fs.stat(file)).isFile();}catch{return false;}};
const inside=(file,root)=>!path.relative(root,file).startsWith('..'+path.sep);
const canonical=url=>url.startsWith('/')?url:'/'+url;
async function files(directory){const result=[];for(const row of await fs.readdir(directory,{withFileTypes:true})){
  const file=path.join(directory,row.name);if(row.isDirectory())result.push(...await files(file));else result.push(file);
}return result;}

try{
  const vendor=path.join(web,'vendor/phaser'),manifest=await readJson(path.join(vendor,'manifest.json'));
  if(manifest.version!=='3.90.0')throw new Error('Phaser 版本未固定为 3.90.0');
  for(const [name,expected]of Object.entries(manifest.files))if(hash(await fs.readFile(path.join(vendor,name)))!==expected)throw new Error(`运行库指纹不符：${name}`);
  const pending=[path.join(web,'app.js'),path.join(web,'phaser/preview.mjs')],modules=new Set();
  while(pending.length){
    const file=pending.pop();if(modules.has(file))continue;modules.add(file);
    const source=await fs.readFile(file,'utf8');
    const checked=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
    if(checked.status!==0)throw new Error(checked.stderr);
    const imports=/\b(?:import|export)\s+(?:[^;'"\n]*?\s+from\s*)?['"]([^'"]+)['"]/g;
    for(const match of source.matchAll(imports)){
      const specifier=match[1];if(!specifier.startsWith('.')&&!specifier.startsWith('/'))throw new Error(`浏览器入口存在未解析包：${specifier}`);
      const target=specifier.startsWith('/')?resolveUrl(specifier):path.resolve(path.dirname(file),specifier);
      if(!inside(target,web)&&!inside(target,path.join(runtime,'../prototype/web')))throw new Error(`模块超出静态挂载：${specifier}`);
      if(!await exists(target))throw new Error(`模块缺失：${target}`);pending.push(target);
    }
  }
  report.code={passed:true,modules:modules.size};
  const assets=new Map();
  function collect(value,parentGeometry=null){
    if(typeof value==='string'){
      if(/^(?:\/?assets\/|\/prototype\/assets\/).+\.(?:png|jpe?g|webp|gif|wav|ogg|mp3|m4a|mp4|webm|woff2?|ttf)$/i.test(value)&&!assets.has(canonical(value)))assets.set(canonical(value),{});
    }else if(value&&typeof value==='object'){
      const geometry=value.frame_width&&value.frame_height?value:parentGeometry;
      const name=value.path??value.image??value.sheet;
      if(typeof name==='string'&&/^(?:\/?assets\/|\/prototype\/assets\/)/.test(name)&&/\.[a-z0-9]+$/i.test(name)){
        const dimensions=value.sheet&&geometry&&value.frame_count
          ?{width:geometry.frame_width*value.frame_count,height:geometry.frame_height*(value.directions??1)}
          :Number.isInteger(value.width)&&Number.isInteger(value.height)?{width:value.width,height:value.height}:{};
        // Legacy descriptors also carry hashes of original DGP bytes or the
        // decoded MNU sensor plane. Neither identifies the exported PNG bytes.
        const hashKind=value.sheet&&value.source?'original-source'
          :value.source_offset!==undefined&&value.value_counts?'decoded-sensor-plane':null;
        if(value.sha256&&hashKind&&!report.assets.non_file_hashes.some(row=>row.path===canonical(name)))
          report.assets.non_file_hashes.push({path:canonical(name),kind:hashKind,sha256:value.sha256});
        const old=assets.get(canonical(name))??{};assets.set(canonical(name),{...old,...(value.sha256&&!hashKind?{sha256:value.sha256}:{}),...dimensions});
      }
      for(const child of Object.values(value))collect(child,geometry);
    }
  }
  const packs=await readJson(path.join(web,'data/battle_packs.json'));
  await new BattleResources({read:async()=>({ok:true,json:async()=>packs})}).catalog();
  report.assets.packed_images=Object.keys(packs.images).length;report.assets.packed_pages=packs.pages.length;
  collect(packs.pages);
  const packedManifests=new Set(Object.keys(packs.manifests));
  for(const file of await files(path.join(web,'data')))if(file.endsWith('.json')){
    const url='/'+path.relative(web,file).split(path.sep).join('/');
    // These manifests resolve logical PNGs through verified atlas pages. The
    // individual source PNGs do not have to ship beside the runtime atlases.
    if(url==='/data/battle_packs.json'||packedManifests.has(url))continue;
    collect(await readJson(file));
  }
  report.assets.required=assets.size;
  for(const [url,descriptor]of assets){
    const file=resolveUrl(url);
    if(!await exists(file)){report.assets.missing.push(url);continue;}
    report.assets.present++;
    const bytes=await fs.readFile(file);
    if(descriptor.sha256&&hash(bytes)!==descriptor.sha256)report.assets.invalid.push({path:url,reason:'SHA-256 不符'});
    if(url.toLowerCase().endsWith('.png')&&descriptor.width&&descriptor.height&&
      (bytes.length<24||bytes.readUInt32BE(16)!==descriptor.width||bytes.readUInt32BE(20)!==descriptor.height))
      report.assets.invalid.push({path:url,reason:'PNG 尺寸与定义不符'});
  }
}catch(error){report.errors.push(error.message);}
report.assets.passed=report.assets.missing.length===0&&report.assets.invalid.length===0;
report.passed=report.code.passed&&report.errors.length===0&&(!strict||report.assets.passed);
if(reportAt!==-1){
  const destination=path.resolve(args[reportAt+1]??'');
  if(!args[reportAt+1]||!inside(destination,path.join(runtime,'evidence')))throw new Error('--report 必须位于 runtime/evidence 内');
  await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify({...report,assets:{...report.assets,missing:report.assets.missing.slice(0,12),missing_count:report.assets.missing.length}},null,2));
process.exitCode=report.passed?0:1;
