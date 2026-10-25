// Source kind5 uses seven 20-byte ASCII C-string fields. Basenames describe
// source files; they do not register a battle stage or a runtime enemy identity.
export const NATIVE_BATTLE_FILENAME_BYTES=20;
const patterns={scn:/^[A-Za-z0-9_-]+\.scn$/i,dgp:/^[A-Za-z0-9_-]+\.dgp$/i};
export function isNativeBattleFilename(value,extension,{allowEmpty=false}={}){
  return typeof value==='string'&&(allowEmpty&&value===''||value.length>0&&value.length<NATIVE_BATTLE_FILENAME_BYTES
    &&Boolean(patterns[extension]?.test(value)));
}
export function isNativeScriptedBattleNames(value){
  return value&&isNativeBattleFilename(value.stage_file,'scn')&&Array.isArray(value.enemy_files)&&value.enemy_files.length===6
    &&value.enemy_files.every(name=>isNativeBattleFilename(name,'dgp',{allowEmpty:true}));
}
