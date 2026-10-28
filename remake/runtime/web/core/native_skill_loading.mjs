// GAME.exe4FED00: file shortcut codes are not the gameplay skill table.
// TLK battle entry461ED0 ->4451C0 writes00679C6C=0 before loading CHR.
// Keep immutable source records intact; derive only the loaded +19 bytes.
export const NATIVE_SKILL_CODE_LOAD_EVIDENCE=Object.freeze({
  loader:'ev_91829d81647dd58b8d0c9c429f56872bf8ca260c7edecfd49abc0939481989f3',
  gameplay_mode_write:'ev_b65c4a01e0d0dd0e29afe1585765ff91302ce20d20660c204cb5290f958de608',
  instruction_range:'0x4ff029..0x4ff0b6',global_mode:'0x00679c6c'
});
// Source hex strings are immutable cache keys. Replacing configured bytes gets
// a fresh decode; reusing a skill never reparses its entire 0x41d-byte record.
const selectionFields=new Map();
export function nativeSkillSelectionFields(skill){
  const raw=skill?.fixed_raw_hex,cached=selectionFields.get(raw);if(cached)return cached;
  if(typeof raw!=='string'||!/^(?:[0-9a-f]{2}){1053}$/i.test(raw))throw new TypeError('Native skill load requires original fixed bytes');
  const byte=offset=>parseInt(raw.slice(offset*2,offset*2+2),16);
  const fields=Object.freeze({code:byte(0x19),learned:byte(0x23),target_side:byte(0x25),weight:byte(0x27),
    flags:(byte(0x32)|byte(0x33)<<8|byte(0x34)<<16|byte(0x35)<<24)>>>0});
  if(selectionFields.size>=1024)selectionFields.clear();selectionFields.set(raw,fields);return fields;
}
export function nativeLoadedSkillCodes(skills,{modeRaw=0}={}){
  if(!Array.isArray(skills)||skills.length>200)throw new TypeError('Invalid native loaded skill table');
  if(!Number.isInteger(modeRaw)||modeRaw<0||modeRaw>0xffffffff)throw new TypeError('Invalid native skill load mode');
  let next=0x61;
  return skills.map(skill=>{
    const {code,flags}=nativeSkillSelectionFields(skill);
    if(modeRaw!==0)return code;
    if((flags&15)===0||((flags>>>8)&1)===0)return 0;
    if(next>=0x7a)next=0x41;
    return next++;
  });
}
