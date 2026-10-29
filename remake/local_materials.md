# 第七封印重制 · 本地素材、证据与历史资料

更新：2026-10-28；路径以仓库根目录为基准。

本文件随代码维护，说明资料用途、准备方式和缺失时的处理。实际媒体、来源台账、观察副本和历史归档不随仓库提供。

## 运行素材

`remake/runtime/web/assets`统一保存提取媒体；运行定义位于`remake/runtime/web/data`，基础导出清单位于`remake/runtime/web/data/source`。`remake/prototype`实验页面复用这些资源。

已有新版本环境交接时，复制与当前定义匹配的`remake/runtime/web/assets`，并按构建需要交接`remake/runtime/evidence`及原版输入。旧版媒体位于`remake/prototype/web/assets`，旧来源证据位于`remake/prototype/evidence`；迁移目标分别为`remake/runtime/web/assets`和`remake/runtime/evidence/source`。盘点、同项目复制、跨项目`--source-root`交接及接收后的检查命令，统一见[README.md](runtime/tools/README.md)的“旧环境升级”。

迁移按原字节复制并保留旧文件；同SHA目标复用，冲突拒绝覆盖。实际处理映射记录在`remake/runtime/evidence/layout_migration/`<UTC时间>.json。源码和三份基础清单由版本更新提供，不由媒体迁移脚本复制。

无媒体时可以启动服务访问`/phaser-preview.html`，并执行无素材预检查。示意图仅说明其几何、规则和时序范围，不能证明原作画面、音视频或主线流程已验收。

## 原版输入与构建来源

原版`GAME.exe`、Map、Fight_Role、Fight_Bk、SYSTEM、Animate等目录由使用者从自己的原版安装准备；实际需要的文件和版本由登记、导出器及来源校验决定。

原版程序、资源和存档只读；不要把未知版本资源与旧台账直接拼接。需要原版操作时使用`remake/observation`中的隔离副本。

save_analysis_20261010中四个共享解析模块随代码提供，但原存档、原生观察和历史样本需要单独准备。

`remake/runtime/tools/build_runtime.py`目前用于已有基础内容上的增量生产。仅有原版文件还不足以保证完成首次构建；环境依赖、命令和缺失处理见[README.md](runtime/tools/README.md)，打通任务见[validation_design.md](assessment/validation_design.md)。

## 证据与构建记录

### 炎城首批实现与源审计

`runtime/evidence/ember_city_20261028`保存正式28图索引、18图运行范围、原kind4／金钱／交易／配方／NPC保存块／042与331的来源证据。`registration_scope.json`为初始登记选择，不能用其中旧的未执行状态替代最终`implementation_closure.json`；`final_preflight.json`为实际运行登记的能力检查。浏览器使用该目录下的独立`browser_saves`，交接来源、测试资金及战斗成长范围见`browser_fixture_manifest.json`；未修改原GAME、原版存档或用户普通存档。

ROLE106原DGP120帧内含同ID后备动作，其尾部越界动作按469F50首个ID匹配不会被选中；审计保留全部原动作及异常，不补画帧。CF1全量181个放置、48个bank、7组非空阴影与F6 state0规则见`cf1_idle_scope.json`及`cf1_capability_scan.json`，声音的原逻辑帧／距离音量／声像／同handle不重播见`native_cf1_sound_*.json`。所需DutyEg与Status源文件精确缺失时沿原0帧／80ms回退或空音效，不改用近名文件。当前规则和配置用法见对应runtime指南，不在证据目录维护待办。

### 炎城接入前静态范围评估

`remake/runtime/evidence/ember_city_assessment_20261028`保存本次炎城排期的`source_index.json`、`source_coverage.json`、`assessment.json`及复核脚本`inspect_scope.py`。复用既有区域扫描器，覆盖28图、195个NPC实例、1008条TLK与34份相关ANM（含未证实调用的候选）；另记录里白木森林349／299及三法器箱的原DAT偏移、钥匙、奖励槽与SHA，以及当前编号校验／剧情能力缺口。实际实施范围与阶段任务只维护在[开发计划](assessment/validation_design.md)。

目录整体被Git忽略，交接时保留全部文件及`assessment.json`中的相对路径／SHA。原输入版本一致时，从仓库根运行`python -B remake/runtime/evidence/ember_city_assessment_20261028/inspect_scope.py`：已有索引先逐个核对原文件SHA，缺索引时从只读Map／Animate重建；复核时也需与评估所绑定的源码／登记指纹一致，不能把新代码生成的不同结果冒称旧快照。首次静态评估未登记运行内容、未构建媒体、未做新增入口preflight或浏览器实玩，也未执行原GAME.exe；来源收录与完成验收分开表述。

