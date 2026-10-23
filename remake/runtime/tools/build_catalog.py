"""Bind generated runtime maps to the established role atlases."""
from pathlib import Path
import hashlib
import json
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from content_registration import role_ids, definition

RUNTIME = Path(__file__).resolve().parents[1]
WEB = RUNTIME / 'web'
SOURCES = WEB / 'data/source'

def build():
    original = json.loads((SOURCES/'manifest.json').read_text(encoding='utf-8'))
    roles=[]
    for item in original['roles']:
        role={**item,'id':item['id'].replace('ROLE_','')}
        role['actions']=[{**action,'sheet':'/'+action['sheet']} for action in item['actions'] if action['index']<=2]
        roles.append(role)
    resources=json.loads((WEB/'data/chapter_map_resources.json').read_text(encoding='utf-8'))
    for ident in role_ids('player'):
        if not any(role['id']==ident for role in roles):
            role=resources['roles'][ident]
            roles.append(dict(role,id=ident,
                map_draw_offset=dict(x=16-role['anchor']['x'],y=-role['anchor']['y']),
                actions=[dict(action,frames_per_direction=action['frame_count'])
                         for action in role['actions'] if action['index']<=2]))
    maps=[]
    ready=0
    for path in sorted((WEB/'data/maps').glob('*.json')):
        value=json.loads(path.read_text(encoding='utf-8'))
        if value.get('schema')!='seventh-seal-runtime-map': continue
        maps.append(dict(id=value['id'],path=path.relative_to(WEB).as_posix(),sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
        ready+=sum(exit.get('state')=='ready' for exit in value.get('exits',[]))
    assert maps and any(m['id']=='M01010' for m in maps)
    events=[]
    for path in (WEB / name for name in definition().get('story', {}).get('events', [])):
        event=json.loads(path.read_text(encoding='utf-8'))
        if event.get('schema')!='seventh-seal-event':continue
        scene=json.loads((WEB/f"data/maps/{event['map_id'].lower()}.json").read_text(encoding='utf-8'))
        npc=event['npc'];width=scene['movement']['width'];rows=scene['movement']['terrain_rows']
        candidates=[(npc['x']+dx,npc['y']+dy) for dy in (32,16,48,0,-16,-32) for dx in (0,-16,16,-32,32)]
        blocked_triggers={(t['x'],t['y']) for t in scene['movement']['triggers'] if t['path_gate']}
        x,y=next((x,y) for x,y in candidates if 0<=y//16<len(rows) and 0<=x//16<width
                 and rows[y//16][x//16]=='0' and (x//16,y//16) not in blocked_triggers)
        event['sample']=dict(clear_bits=[{'index':v['index'],'bit':v['bit']} for v in event['sample_initial_flags'] if not v['value']],
                             probe=dict(name='侦探 · 交互样本',x=x,y=y,direction=3,
                                        purpose='Development relocation to an open interaction approach cell; not native approach/pathfinding.'),
                             scope=event['sample_initial_flags_scope'])
        events.append(event)
    event_count=len(events)
    (WEB/'data/events.json').write_text(json.dumps(events,ensure_ascii=False,indent=2),encoding='utf-8')
    route=(WEB/'data/route_seed.json').exists()
    catalog=dict(schema='seventh-seal-runtime-catalog',version=1,title='第七封印 · 重制 0.8',
                 seed='data/opening_seed.json',maps=maps,roles=roles,runtime_content='data/runtime_content.json',story='data/story/index.json',
                 opening_program='data/opening_program.json',opening_resources='data/opening_map_resources.json',
                 chapter_story='data/chapter_story.json',chapter_resources='data/chapter_map_resources.json',
                 map_effects='data/map_effects.json',map_shadows='data/map_shadows.json',
                 party_combat='data/party_combat.json',party_skills='data/party_skills.json',
                 party_rewards='data/party_rewards.json',party_reactions='data/party_reactions.json',party_battle_view='data/party_battle_view.json',
                 items='data/items.json',item_presentation='data/item_presentation.json',audio='data/audio.json',operation_menu='data/operation_menu.json',content_checklist='data/content_checklist.json',
                 events='data/events.json' if event_count else None,
                 combat_sample='data/combat_sample.json',battle_view='data/battle_view.json',
                 runtime_config='data/config/index.json',
                 world_map='data/world_map.json',route_events='data/route_events.json',encounters='data/encounters.json',
                 forest_combat='data/forest_combat.json',forest_battle_view='data/enemy_battle_view.json',
                 scope=dict(official_runtime_started=True,ready_exits=ready,source_backed_events=event_count,
                            one_on_one_turn_sample=True,full_combat=False,original_action_queue=True,forest_ai=True,complete_forest_contacts=True,forest_rewards=True,
                            hidden_encounters=route,original_save_compatibility=False,visual_fidelity_pending=True,
                            new_game_initialization=True,opening_prologue=True,opening_story=False,fire_valley_departure=True,new_game_party_combat=True,chapter_complete=False,post_story_route=route,native_groups=route),
                 introduction='新游戏从神殿序章开始，王厅找凯并入队，回住处领取装备，离谷进入白木森林探索与战斗。',
                 boundaries='0.8：新游戏主线、双人森林战斗、物品使用、按人物／部位换装、住处休息、败北电影与主菜单、基础音乐音效和存读档已接入。后续剧情及原版镜头、轨迹、混色、字体的精确对照仍待完善。')
    catalog['scope'].update(item_use=True,equipment_menu=True,home_rest=True,forest_game_over=True,audio=True)
    (WEB/'data/catalog.json').write_text(json.dumps(catalog,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'maps':[m['id'] for m in maps],'ready_exits':ready,'source_backed_events':event_count},ensure_ascii=False))

if __name__=='__main__':build()
