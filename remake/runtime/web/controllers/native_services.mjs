import {NativeServiceView} from '../native_service_view.mjs';
import {NativeCodeView} from '../native_code_view.mjs';
import {NativeSmallLottoView} from '../native_small_lotto_view.mjs';
import {NativeRouletteView} from '../native_roulette_view.mjs';
import {NativeLottoView} from '../native_lotto_view.mjs';
import {NativeStatueView} from '../native_statue_view.mjs';
import {readNativeService,nativeEconomyCatalog,nativeServiceRows,nativeOwnedQuantity,applyNativeServiceAction} from '../core/items/native_economy.mjs';
import {readNativeSpecialService,applyNativeStatue,applyNativeCasinoCode,playNativeSmallLotto,playNativeRoulette,playNativeLotto,drawNativeLottoNumbers,nativeLottoTickets,revealNativeLottoCard} from '../core/items/native_special_services.mjs';
import {operationItemCard} from '../core/ui/operation_menu.mjs';

export function createNativeServicesController({state,actions,$,canvas}){
  let view;
  async function openNativeService({mapId,table,record,draft,playback,signal}){
    if(record.mutation_type===18)return openSpecialService({mapId,record,draft,playback,signal});
    const service=readNativeService(record,table),catalog=nativeEconomyCatalog(state.itemData);
    const mode=service.allowedModes[0];
    let selection={mode,category:mode==='forge'?'weapon':mode==='synthesize'?'material':
      service.goods.some(id=>catalog[id].type===2)?'equipment':'items',filterIndex:0,selected:null,message:'',clearInfo:false};
    const manifest=await actions.json('data/native_services.json');
    const operationMenu=state.operationMenu;
    if(playback?.paused)await playback.ready();signal?.throwIfAborted();
    const root=document.createElement('div');$('screen').append(root);
    return new Promise((resolve,reject)=>{
      const finish=()=>{signal?.removeEventListener('abort',abort);view.dispose();root.remove();view=null;state.keys.clear();canvas.focus({preventScroll:true});};
      const abort=()=>{finish();reject(signal.reason);};
      const refresh=()=>{
        const rows=nativeServiceRows(service,draft,catalog,selection);
        const selected=rows.find(row=>row.id===selection.selected)??rows[0];selection.selected=selected?.id??null;
        const item=selected?catalog[selected.item_id]:null;
        const details=item?{name:item.name,description:item.description,owned:nativeOwnedQuantity(draft,item.id),
          card:operationMenu?.manifest?operationItemCard(item,operationMenu.manifest):null,
          materials:item.ingredients.map(id=>({name:catalog[id].name,quantity:1,owned:nativeOwnedQuantity(draft,id)}))}:{};
        view.show({...selection,title:table.name||mapId,allowedModes:service.allowedModes,money:draft.money,rows,details});
      };
      view=new NativeServiceView({root,manifest,textRenderer:operationMenu?.textRenderer,
        isSuspended:()=>Boolean(state.engine?.paused||playback?.paused),
        onSelect:()=>state.audio?.playCue('menuSelect'),
        onClose:()=>{finish();resolve();},
        onAction:event=>{
          if(['mode','category','filter','select'].includes(event.type)){
            selection.message='';
            selection.clearInfo=false;
          }
          if(event.type==='mode'){selection.mode=event.mode;
            const category=event.mode==='forge'?'weapon':event.mode==='synthesize'?'material':
              ['items','equipment'].includes(selection.category)?selection.category:'items';
            if(category!==selection.category)selection.filterIndex=0;
            selection.category=category;
            selection.selected=null;}
          else if(event.type==='category'){
            if(event.category!==selection.category){
              selection.filterIndex=0;
              if(['items','equipment'].includes(event.category)&&service.allowedModes.includes('buy'))selection.mode='buy';
            }
            selection.category=event.category;selection.selected=null;
          }
          else if(event.type==='filter'){selection.filterIndex=event.index;selection.selected=null;}
          else if(event.type==='select')selection.selected=event.id;
          else if(event.type==='confirm'){
            const result=applyNativeServiceAction(draft,service,catalog,{...selection,...event,mapId,recordId:record.id});
            selection.clearInfo=result.changed&&['buy','sell'].includes(selection.mode);
            selection.message=selection.clearInfo?'':result.message;
            state.audio?.playCue(result.changed?'menuConfirm':'menuError');
            actions.log({type:'native-service-action',map_id:mapId,record_id:record.id,mode:selection.mode,...result});
          }
          refresh();
        }});
      signal?.addEventListener('abort',abort,{once:true});refresh();
    });
  }
  function serviceSounds(manifest){
    const aliases={ballclick:'ballClick',rotate_step:'rotateClick'};
    const clip=name=>manifest.sounds?.[aliases[name]??name]?.clip;
    return {
      onSound(name,settings={}){
        const id=clip(name);if(!id)return false;
        if(!settings.loop&&settings.restart!==false)state.audio?.stopClip(id);
        return state.audio?.playClip(id,null,{singleVoice:true,...settings});
      },
      onStopSound(name){const id=clip(name);if(id)state.audio?.stopClip(id);},
      dispose(){for(const row of Object.values(manifest.sounds??{}))if(row.clip)state.audio?.stopClip(row.clip);}
    };
  }
  async function openSpecialService({mapId,record,draft,playback,signal}){
    const service=readNativeSpecialService(record),manifest=await actions.json('data/native_services.json');
    if(service.mode===2)return openStatue({mapId,record,draft,playback,signal,service,manifest});
    if(service.mode===5)return openCode({mapId,record,draft,playback,signal,manifest});
    if(playback?.paused)await playback.ready();signal?.throwIfAborted();
    const root=document.createElement('div');$('screen').append(root);
    const mode=service.mode,art=manifest.special[{0:'lotto',3:'smallLotto',4:'roulette'}[mode]],sounds=serviceSounds(art);
    const options={definitions:state.itemData.definitions,sourceHashes:state.itemData.source_hashes,mapId,recordId:record.id};
    let closed=false,pendingPrize=0,multiplier=1,lottoBalance=draft.money,result=null;
    const numbers=new Set(),bets=Array(35).fill(0);
    return new Promise((resolve,reject)=>{
      const finish=error=>{
        if(closed)return;closed=true;signal?.removeEventListener('abort',abort);
        // SLotto's money42 omits its unaccepted money46 prize. Rotate instead
        // synchronizes both balances at4EDAFD..4EDB18, so its winnings persist.
        if(!error&&mode===3&&pendingPrize)draft.money=(draft.money-pendingPrize)>>>0;
        if(!error&&mode===4&&view?.phase==='choose')draft.money=(draft.money-bets.reduce((sum,n)=>sum+n,0)*50)>>>0;
        view?.dispose();sounds.dispose();root.remove();view=null;state.keys.clear();canvas.focus({preventScroll:true});
        if(error)reject(error);else resolve();
      };
      const abort=()=>finish(signal.reason);
      const show=()=>view.show({money:mode===0?lottoBalance:draft.money,pendingPrize,multiplier,numbers:[...numbers],bets:[...bets],result});
      const required=()=>(numbers.size?Math.max(1,nativeLottoTickets(numbers.size)):0)*50*multiplier;
      const onAction=event=>{
        try{
          signal?.throwIfAborted();playback?.check();
          if(event.choice==='collect'){
            pendingPrize=0;if(event.resetBets)bets.fill(0);result=null;show();return;
          }
          if(event.choice==='continue'){
            numbers.clear();bets.fill(0);multiplier=1;pendingPrize=0;result=null;show();return;
          }
          if(mode===4&&event.choice.startsWith('bet:')){
            const index=Number(event.choice.slice(4));
            if(!Number.isInteger(index)||index<0||index>=35)throw new Error('转轮下注位置无效');
            const before=bets[index];bets[index]=Math.max(0,Math.min(99,before+(event.delta??1)));
            if(bets.reduce((sum,n)=>sum+n,0)*50>draft.money)bets[index]=before;
            show();return;
          }
          if(event.choice==='clear'){numbers.clear();bets.fill(0);multiplier=1;show();return;}
          if(mode===0){
            if(event.choice==='multiplier'){
              const before=multiplier,value=Number(event.value);
              if(numbers.size<=6&&Number.isSafeInteger(value)&&value>=1){multiplier=value;if(required()>lottoBalance)multiplier=before;}
              show();return;
            }
            if(event.choice.startsWith('number:')){
              const number=Number(event.choice.slice(7));
              if(!Number.isInteger(number)||number<1||number>42)throw new Error('乐透选号位置无效');
              const existed=numbers.has(number);if(existed)numbers.delete(number);else numbers.add(number);
              if(numbers.size>6)multiplier=1;
              if(required()>lottoBalance){if(existed)numbers.add(number);else numbers.delete(number);}
              show();return;
            }
            if(event.choice==='random'){
              numbers.clear();multiplier=1;for(const number of drawNativeLottoNumbers(draft))numbers.add(number);show();return;
            }
            if(event.choice==='reveal'){
              if(result?.remainingCards>0){
                result.card=revealNativeLottoCard(draft,options);result.remainingCards--;
                actions.log({type:'native-lotto-card',map_id:mapId,record_id:record.id,...result.card,remaining:result.remainingCards});
              }
              show();return;
            }
          }
          if(event.choice!=='play')return;
          const worldMoney=draft.money;
          if(mode===0)draft.money=lottoBalance;
          try{
            result=mode===3?playNativeSmallLotto(draft):mode===4?playNativeRoulette(draft,bets):
              playNativeLotto(draft,[...numbers],multiplier,{...options,deferRewards:true});
            if(mode===0)lottoBalance=draft.money;
          }finally{if(mode===0)draft.money=worldMoney;}
          if(result.changed&&(mode===3||mode===4))pendingPrize=result.prize;
          actions.log({type:'native-special-service-action',map_id:mapId,record_id:record.id,mode,...result});
          show();
        }catch(error){finish(error);}
      };
      const View={0:NativeLottoView,3:NativeSmallLottoView,4:NativeRouletteView}[mode];
      signal?.addEventListener('abort',abort,{once:true});
      try{view=new View({root,manifest:art,cursor:art.cursor,isSuspended:()=>Boolean(state.engine?.paused||playback?.paused),
        onClose:()=>finish(),onAction,...sounds});show();}catch(error){finish(error);}
    });
  }

  async function openCode({mapId,record,draft,playback,signal,manifest}){
    if(playback?.paused)await playback.ready();signal?.throwIfAborted();
    const root=document.createElement('div');$('screen').append(root);
    const options={definitions:state.itemData.definitions,sourceHashes:state.itemData.source_hashes,mapId,recordId:record.id};
    const art=manifest.special.code,sounds=serviceSounds(art);let closed=false,codeView;
    return new Promise((resolve,reject)=>{
      const closeView=()=>{codeView?.dispose();sounds.dispose();root.remove();if(view===codeView)view=null;state.keys.clear();canvas.focus({preventScroll:true});};
      const finish=error=>{if(closed)return;closed=true;signal?.removeEventListener('abort',abort);closeView();if(error)reject(error);else resolve();};
      const abort=()=>finish(signal.reason);signal?.addEventListener('abort',abort,{once:true});
      try{
        codeView=new NativeCodeView({root,manifest:art,isSuspended:()=>Boolean(state.engine?.paused||playback?.paused),
          ...sounds,onClose:()=>finish(),onSubmit:async({text})=>{
            try{
              signal?.throwIfAborted();playback?.check();
              const result=applyNativeCasinoCode(draft,text,options);
              actions.log({type:'native-special-service-action',map_id:mapId,record_id:record.id,mode:5,...result});
              if(!result.matched){codeView.resume();return;}
              closeView();
              if(!result.already_claimed){
                await actions.say('',result.message,0,{mapId,signal,
                  record:{kind:0,style:0,speaker:0,portrait_id:0,region_byte_raw:0}});
                playback?.check();signal?.throwIfAborted();
              }
              finish();
            }catch(error){finish(error);}
          }});view=codeView;
      }catch(error){finish(error);}
    });
  }

  async function openStatue({mapId,record,draft,playback,signal,service,manifest}){
    if(playback?.paused)await playback.ready();signal?.throwIfAborted();
    const root=document.createElement('div');$('screen').append(root);
    const options={definitions:state.itemData.definitions,sourceHashes:state.itemData.source_hashes,mapId,recordId:record.id};
    const clips={click:'sound/WordDisc/click.wav',rotateClick:'sound/WordDisc/RollClick.wav',
      page:'sound/WordDisc/Page.wav',roll:'sound/WordDisc/Roll.wav'};
    let closed=false,statueView;
    return new Promise((resolve,reject)=>{
      const closeView=()=>{
        statueView?.dispose();root.remove();if(view===statueView)view=null;
        state.keys.clear();canvas.focus({preventScroll:true});
      };
      const finish=error=>{
        if(closed)return;closed=true;signal?.removeEventListener('abort',abort);closeView();
        if(error)reject(error);else resolve();
      };
      const abort=()=>finish(signal.reason);
      signal?.addEventListener('abort',abort,{once:true});
      try{
        statueView=new NativeStatueView({root,manifest:manifest.special.statue,statueIndex:service.index,
          isSuspended:()=>Boolean(state.engine?.paused||playback?.paused),
          onSound:(name,settings)=>{
            if(name!=='roll')state.audio?.stopClip(clips[name]);
            return state.audio?.playClip(clips[name],null,settings);
          },
          onStopSound:name=>state.audio?.stopClip(clips[name]),onClose:()=>finish(),
          onSubmit:async({symbols})=>{
            try{
              signal?.throwIfAborted();playback?.check();
              const result=applyNativeStatue(draft,service,symbols,options);
              actions.log({type:'native-special-service-action',map_id:mapId,record_id:record.id,mode:2,...result});
              if(!result.matched){statueView.resume();return;}
              closeView();
              if(!result.already_claimed){
                // Native41A81F ->467B70 builds a zeroed, ordinary TLK style0
                // record. Reuse MessageBoard/MessageWait1 and its two-stage
                // typing/advance input; no extra modal title or OK button.
                await actions.say('',result.message,0,{mapId,signal,
                  record:{kind:0,style:0,speaker:0,portrait_id:0,region_byte_raw:0}});
                playback?.check();signal?.throwIfAborted();
              }
              finish();
            }catch(error){finish(error);}
          }});
        view=statueView;
      }catch(error){finish(error);}
    });
  }
  function nativeServiceKey(key,repeat){return view?.key(key,repeat)??false;}
  return {openNativeService,nativeServiceKey};
}
