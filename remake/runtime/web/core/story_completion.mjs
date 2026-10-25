// 477330 checks443870(1999,1) only after the ANM has ended and cleaned up.
// True enters419E90(mode2), whose title-menu constructor writes MenuCode=1.
export const STORY_COMPLETION_STORAGE_KEY='seventh-seal-completion-v1';
export const STORY_COMPLETION_EVIDENCE=Object.freeze({
  loop:'ev_a3c99823202f856c11d6855cdede4b7972f15361270681916e593afffba3c072',
  title:'ev_984be626ce676be6adc55cf7a7451d8f4f8a3d8f40dd0b4595eeba3bc5824444',
  menu:'ev_84cfb3ab72117bcb42a8d5c659d9acbc55fbb5617d7b3be8ec2088b1ad2e81b6'
});
export function hasNativeStoryCompletion(world){return Boolean(world?.flags?.[1999]&1);}
export function completionMetadata(value){
  return value?.schema==='seventh-seal-completion'&&value.version===1&&value.menu_code===1
    &&Object.keys(value).sort().join(',')==='menu_code,schema,version'?value:null;
}
export function loadStoryCompletion(storage){try{return completionMetadata(JSON.parse(storage?.getItem(STORY_COMPLETION_STORAGE_KEY)??'null'));}catch{return null;}}
export function saveStoryCompletion(storage){
  const metadata={schema:'seventh-seal-completion',version:1,menu_code:1};let error=null;
  try{storage?.setItem(STORY_COMPLETION_STORAGE_KEY,JSON.stringify(metadata));}catch(failure){error=failure.message;}
  return {metadata,persisted:Boolean(storage)&&error===null,error};
}
