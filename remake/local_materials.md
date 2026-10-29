# 第七封印 · 本地资料与恢复

本文件说明材料的准备、用途和缺失处理。当前实现与待办见[开发计划](assessment/validation_design.md)，命令见[工具说明](runtime/tools/README.md)。路径以仓库根目录为基准。

## 需要准备什么

| 材料 | 位置及用途 | 缺失时如何处理 |
| --- | --- | --- |
| 正式媒体 | `remake/runtime/web/assets/`；地图、图集、字体、声音和影片 | 交接与当前定义匹配的媒体并核SHA；无媒体可运行代码预检查和`/phaser-preview.html`，不记为正式素材验收。 |
| 原版输入 | 根目录的`GAME.exe`、`Map/`、`Fight_Role/`、`Fight_Bk/`、`SYSTEM/`、`Animate/`、sound等 | 从自己的同版本安装准备。导出器按实际输入校验，未知版本不能直接拼接旧台账；原程序、资源和原存档只读。 |
| 来源及构建台账 | `remake/runtime/evidence/`；原生指令依据、来源SHA、导出记录和必要初始化材料 | 按报错及构建声明补对应文件。部分材料仍是当前生产输入；首次构建尚不能仅凭原版文件完全重建。 |
| 观察与交接档 | `evidence/`下按主题／日期的报告、截图、输入和输出存档 | 随报告交接来源、路径、SHA、环境及样本条件；缺少时标记无法复核，不生成假报告或改旧指纹。 |
| 重制玩家存档 | `remake/saves/` | 独立备份；开发使用隔离目录或另名样本，不覆盖用户进度。它们不直接兼容原版二进制存档。 |
| 原版观察副本 | `remake/observation/` | 需要操作原版时单独准备隔离副本，记录输入身份和实际操作。静态指令提取不等于运行原GAME。 |
| 历史归档 | `remake/archive/`及Git历史 | 可选历史材料不随克隆出现；按下节恢复，不把归档目录名视为文件仍存在的证明。 |

原版存档解析与道具初始化源码统一在`runtime/tools/source/`。`save_analysis_20261010/`仅为历史存档样本与原生分析证据的本地输入目录，不再存放源码，也不随仓库提交。旧导出定义和来源指纹仍引用其中的原路径；需要重跑对应工具时，按原路径交接材料，不改历史清单或SHA。上述媒体、证据、观察和归档目录均被Git忽略。

## 旧环境迁移与当前检查

旧媒体从`remake/prototype/web/assets`复制到`remake/runtime/web/assets`，旧来源证据从`remake/prototype/evidence`复制到`remake/runtime/evidence/source`。源码与三份基础清单通过版本更新提供；媒体迁移不生成缺项。

使用`migrate_local_materials.py`默认盘点，`--run`复制，`--source-root`选择另一份旧项目。原字节保留、同SHA复用、冲突拒绝覆盖；处理记录写`evidence/layout_migration/`。完整命令只在[旧环境升级](runtime/tools/README.md#旧环境升级)维护。

素材齐全后执行`verify_phaser.mjs --assets`，再从正式入口检查受影响流程。代码、真实媒体、原版来源和浏览器观察分别报告；`current_validation.json`的`passed`只对应其`scope`，不自动证明浏览器实玩或干净首次构建通过。

## 来源与观察索引

下表目录均相对`remake/runtime/evidence/`。每个目录交接时保留文件结构、清单和SHA，正文不再逐次追加单份报告的经过。

| 主题 | 索引目录及关键入口 |
| --- | --- |
| 构建运行 | `builds/<UTC时间-唯一ID>/run.json`、步骤日志及`步骤.resources.json`；`build_state.json`、`resource_cache/`保存可核验缓存。来源选择以构建声明和检查器为准。 |
| 火之谷 | `fire_valley_20261024/source_index.json`；`fire_valley_20261025/implementation_closure.json`及`browser_observation.json`／`browser_validation.json`。阶段交接、渲染恢复和实际流程使用各自fixture manifest；最终原数值胜利在`stage12_delivery/victory_report.json`。 |
| 白木森林 | `white_forest_20261026/source_index.json`、`native_bundle.json`、`chest_source.json`、`phase_fixture_manifest.json`；地图／宝箱核对、浏览器记录及`reward_passives/`分别保留。 |
| 翠碧湖 | `jade_lake_20261028/source_index.json`、`map_source_validation.json`、`phase_fixture_manifest.json`、`browser_observation.json`／`browser_validation.json`；入场与ANM36依据在`jade_lake_battle_20261028/`。先前评估快照在`jade_lake_assessment_20261028/`。 |
| 炎城 | `ember_city_20261028/registration_scope.json`、`implementation_closure.json`、`final_preflight.json`、`browser_fixture_manifest.json`及浏览器观察；原kind4、经济服务、NPC保存和042来源保留在同目录。 |
| 实施前炎城评估 | `ember_city_assessment_20261028/source_index.json`、`assessment.json`与`inspect_scope.py`。须绑定当时源码／登记和原输入；其中“未登记／未实玩”是评估时点状态。 |
| 共享配置与六人技能 | `source_library_20261023/`、`party_skill_alignment_20261027/`、`configuration_startup_20261027/`；A／B全技能导入档及条件表随技能目录交接，不能以其替代正式学习流程。 |
| 表现与性能 | `movement_collision_optimization_20261028/`、`movement_contact_refinement_20261028/`、`battle_audio_20261028/`、`battle_streaming_20261029/`；更早材料按各自时点保留。 |

保留失败和更正记录：翠碧湖CF7分类以`cf7_idle_recovery.json`更正早期报告，旧报告不覆盖；火之谷`history_report_incident.json`所记旧slice报告原字节未恢复，不能作为原验收依据。复制或修订脚本不等于已重跑；是否执行以对应目录的实际报告为准。

开发交接档须保留原文件和准备来源，复用前用当前WorldStore校验；新样本另名，不修改旧`saved_at`。规则回放、仅渲染恢复、重制浏览器和原GAME观察各自注明范围。历史浏览器指纹不同不自动否定当前代码，也不能把旧观察改成新版本通过。

## 历史文档与恢复

`runtime/tools/layout_migration.json`记录目录迁移与清单SHA；[工具索引](runtime/tools/tool_index.json)的`retired_documents`记录已删除文档的原路径、SHA、替代入口及恢复提交。先确认对应提交在本地，再用`git show <提交>:<原路径>`查看；放入独立目录核SHA，不覆盖当前指南。

2026-10-29本轮精简前的完整技术笔记保留在Git提交`858f5ddacac9de3f27681817eafbdd46b83e06c7`，其中区域方法、剧情指南和计划包含详细来源推导。精简后的规则以当前代码、来源库及测试为准，需要回查旧解释时读取该版本原路径：

```console
git log -1 --format=%H 858f5dd
git show 858f5dd:remake/runtime/story_guide.md
git show 858f5dd:remake/assessment/region_remake_workflow.md
```

早期归档名`20261011_before_chapter`、`20261022_before_directory_cleanup`及其中压缩包仅供已有材料查找。缺少被忽略的文件时向资料持有者取得；文档、归档名称和旧SHA不能代替真实材料。
