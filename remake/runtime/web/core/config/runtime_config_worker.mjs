import {createRuntimeConfigurationSession,loadRuntimeConfiguration} from './runtime_config.mjs';
import {validateScheduler} from '../battle/battle_scheduler.mjs';
import {validateEnemyAIData} from '../battle/enemy_ai.mjs';
import {validateForestRewards} from '../battle/battle_rewards.mjs';
import {validateItemData} from '../items/items.mjs';
import {imageDefinitionJson} from '../resources/image_catalog.mjs';

self.onmessage=async ({data:{catalog,manifests}})=>{
  try{
    const read=async(path,{cache='no-cache'}={})=>{
      const response=await fetch(new URL(path,new URL('../../',import.meta.url)),{cache});
      if(!response.ok)throw new Error(`资源加载失败：${path}（${response.status}）`);
      return imageDefinitionJson(path,response,manifests);
    };
    const [combat,forest,scheduler,ai,rewards,partySkills,items,sourceSkills,sourceMagic,partyRewards,bundle]=await Promise.all([
      read(catalog.combat_sample??'data/combat_sample.json'),
      read(catalog.forest_combat),
      read('data/battle_scheduler.json').then(validateScheduler),
      read('data/forest_ai.json').then(validateEnemyAIData),
      read('data/forest_rewards.json').then(validateForestRewards),
      read(catalog.party_skills),
      read('data/items.runtime.json').then(validateItemData),
      catalog.source_skills?read(catalog.source_skills):undefined,
      catalog.source_magic?read(catalog.source_magic):undefined,
      read(catalog.party_rewards).then(validateForestRewards),
      loadRuntimeConfiguration(read,catalog.runtime_config??'data/config/index.json'),
    ]);
    const configuration=createRuntimeConfigurationSession({
      combat,forest,scheduler,ai,rewards,party_skills:partySkills,items,
      source_skills:sourceSkills,source_magic:sourceMagic,
    },bundle,partyRewards);
    self.postMessage({value:{
      menu:configuration.menu(),battle:configuration.battle(),sampleBattle:configuration.battle({sample:true}),
      partySkills,partyRewards,initialMoney:rewards.initial_money,
    }});
  }catch(error){self.postMessage({error:error.message});}
};
