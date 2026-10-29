import {NativeServiceView} from '../native_service_view.mjs';
import {readNativeService,nativeEconomyCatalog,nativeServiceRows,nativeOwnedQuantity,applyNativeServiceAction} from '../core/native_economy.mjs';

export function createNativeServicesController({state,actions,$,canvas}){
  let view;
  async function openNativeService({mapId,table,record,draft,playback,signal}){
    const service=readNativeService(record,table),catalog=nativeEconomyCatalog(state.itemData);
    const mode=service.allowedModes[0];
    let selection={mode,category:mode==='forge'?'weapon':mode==='synthesize'?'material':
      service.goods.some(id=>catalog[id].type===2)?'equipment':'items',selected:null,quantity:1,message:''};
    const manifest=await actions.json('data/native_services.json');
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
          materials:item.ingredients.map(id=>({name:catalog[id].name,quantity:1,owned:nativeOwnedQuantity(draft,id)}))}:{};
        view.show({...selection,title:service.title||table.name||mapId,allowedModes:service.allowedModes,money:draft.money,rows,details});
      };
      view=new NativeServiceView({root,manifest,isSuspended:()=>Boolean(state.engine?.paused||playback?.paused),
        onClose:()=>{finish();resolve();},
        onAction:event=>{
          if(event.type==='mode'){selection.mode=event.mode;
            selection.category=event.mode==='forge'?'weapon':event.mode==='synthesize'?'material':
              ['items','equipment'].includes(selection.category)?selection.category:'items';
            selection.selected=null;selection.quantity=1;}
          else if(event.type==='category'){selection.category=event.category;selection.selected=null;selection.quantity=1;}
          else if(event.type==='select'){selection.selected=event.id;selection.quantity=1;}
          else if(event.type==='quantity')selection.quantity=Math.min(99,event.quantity);
          else if(event.type==='confirm'){
            const result=applyNativeServiceAction(draft,service,catalog,{...selection,...event,mapId,recordId:record.id});
            selection.message=result.message;selection.quantity=1;
            state.audio?.playCue(result.changed?'menuConfirm':'menuError');
            actions.log({type:'native-service-action',map_id:mapId,record_id:record.id,mode:selection.mode,...result});
          }
          refresh();
        }});
      signal?.addEventListener('abort',abort,{once:true});refresh();
    });
  }
  function nativeServiceKey(key,repeat){return view?.key(key,repeat)??false;}
  return {openNativeService,nativeServiceKey};
}
