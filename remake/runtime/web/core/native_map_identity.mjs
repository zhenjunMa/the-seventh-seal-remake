// Original M-family basenames include letters and mixed -/_ variant tokens:
// m01020a, m03012_1f, m70078-1_1, m71076-1-03 and m72010-0-A.
// Syntax only: content registration still decides which maps may execute.
const MAP_ID=/^M[0-9]{5}[A-Z]?(?:[-_][0-9A-Z]+)*(?![\s\S])/;
export const isNativeMapId=value=>typeof value==='string'&&value.length<=20&&MAP_ID.test(value);
export function nativeMapIdFromFilename(value){
  if(typeof value!=='string'||!value.toUpperCase().endsWith('.DAT'))return null;
  const id=value.slice(0,-4).toUpperCase();
  return isNativeMapId(id)?id:null;
}
