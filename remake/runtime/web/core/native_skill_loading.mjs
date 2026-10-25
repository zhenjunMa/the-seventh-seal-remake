// GAME.exe4FED00: file shortcut codes are not the gameplay skill table.
// TLK battle entry461ED0 ->4451C0 writes00679C6C=0 before loading CHR.
// Keep immutable source records intact; derive only the loaded +19 bytes.
export const NATIVE_SKILL_CODE_LOAD_EVIDENCE=Object.freeze({
  loader:'ev_91829d81647dd58b8d0c9c429f56872bf8ca260c7edecfd49abc0939481989f3',
  gameplay_mode_write:'ev_b65c4a01e0d0dd0e29afe1585765ff91302ce20d20660c204cb5290f958de608',
  instruction_range:'0x4ff029..0x4ff0b6',global_mode:'0x00679c6c'
});
export function nativeLoadedSkillCodes(skills,{modeRaw=0}={}){
  if(!Array.isArray(skills)||skills.length>200)throw new TypeError('Invalid native loaded skill table');
  if(!Number.isInteger(modeRaw)||modeRaw<0||modeRaw>0xffffffff)throw new TypeError('Invalid native skill load mode');
  let next=0x61;
  return skills.map(skill=>{
    if(!/^(?:[0-9a-f]{2}){1053}$/i.test(skill?.fixed_raw_hex??''))throw new TypeError('Native skill load requires original fixed bytes');
    const raw=Uint8Array.from(skill.fixed_raw_hex.match(/../g),h=>parseInt(h,16)),view=new DataView(raw.buffer);
    if(modeRaw!==0)return raw[0x19];
    const flags=view.getUint32(0x32,true);
    if((flags&15)===0||((flags>>>8)&1)===0)return 0;
    if(next>=0x7a)next=0x41;
    return next++;
  });
}
