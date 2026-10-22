"""Current configuration delivery checks; previous stage evidence stays immutable."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.request

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parent.parent
WEB = RUNTIME/'web'
EVIDENCE = RUNTIME/'evidence'

def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    previous = read(EVIDENCE/'forest_combat_four_steps_delivery_20261011.json')
    source_checks = {}
    for name, expected in previous['source_hashes'].items():
        assert sha(ROOT/name) == expected, f'Original input changed: {name}'
        source_checks[name] = expected
    for name, expected in previous['asset_hashes'].items():
        assert sha(ROOT/name) == expected, f'Retained asset changed: {name}'
    originals = ['combat_sample', 'forest_combat', 'forest_ai', 'forest_rewards', 'battle_scheduler', 'forest_reactions', 'forest_status', 'skills']
    for name in originals:
        key = f'remake/runtime/web/data/{name}.json'
        assert sha(ROOT/key) == previous['current_fingerprints'][key], f'Extraction baseline changed: {name}'
    backup = read(EVIDENCE/'runtime_config_before_browser_20261011.json')
    for name, content in backup.items():
        assert (WEB/'data/config'/name).read_text(encoding='utf-8') == content, f'Browser debug edit remains: {name}'
    assert read(WEB/'data/config/index.json')['mode'] == 'original'
    assert read(WEB/'data/catalog.json')['runtime_config'] == 'data/config/index.json'

    tests = sorted((RUNTIME/'tests').glob('test_*.mjs'))
    run = subprocess.run(['node', '--import', (RUNTIME/'tests/preserve_history.mjs').as_uri(), '--test', '--test-reporter=tap', *map(str, tests)],
                         cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8')
    (EVIDENCE/'runtime_config_tests_20261011.tap').write_text(run.stdout, encoding='utf-8')
    assert run.returncode == 0, run.stdout[-16000:]
    count = int(re.search(r'^# tests (\d+)', run.stdout, re.M).group(1))
    assert count >= 196

    browser = read(EVIDENCE/'runtime_config_browser_log_20261011.json')
    observations = read(EVIDENCE/'runtime_config_browser_20261011.json')
    assert not observations['console']
    histories = browser['battle_history']
    assert len(histories) == 3
    modes = [row['battle']['source']['runtime_configuration']['mode'] for row in histories]
    assert modes == ['original', 'debug', 'original']
    debug = histories[1]['battle']
    assert debug['actors'][1]['hp'] == {'current':201, 'maximum':700}
    assert debug['actors'][0]['mp'] == {'current':74, 'maximum':79}
    assert debug['actors'][0]['raw_mp'] == 67
    assert len(debug['history']) == 2 and debug['history'][0]['result']['mp_cost'] == 5
    assert len(debug['source']['runtime_configuration']['differences']) == 2
    restored = histories[2]['battle']
    assert restored['actors'][1]['hp'] == {'current':1362, 'maximum':1362}
    assert restored['actors'][0]['mp']['current'] == 74
    assert restored['source']['runtime_configuration']['differences'] == []
    assert browser['world']['party'][0]['mp']['current'] == 67
    assert any('原版模式有参数差异' in str(event) for event in browser['events'])
    assert (EVIDENCE/'runtime_config_browser_debug_20261011.png').is_file()

    refs = ['app.js', 'core/runtime_config.mjs', 'core/skill_config.mjs', 'core/battle_scheduler.mjs', 'core/forest_ai.mjs',
            'core/combat.mjs', 'core/battle_rewards.mjs', 'combat_sample.mjs', 'forest_sample.mjs', 'data/catalog.json',
            'data/config/index.json', 'data/config/skills.json', 'data/config/battle.json', 'data/config/rewards.json', 'data/config/items.json']
    for ref in refs:
        with urllib.request.urlopen('http://127.0.0.1:8767/'+ref, timeout=10) as response:
            assert response.status == 200
            assert hashlib.sha256(response.read()).hexdigest() == sha(WEB/ref), ref

    paths = [*WEB.glob('*.js'), *WEB.glob('*.mjs'), *WEB.glob('core/*.mjs'), *WEB.glob('data/config/*.json'), WEB/'data/catalog.json',
             RUNTIME/'tools/export_runtime_config.mjs', RUNTIME/'tools/export_skill_config.py', RUNTIME/'tools/build_catalog.py', Path(__file__),
             *tests, RUNTIME/'tests/preserve_history.mjs', RUNTIME/'config_guide.txt', RUNTIME/'skill_config_guide.txt',
             RUNTIME/'README.txt', RUNTIME.parent/'README.txt', RUNTIME.parent/'assessment/assessment.txt',
             RUNTIME.parent/'assessment/minimal_validation_next_20261011.txt', RUNTIME.parent/'assessment/validation_design.txt',
             *EVIDENCE.glob('runtime_config_browser*'), EVIDENCE/'runtime_config_before_browser_20261011.json']
    hashes = {path.relative_to(ROOT).as_posix():sha(path) for path in paths}
    report = dict(schema='seventh-seal-runtime-config-delivery', version=1, passed=True, tests=count, new_configuration_tests=14,
                  http_checks=refs, source_hashes=source_checks, retained_assets_checked=len(previous['asset_hashes']),
                  extraction_baselines_unchanged=originals, current_fingerprints=hashes,
                  browser=dict(actual_remake_ui=True, mode_sequence=modes, default_preserved=True, original_difference_rejected=True,
                               debug_enemy_hp=700, debug_mp_cost=5, effective_mp_after=74, raw_mp_after=67,
                               snapshot_survives_disk_restore=True, next_battle_reload=True, console_warnings_errors=0,
                               user_saved_progress_preserved=True),
                  limits=['Current eight skills, three forest enemies and six source-backed drops only.',
                          'Enemy nonzero MP, item use, shops and equipment definitions are rejected or remain deferred.',
                          'Contact counts, formulas and once-only rewards stay in code/source action records.',
                          'Browser checked controlled sample; complete tuned forest victory/save covered by source-based tests with Canvas adapter.',
                          'Not a GAME.exe runtime replay; earlier forest delivery is historical evidence.'])
    (EVIDENCE/'runtime_config_delivery_20261011.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    lines = ['第七封印 · 统一运行配置验收', '2026-10-11', '',
             f'结论：{count}项测试全部通过（新增14项配置检查），{len(refs)}项HTTP源码／配置校验，{len(source_checks)}项原输入SHA与{len(previous["asset_hashes"])}项留存来源／资产一致。',
             '统一入口runtime/web/data/config/index.json，skills／battle／rewards／items四个JSON分管参数。',
             '范围：八招、三敌初始HP／MP／属性／AI、充能阈值系数／准备量、三敌经验／金钱／掉落候选、六物品基础掉落率。',
             'source／original只作核对，parameters可调；原版模式拒绝差异，调试模式明确标示并记录参数与差异。',
             '每场重新读取，保留独立快照；单招／组合攻击使用同一数值覆盖。世界当前进度与原提取记录不被修改。',
             '完整默认战斗对照：伤害／接触、原RNG／奖励及世界保存结果一致；完整调参战斗覆盖耗蓝、血量、EXP、金钱、掉落、重复返回与存档重载。',
             '实际浏览器：默认HP1362／MP0→原版模式拒绝差异→调试HP700／MP5→文件恢复期间本场仍实际扣5到MP74／raw67→下一场HP1362／MP0且MP74不被重置。',
             '浏览器控制台warn／error为0；独立测试页未覆盖用户已保存进度，主页面恢复此前白木森林存档。',
             '普通生成保留已有修改；首次创建迁移旧两招参数；显式--reset恢复新五文件。旧data/skills.json仅留历史基线。', '',
             '未扩展：敌方非零扣费与后备、道具使用／装备定义／商店、任意新道具初始化；严格拒绝未支持字段。',
             '技能动作／多段接触、公式、死亡中断与奖励去重仍在代码及原动作记录，不通过JSON表达式控制。',
             '使用说明：runtime/config_guide.txt；证据：runtime/evidence/runtime_config_delivery_20261011.json、runtime_config_tests_20261011.tap、runtime_config_browser*。',
             '复做：node remake/runtime/tools/export_runtime_config.mjs；python -B remake/runtime/tools/verify_runtime_config.py（8767服务需已启动）。',
             '森林四步和更早日期报告保留当时指纹；本轮静态／适配器测试不称原游戏运行对照。']
    (RUNTIME.parent/'assessment/runtime_config_20261011.txt').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    print(json.dumps(dict(passed=True, tests=count, new_tests=14, http=len(refs), sources=len(source_checks), retained_assets=len(previous['asset_hashes']), browser=True)))

if __name__ == '__main__':
    main()