### 翠碧湖来源索引

翠碧湖索引由jade-lake-index目标从只读原DAT／TLK／ANM重建，输出`remake/runtime/web/data/library/jade_lake.json`及`remake/runtime/evidence/jade_lake_20261028/source_index.json`。包含13张全时期地图、41条TLK记录、两份ANM的94条命令、原物件／NPC及区域外旗标与演出调用关系，不包含同前缀的研究所遗迹。索引及报告记录原输入SHA和产物SHA；接收环境用同版本原版Map／Animate目录运行该目标，再以`export_jade_lake_index.py --check`核对确定性。构建台账在`evidence/builds`另存输入指纹与只读检查结果；缺少原输入时保留现有索引，不能把来源覆盖作为流程验收。

`remake/runtime/evidence/jade_lake_assessment_20261028`保存此前排期评估的`source_index.json`与`assessment.json`，保留原字节作为历史依据。本轮正式来源报告单独放在jade_lake_20261028，不覆盖评估快照；两个目录均被Git忽略，交接时一并保留。静态来源导出未执行原GAME.exe，也不代表第一阶段或后期剧情已完成页面实玩。

`jade_lake_20261028/verify_map_sources.py`对13张湖图及M01060／M01065交接图按原DAT和独立DGP解码核背景、初始物件、地形、入口、NPC默认值；`map_source_validation_initial.json`保存初次静态结果，最终包含CF1双通道图集的结果使用新的`map_source_validation.json`，以其实际存在及绑定SHA为准。`cf1_sequence_recovery.json`保存M01060显式9步帧表、FF随机取模、重进默认值和空阴影的来源解释，关联既有410850／4137C0原指令及40CFE0证据；定向回归本体通过与统一报告是否有效分别记录。`test_cf1_map_effect_pixels_before_handoff.py`保留初始源图报告所绑定的旧独立解码器版本，不作为正式测试入口。

`jade_lake_20261028/cf7_idle_recovery.json`补记M01065原物件1的CF7默认／保存待机规则、全8物件队列及两动作16帧双通道核对，绑定定向测试报告。它明确更正此前`cf1_sequence_recovery.json`把这个额外物件称作CF3的分类错误：实际DAT +CF为7，旧报告保持原字节。CF1像素覆盖不能代替整图prepare；浏览器发现的载入异常及修复后的页面验证另记当次证据，不以Node控制器准备检查冒称画面实玩。

`jade_lake_20261028/browser_observation.json`与`browser_validation.json`保存本轮按用户要求“直接改档、只测新增部分”的正式页面验收；`phase_fixture_manifest.json`、`battle_fixtures`及`postevent_fixture_manifest.json`分别说明阶段前置、原成长30级胜利样本和实际演出输出仅改位置的重进档。截图、实际输出档、奖励、运行日志及CF7修复前后输入差异在`browser`。`test_save_delivery.json`绑定当前本地`remake/saves/SaveGame19.json`入口档，旧00～02栏与快速档的未改SHA另行核对；样本和证据不随Git自动分发。相关定向报告列在观察记录中，不把更早发现旧登记假设失败的all记录改写为最终全量通过。

`remake/runtime/evidence/jade_lake_battle_20261028`保存014雷兽／022刽齿蛟的`admission.json`及入场模式原生证据`appearance_native.json`；014原随机显现按[1,5,7]单次抽取，022的横向显现与command-only入场保留原完成条件。`anm36_native.json`另保留473E30／4B6720／45E400／518800调用证据：本轮mode1与mode0同走入队，只有mode3切控制，命令XY不作为传送。交接时这些文件须与构建依赖一并保留；原生静态指令差分、重制规则与浏览器表现分别说明，显现沿既有alpha适配，不声称RGB16像素变换完全相同。

### 白木森林来源与页面记录

外层白木森林资料在`remake/runtime/evidence/white_forest_20261026`：`source_index.json`为六图全来源扫描，`native_bundle.json`／`entry_native_bundle.json`为原物件更新与入口静态证据，`chest_native_bundle.json`／`chest_source.json`为13箱钥匙及奖励来源。`prepare_phase_fixtures.mjs`、`phase_fixture_manifest.json`及phase_fixtures目录保存11份开发交接档与输入SHA，复用时验证原字节，不改saved_at。原版`GAME.exe`未由这些静态提取／开发档执行；实际页面观察须另绑当次指纹。该目录整体被Git忽略，交接时连同原材料、脚本、报告与SHA保存。

