"""Current four-step delivery checks. Old stage reports are never rewritten."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.request

RUNTIME = Path(__file__).resolve().parents[1]
REMAKE = RUNTIME.parent
ROOT = REMAKE.parent
WEB = RUNTIME/'web'
EVIDENCE = RUNTIME/'evidence'

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def main():
    sources = read(EVIDENCE/'forest_full_skills_export_20261011.json')['source_hashes']
    asset_checks = {}
    source_checks = {}
    def check(path, expected, target):
        key=str(path.relative_to(ROOT)).replace('\\','/')
        if key in target:
            assert target[key]==expected, f'Conflicting {path}'
            return
        assert path.is_file(), f'Missing {path}'
        actual = digest(path)
        assert actual == expected, f'Changed {path}'
        target[key] = actual
    for path, expected in sources.items():
        check(ROOT/path, expected, source_checks)
    def retained_refs(value):
        if isinstance(value, list):
            for row in value:retained_refs(row)
        elif isinstance(value, dict):
            for ref, expected in value.get('source_hashes',{}).items():
                check(ROOT/ref,expected,source_checks)
            expected=value.get('sha256')
            ref=value.get('sheet',value.get('path'))
            if isinstance(ref,str) and isinstance(expected,str) and re.fullmatch('[0-9a-f]{64}',expected):
                if ref.startswith('/prototype/'):path=WEB/ref.removeprefix('/prototype/')
                elif ref.startswith('/'):path=WEB/ref.lstrip('/')
                elif ref.startswith(('assets/','data/')):path=WEB/ref
                elif ref.startswith('evidence/'):path=RUNTIME/ref
                elif ref.startswith('remake/'):path=ROOT/ref
                else:path=ROOT/ref
                check(path,expected,asset_checks if path.is_relative_to(REMAKE) else source_checks)
            for row in value.values():retained_refs(row)
    for name in ['battle_scheduler','forest_ai','forest_rewards','forest_reactions','forest_status','forest_full_battle_view','yantu_layers','xuanying_layers','forest_response_layers']:
        retained_refs(read(WEB/f'data/{name}.json'))
    for report in ['forest_ai_verification_20261011.json','forest_reactions_verification_20261011.json','forest_status_verification_20261011.json']:
        data=read(EVIDENCE/report)
        assert data.get('passed',data.get('success',False)), f'Failed {report}'
    tests=sorted((RUNTIME/'tests').glob('test_*.mjs'))
    command=['node','--import',(RUNTIME/'tests/preserve_history.mjs').as_uri(),'--test','--test-reporter=tap',*map(str,tests)]
    run=subprocess.run(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,encoding='utf-8')
    (EVIDENCE/'forest_combat_recheck_tests.tap').write_text(run.stdout,encoding='utf-8')
    assert run.returncode==0, run.stdout[-12000:]
    count=int(re.search(r'^# tests (\d+)',run.stdout,re.M).group(1))
    assert count>=182
    browser=read(EVIDENCE/'forest_combat_four_steps_browser_log_20261011.json')
    history=browser['battle_history'];assert len(history)==1
    record=history[0];result=record['result'];battle=record['battle']
    assert result['outcome']=='victory' and result['rewards_applied']
    assert battle['phase']=='closed' and len(battle['enemy_ids'])==1
    assert battle['actors'][1]['resource_id']=='013'
    impacts=[e for e in browser['events'] if e['type']=='battle-impact']
    assert impacts and len({(e['action_id'],e['contact_key']) for e in impacts})==len(impacts)
    presentations=[e for e in browser['events'] if e['type']=='battle-presentation']
    assert any(len(e['observations']['intrinsic_source_frames'])==9 for e in presentations)
    assert any(e['type']=='world-map-open' for e in browser['events'])
    assert any(e['type']=='field-encounter' for e in browser['events'])
    assert result['rewards']['experience'][0]['experience']==50
    world=browser['world'];assert len(world['reward_records'])==1
    envelope=read(EVIDENCE/'forest_combat_four_steps_browser_save_20261011.json')
    assert hashlib.sha256(envelope['payload'].encode('utf-8')).hexdigest()==envelope['sha256']
    saved=json.loads(envelope['payload'])
    reload=read(EVIDENCE/'forest_combat_four_steps_browser_reload_20261011.json')
    for key in ['party','inventory','money','reward_records','encounters','location']:
        assert world[key]==saved[key]==reload['world'][key], f'Persistent {key}'
    assert reload['current_battle'] is None and not reload['battle_history']
    assert not any(e['type']=='battle-rewards-planned' for e in reload['events'])
    assert read(EVIDENCE/'forest_combat_four_steps_browser_console_20261011.json')==[]
    http=[]
    for ref in ['app.js','battle_view.mjs','core/combat.mjs','core/battle_scheduler.mjs','core/forest_ai.mjs','core/skill_sequence.mjs','core/battle_rewards.mjs','core/battle_reactions.mjs','core/battle_status.mjs',
                'data/catalog.json','data/forest_full_battle_view.json','data/battle_scheduler.json','data/forest_ai.json','data/forest_rewards.json','data/forest_reactions.json','data/forest_status.json','data/forest_response_layers.json']:
        with urllib.request.urlopen('http://127.0.0.1:8767/'+ref,timeout=10) as response:
            content=response.read();assert response.status==200
        assert hashlib.sha256(content).hexdigest()==digest(WEB/ref), ref
        http.append(ref)
    fingerprints={}
    paths=[*WEB.glob('*.js'),*WEB.glob('*.mjs'),*WEB.glob('*.html'),*WEB.glob('*.css'),*WEB.glob('core/*.mjs'),*WEB.glob('data/*.json'),*RUNTIME.glob('tools/export_battle_scheduler.py'),*RUNTIME.glob('tools/*forest*.py'),RUNTIME/'tools/build_catalog.py',RUNTIME/'tests/native_assembly_oracle.mjs',RUNTIME/'tests/preserve_history.mjs',WEB/'core/movement.mjs',*tests,
           ROOT/'README.md',RUNTIME/'README.md',REMAKE/'assessment/validation_design.md',REMAKE/'assessment/testing_strategy.md']
    paths+=list(EVIDENCE.glob('forest_combat_four_steps_browser*'))
    for path in paths:fingerprints[str(path.relative_to(ROOT)).replace('\\','/')]=digest(path)
    report={'schema':'seventh-seal-forest-four-step-delivery','version':1,'passed':True,'tests':count,'http_checks':http,'source_hashes':source_checks,'assets_checked':len(asset_checks),'asset_hashes':asset_checks,'current_fingerprints':fingerprints,
            'browser':{'source':'Actual remake UI on localhost; no GAME.exe execution','fixture_seed':13391,'enemy_ids':['013'],'actions':result['actions'],'contacts':len(impacts),'outcome':result['outcome'],'rewards':result['rewards'],'reload_no_reaward':True},
            'limits':['One historical player; two exposed player skills and six learned forest skills.','Paused command boundary; preview Canvas/OS clocks and trajectories.','F68E allocated zero; role-load overwrite not verified.','Grounded reactions only; skill proficiency, opening story and full party not restored.']}
    (EVIDENCE/'forest_combat_recheck_delivery.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    lines=['第七封印 · 0.4森林战斗四步完成验收','核对日期：2026-10-11','',f'结论：当前森林片段四项均已接入；{count}项测试全过，{len(http)}个HTTP源码／数据加载校验，{len(asset_checks)}个来源／资产引用指纹核对。','',
           '行动顺序与充能：原mode0／20ms单tick／raw速度阈值／准备债务／阵营优先；选指令时暂停。',
           '敌方选招与目标：三森林敌各两招、原权重／后备／3～5招组合、重复技能和原目标门控，保留原RNG顺序。',
           '完整技能结算：八招全部原记录与接触；受击／格挡／闪避／反击、限时status43、死亡中断／尸体门控／死亡选择。',
           '战后奖励：原EXP、金钱槽、掉落／连击修正、原物品堆叠和升级；资源＋奖励记录一笔提交，重复返回和存档重载不重复抽签或发奖。','',
           f'实际浏览器：火之谷原出口→大地图→白木森林→移动抽签产生013→{result["actions"]}次行动／{len(impacts)}接触→胜利→返回→保存→重载。',
           '测试存档只指定counter40与开发LCG seed13391，原角色／装备／技能未改；原概率／组成代码执行，不注入敌组。',
           '奖励：'+json.dumps(result['rewards'],ensure_ascii=False),
           '持久化：角色rawHP／MP／经验、inventory、money、reward_records和encounters与导出存档／重载一致；重载无奖励重发；控制台warning/error为0。','',
           '证据：runtime/evidence/forest_combat_four_steps_delivery_20261011.json、同名前缀browser日志／save／reload／console／PNG、tests TAP。',
           '原静态证据：forest_scheduler、forest_skill_pipeline、forest_ai、forest_reactions、forest_death_reactions、forest_status、forest_rewards各native bundle／snapshot；不是原作执行。',
           '原输入SHA一致；旧119项回归报告写回由preserve_history屏蔽，日期型报告保留各自时点。','',
           '边界：一名历史玩家、两玩家招与六森林敌招；命令边界暂停、65ms Canvas预览／轨迹／混色未逐项原版对齐；空中／特殊反应、其他状态、完整队伍、技能熟练度与新游戏开场待恢复。',
           'F68E按已证分配memset=0；角色载入是否另覆盖仍未核定。grounded死亡最终化采用20ms更新与序列收尾，原空中占用生命周期未完整还原。',
           '下一步：火之谷新游戏初值、王厅／住处ANM、装备／入队与真实主线，继续同条件原版运行对照。',
           '复做：python -B remake/runtime/tools/verify_forest_combat.py；启动与导出命令见runtime/README.md。']
    (EVIDENCE/'forest_combat_recheck.txt').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    print(json.dumps({'passed':True,'tests':count,'http':len(http),'assets_checked':len(asset_checks),'sources_checked':len(source_checks),'browser_outcome':result['outcome']},ensure_ascii=False))

if __name__=='__main__':main()