`chest_validation.json`为13箱的生产动画控制器／事务回放，`map_source_validation.json`为独立原DAT／DGP逐像素核对，均不冒称页面实玩。`chest_browser_fixture_manifest.json`、`prepare_chest_browser_fixtures.mjs`与chest_browser_fixtures保存26份有效／缺钥匙的页面导入档；其中钥匙是明确声明的开发准备，全游戏TLK检索的外区原授予者另保留。`reward_passives/native_bundle.json`与`findings.json`保存127／170的原装备入战状态初始化、x86限定回放与规则验证；items构建声明该原生证据输入，不据道具名称推测效果。

### 通用构建台账

`remake/runtime/evidence`保存来源SHA、像素核对、原生观察、导出台账、构建日志和浏览器记录；该目录整体被Git排除。

新导出记录由`remake/runtime/tools/build_runtime.py`写入`remake/runtime/evidence/builds/`<UTC时间-唯一ID>/；成功步骤及generated-evidence可用于核对当次产物，具体来源选择仍以检查器代码为准。

### 火之谷来源与阶段记录

火之谷来源索引由fire-valley-index目标从全游戏DAT／TLK／ANM重建，输出`data/library/fire_valley.json`及`evidence/fire_valley_20261024/source_index.json`。20261024目录保存最初索引、阶段布局／物品／返回传送的浏览器定向记录；20261025目录保存后续ANM镜头／媒体／队伍原生证据。日期目录内资料以各自记录范围为准，不能合并宣称完整区域实玩。

`fire_valley_20261025/phase_fixture_manifest.json`与`prepare_phase_fixtures.mjs`记录9个来源阶段交接存档；`browser_fixture_manifest.json`与`prepare_browser_fixtures.mjs`另记初期祭坛及两条后期开发队伍（源成长到65级、明确的学习奖励操作）；`render_fixture_manifest.json`与`prepare_render_fixtures.mjs`只用于21图加载／恢复。交接时连同对应phase_fixtures、browser_fixtures、render_fixtures目录及输入SHA一起保留。这些是重制开发存档，不能作为原版存档、区域外自然旅行或完整主线成长证据。

browser_diagnostic保存真实页面操作的起止存档、运行日志、截图和比较结果，包含M03039返谷失败及修复后的完整世界对照。`object_closure_audit.json`、`cf1_map_animation_recovery.json`与stage12_development分别保存物件闭包、CF1恢复和原数值最终战回放；其中失败记录也需保留，不得仅交接成功摘要。最终浏览器／完整检查以当次报告明确列出的文件指纹为准。

`stage12_development/prepared_entry.json`与`preparation_report.json`另记99级、原装备和纯数值晶石的开发准备；`browser_equipped_fixture_manifest.json`及`prepare_browser_equipped_fixture.mjs`说明如何通过同一不可变seed身份与队伍API将该准备接到真实后期入口。它们不改敌方／配置／伤害／结果，仍不代表区域外自然取得装备和完整主线。`missing_audio_audit.json`保存7份原WAV缺项、7317份原目录文件的大小写无关检索、原CHR引用偏移及未擅用的近名文件。

`item_availability_audit.json`记录原初装卸下后无法重装、M17025赠礼50及M17027赠药272的执行闭包审计，连同原ITM／初始化／真实授予来源和保存证据交接。`item_browser_fixture_manifest.json`及`prepare_item_browser_fixtures.mjs`只做005原入队和NPC前的开发站位，既不发奖也不改条件旗标；实际奖励仍须通过页面交谈领取。

`first_return_npc15_entry.json`、`first_return_fixture_manifest.json`及`prepare_first_return_fixture.mjs`记录炎城NPC15到火之谷首次返回的开发交接：源299材料、31:2／5:1的原写者及未完成的5:3，仍须在实际对白选材并完成整段m01050-2。这里只开放必要的外部NPC与演出，不是炎城全区或外部任务全程验收。

`run_stage12_victory_final.mjs`保留原`run_stage12_victory.mjs`的规则与输入，仅将三处证据输出目录改为stage12_final；精确复制与替换证明在`stage12_final/recipe_copy.json`。是否完成新的整战以该目录实际报告为准，不能将复制脚本当作已经重跑；旧stage12_development胜利和失败记录不覆盖。

`fire_valley_20261025/audio_filename_resolution_audit.json`及audio_filename_resolution_analysis保存同包`GAME.exe`与`Mss32.dll`的完整调用／指令字节、静态读取链和逐条缺声引用；原Win32分支最终按字面路径CreateFileA，未发现改扩展名、下划线或目录回退。near-name文件同SHA不作为替代依据。`missing_audio_final_audit.json`另绑定最终`audio.json`并复核缺项；旧`missing_audio_audit.json`维持原会话指纹。

`fire_valley_20261025/implementation_closure.json`汇总本轮13项实现故障的解除证据与最终验收，`queue_before_final_acceptance_20261025.txt`保留收口前诊断清单。`finale_defeat_recovery_audit.json`另保留rawHP与装备显示HP不一致时的败北来源、完整现场及正式控制器回归。当前待办仍只读[validation_design.md](assessment/validation_design.md)。`browser_validation.json`／`browser_observation.json`绑定最终页面会话、各输入存档和实际运行记录；`browser_final/session_post_defeat_start_fingerprints.json`与`session_post_defeat_end_fingerprints.json`证明最终新会话315份文件未变；`delivery_build_delta.json`另明确较前一终章／奖励会话仅`core/recovery.mjs`发生变化，314份文件字节相同。前一会话保留原指纹，不改写成最终版重播。原`GAME.exe`没有在这些页面记录中执行，阶段开发档不补作外部主线历史。

`stage12_delivery/victory_report.json`是最后败北修复构建后的独立原数值整战，保留完整准备、185条源序列、生命周期／RNG／奖励与事务回放；`entry.json`、`after_victory.json`及`recipe_copy.json`一起交接。该次完整胜利把准备内容嵌在victory_report中，不另外产生`preparation_report.json`；不要把prepare-only输出缺席误记为原素材卡点。先前stage12_final与stage12_development的各次成功／失败仍按原时点保留。

`evidence/fire_valley_20261024/history_report_incident.json`记录旧`slice_verification_20261011.json`被定向测试覆盖的问题；原字节未能恢复。该历史文件不能作为原验收证据，当前完整验证改读`current_slice_verification.json`。通用防覆盖和接入经验见[region_remake_workflow.md](assessment/region_remake_workflow.md)。

### 完整检查与交接要求

`remake/runtime/evidence/current_validation.json`是本地最近一次完整检查的结果，可能缺失或passed=false。它不是仓库承诺的验收证书；即使passed=true，也要核对浏览器观察的代码时点和覆盖范围。

资料持有者交接来源文件时应同时给出相对路径、SHA、来源版本及观察条件，保留原目录结构。按报错确认所需文件；没有匹配材料时记录缺项，使用限定范围的预检查，不编造来源报告或修改旧SHA。

旧说明可能引用本地`remake/runtime/evidence/README.txt`；如交接环境带有该索引，可辅助查找。随仓库的资料入口以本文件为准，不要求该可选索引存在。

## 历史归档与恢复

`remake/archive`保存阶段方案、旧文档和压缩会话快照；`remake/observation`保存原版操作副本及观察材料。这些目录不会因克隆代码而自动出现。

旧文档曾归入`remake/archive/20261011_before_chapter`和`remake/archive/20261022_before_directory_cleanup`，后者还记录过`documents.zip`；这些名称仅用于已有资料的查找，不是当前操作或首次构建的前置说明。

当前必需的命令、配置和验收方法分别在[README.md](runtime/tools/README.md)、[config_guide.md](runtime/config_guide.md)和[menu_alignment_workflow.md](assessment/menu_alignment_workflow.md)维护；历史资料缺失时从这些当前入口继续。

目录迁移的源码／清单位置、媒体／证据目录映射和旧SHA位于`remake/runtime/tools/layout_migration.json`；正式运行清单因路径更新产生的新文件SHA也在其中登记。基础清单按原字节保留，其中旧来源路径描述历史导出位置；当前导出器读取迁移后的来源，旧证据不能重写为新验收。已清理文档和迁移工具的原路径、SHA、replacement、previous_path及recovery_commit保存在`remake/runtime/tools/tool_index.json`。先确认本地Git历史包含对应提交，再用git show <提交>:<原路径>查看；缺少提交或被忽略的归档时，需要向资料持有者取得相应文件。

恢复材料先放独立目录核对SHA和引用，不覆盖当前指南或旧证据。仅凭归档名称不能断言文件仍存在或能重现原版观察。

## 交接结果的表述

- **当前实现范围**：由当前代码和登记支持的功能；不自动代表素材齐全或流程通过。

- **历史验收范围**：特定阶段、代码／资源指纹和样本下留下的观察；缺少匹配材料时只能说明曾有记录。

- **本版待验收范围**：当前代码尚需补充的真实素材、正式入口和长流程检查；统一维护在[validation_design.md](assessment/validation_design.md)。
