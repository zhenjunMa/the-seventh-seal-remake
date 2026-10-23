第七封印 · 构建、导出与验证工具
更新：2026-10-23；所有命令从仓库根目录执行。正文中的web/、tools/、evidence/以runtime为基准；remake/开头的路径以仓库根目录为基准。示例使用python3；Windows可换为指向Python 3的python或py -3。

常用操作
启动检查用服务：python3 -B remake/runtime/serve.py
新增内容：python3 -B remake/runtime/tools/build_runtime.py --target content --run
已有来源只调参数：node remake/runtime/tools/export_runtime_config.mjs
只读查询技能默认／生效参数：node remake/runtime/tools/export_runtime_config.mjs --reference skills yantu
只读查询道具默认／生效参数：node remake/runtime/tools/export_runtime_config.mjs --reference items 4
只核对内容登记：node remake/runtime/tools/export_content_registry.mjs --check
完整当前检查：python3 -B remake/runtime/tools/verify_current.py
列全部构建计划：python3 -B remake/runtime/tools/build_runtime.py --target all
先准备新地图源表：python3 -B remake/runtime/tools/build_runtime.py --target chapter-story --run
盘点当前内容依赖：python3 -B remake/runtime/tools/build_runtime.py --target content --validate
只读剧情能力预检查：python3 -B remake/runtime/tools/build_runtime.py --preflight
结构化检查输出：node remake/runtime/tools/check_content.mjs --json
原版资源盘点：python3 -B remake/runtime/tools/resource_inventory.py（需要本地原版资源，输出evidence/resource_inventory.json）
同步构建文档：python3 -B remake/runtime/tools/sync_tool_docs.py
只读核对构建文档：python3 -B remake/runtime/tools/sync_tool_docs.py --check
只增量导出人物原始逐帧阴影：python3 -B remake/runtime/tools/export_map_shadows.py

执行语义
不加--run只列计划。--validate检查工具、既有来源台账与产物，记录当前指纹到evidence/export_inventory.json；不执行导出，也不等于原输入已经与历史来源逐项一致。
--run按依赖执行，命中缓存仍核对产物存在及SHA。缺失、手改或输入变化会触发重建；每个成功步骤即时保存，失败可续跑。
--force与--run一起强制重建，仍保留当前parameters。配置--reset才恢复原值，正常接入不使用。
配置导出自动迁移旧完整格式，当前skills／items为v3、battle／rewards为v2：只保存身份与修改项，来源指纹在文件级集中登记。普通导出补齐新增角色／怪物的技能、属性、AI及奖励，保留旧调参并剔除等于默认值的冗余项；未知编号、身份或来源漂移在任何写入前拒绝。--reference <skills|battle|rewards|items> [编号]只读显示来源默认值与生效值，不生成或修改配置。配置--reset清空修改项并恢复original模式。
--check须与--run一起使用，在成功后执行verify_current；8767服务需要先开启。
--preflight独立使用，检查已有源表的接入能力，不导出、不写报告、不核验原媒体；新地图没有源表时先构建chapter-story。显式入口发现未知能力返回非零退出码；旧隐式NPC仅提示，显式npcs进入阻断检查。
只有明确需要整体重建时才用--target all --run，日常文档维护无需重导素材。

登记驱动的生产
runtime_content.json为唯一编辑选择；导出器直接读取它选择地图／角色／程序，来源解析器再从已生成数据编译最终运行登记。
chapter-maps按maps.export归属准备地图、NPC、物件和源物理出口；chapter-story按story和programs准备TLK／ANM、被引用道具与登记玩家初值。
story-check在源表、初始角色和怪物准备后检查已登记的进入剧情、触发器、箱子、休息、出口和显式NPC的可达分支，报告地图／入口／记录号，阻断未实现机制；最终content再次检查。
battle-stages按stages选择新舞台的SCN／DGP，默认ID路径，不维护每个舞台的素材名单。当前支持SCN v2／mode4及已恢复的零镜头规则；专用旧产物默认existing，可显式export:"source"使用通用导出。
enemies按登记敌人实际学习表生成属性／AI／反应／状态／图层；enemy-rewards读取经验和奖励槽；encounters读取登记地图的DAT／STG池。音频按登记地图及动作生成。
party-skills读取新enemy清单组合正式party反应／表现；敌我复用源图集和独立像素校验，历史forest_full_battle_view／forest_reactions保留。
content目标贯通玩家、怪物、地图、剧情、配置、资源图集、声音、菜单／对白／字幕字体、地图光效、目录与最终登记。新增技能／道具数值仍只进入统一config。
已恢复格式、未知指令／状态／掉落、局部遇敌分区和新舞台的边界见../config_guide.txt；登记不会补实现。

前置与来源
按任务准备环境：静态服务使用Python 3标准库；verify_phaser需要Node.js，脚本内部会调用当前Node执行语法检查。
素材导出另需Pillow；startup-media还使用NumPy；音视频转换需要FFmpeg／FFprobe；GDI字体导出和部分原版观察需要Windows。完整回归还依赖当前Node的node:test／WebCrypto及各专题工具所需环境。
可先运行python3 --version和node --version；涉及媒体时再核对所需Python包、FFmpeg／FFprobe或Windows组件。当前尚无统一锁定环境与已验证的跨平台首次安装命令，单个实验依赖文件不能代表全部构建环境。
本入口接管已有基础内容与来源台账，不是从空目录自动重建原游戏的安装器。初始路线／基础资源提取、原资源和save_analysis仍有实际依赖；基础导出器已位于本目录，不再读取prototype。
声明原输入的新步骤可建立首份台账；其他步骤需要既有来源报告。路径、哈希、原像素／解码或未知格式校验仍由对应工具负责。
来源与历史材料的用途、准备及恢复统一见../../local_materials.txt。材料不足时先执行无素材预检查；仅列计划不能证明首次构建可执行，--target all --run也不会自动补齐来源。首次构建任务和完成标准见../../assessment/validation_design.txt。
生成的运行表和素材不手工调参；普通配置导出迁移已核对基线并保留parameters。仅参数变化无需重建图集。

构建台账
旧台账中的已迁移源码、清单、素材和证据路径按layout_migration.json解析到正式目录；原记录及SHA保持不变，迁移映射也参与构建签名。
声明依赖与签名由build_runtime.py维护，状态写evidence/build_state.json；每次运行在evidence/builds/<UTC时间-唯一ID>/记录run.json和实际步骤日志。
历史来源清单位于web/data/source，保留原字节与历史引用；当前正式清单使用/assets路径。迁移映射在layout_migration.json，旧原型证据迁到evidence/source。
日期命名证据如被导出器重新生成，构建入口先保存到该步骤generated-evidence，再恢复旧文件原字节。失败也保留诊断；不要将旧报告重绑成新观察。
当前剧情台账为chapter_story_export.json，怪物为enemy_content_export.json／enemy_rewards_export.json，遭遇为encounter_export.json；具体reports／inputs／outputs以STEPS为准。
旧五份提取基线保存在evidence/export_tools_20261022/legacy_extractions并按历史SHA核对，当前生成文件按新台账检查。
直接执行历史导出器不经过日期保护，需要先查看其代码和输出范围。

目录迁移与基础来源
共享解析器位于remake/runtime/tools/source：dgp.py、map_data.py、map_objects.py、combat_resources.py。
移动模块、解码器、基础导出器和三份基础清单已随代码迁移；web/data/source中的清单保留原始导出字节和历史引用。它们是构建来源，不是新增地图或剧情的编辑入口；内容登记仍使用web/data/runtime_content.json。
正式素材统一使用/assets/路径。正式服务8767只挂载remake/runtime/web；实验单独运行python3 -B remake/prototype/serve.py，默认8765，复用正式模块和媒体。

旧环境升级
以下命令从新版本项目根目录执行。迁移脚本只复制本地媒体和证据，源码及基础清单由版本更新提供。
1. 默认只盘点，不写文件：
   python3 -B remake/runtime/tools/migrate_local_materials.py
   从另一个旧项目交接时，先对该目录盘点：
   python3 -B remake/runtime/tools/migrate_local_materials.py --source-root "/path/to/old-project"
2. 按相同来源执行复制：
   python3 -B remake/runtime/tools/migrate_local_materials.py --run
   跨目录交接使用：
   python3 -B remake/runtime/tools/migrate_local_materials.py --source-root "/path/to/old-project" --run
   remake/prototype/web/assets → remake/runtime/web/assets
   remake/prototype/evidence → remake/runtime/evidence/source
   原文件保留，同SHA目标复用；发现同名不同内容报错，不覆盖。存在旧文件时，--run会把来源、目标、SHA及处理状态记录到remake/runtime/evidence/layout_migration/<UTC时间>.json。
   files=0表示选定来源中未找到可迁移文件；该结果不检查新目录中的素材是否齐全。迁移也不会生成缺失媒体或补全原版输入。
3. 素材齐全的环境检查新路径、图集、指纹和尺寸：
   node remake/runtime/tools/verify_phaser.mjs --assets
   只有代码时可省略--assets运行预检查，并使用正式服务的/phaser-preview.html；报告中的assets.passed仍反映素材实际情况。
4. 启动正式服务，再按../README.txt的正式路线验证剧情、战斗和存读档：
   python3 -B remake/runtime/serve.py
   真实素材实玩、Windows启动与首次构建的完成情况见../../assessment/validation_design.txt；迁移本身不改变这些验收结论。

基础导出入口
python3 -B remake/runtime/tools/extract.py
python3 -B remake/runtime/tools/export_movement.py
python3 -B remake/runtime/tools/export_combat_lab.py
python3 -B remake/runtime/tools/export_combat_presentation.py
这些独立入口读取对应原输入和保留来源证据，写入remake/runtime/web/data/source、remake/runtime/web/assets及remake/runtime/evidence/source；构建边界见“前置与来源”。新增正式内容继续使用build_runtime.py，不在prototype新增生产工具。

工具导航
分类见tool_index.json，记录构建目标、共享导入关系及独立工具用途。新增／迁移工具时人工维护path、role、imported_by及历史恢复字段；不根据命名猜测用途。
sync_tool_docs.py从build_runtime.STEPS及plan生成registered_steps、content_plan、各工具build_targets和下方依赖清单；其余字段保留。默认同步，--check发现过期内容或索引遗漏时非零退出，不运行导出、不改素材或证据。实际构建计划始终以build_runtime.py为准。
daily-entry：常用构建／检查／文档维护入口；standalone-check：不属于统一构建的独立检查。
registered-build：统一构建中的生产步骤。
shared-current：当前步骤或检查仍导入的素材助手。source-decoder：source/中的共享只读DGP、DAT、地图物件与CHR解析器；正式导出与实验验证共用。
specialized-evidence-check：专题验收和日期观察复核，按各工具代码检查范围；不是每日全部执行的命令。
fixture-or-observation-preparation：创建独立样本或原版观察副本，不等于正式获取／入队流程。
source-observation：只读检查或记录原版，原目录输入保持只读。
resource_inventory.py盘点原资源目录、文件头、GAME.exe的PE导入和已有证据索引，不解码自定义格式；生成报告统一保存在runtime/evidence，不写assessment。
export_map_shadows.py也是map-effects构建步骤的共享助手：从现有opening/chapter角色清单及事件NPC取动作组，只新增assets/map_shadows与data/map_shadows.json，逐帧核对DGP geometry[41]原掩码，保留人物main／intrinsic PNG。按动作全部帧／方向的非空包围盒并集裁剪，shadow_geometry保存原帧偏移及紧凑尺寸；每帧重新展开后与独立原掩码逐像素核对，全空动作跳过。独立命令写movement_optimization_20261023/shadow_export.json，不运行全量构建。50%黑色alpha近似原16位背景RGB分量减半；主图／阴影／加色层保持同源帧、锚点及人物depth。
independent-source-export：独立基础来源或旧样本生产入口，可能仍用于初始提取；分类不表示可删除。

当前构建目标与直接依赖
下方标记内内容由sync_tool_docs.py生成，不手工修改。
[自动生成：构建目标开始]
save-menu: export_save_menu.py; 依赖=无声明依赖
opening-seed: export_opening_seed.py; 依赖=无声明依赖
opening-maps: export_opening_maps.py; 依赖=无声明依赖
chapter-maps: export_chapter_maps.py; 依赖=无声明依赖
chapter-story: export_chapter_story.py; 依赖=chapter-maps
map-effects: export_map_effects.py; 依赖=opening-maps,chapter-maps
party-combat: export_party_combat.py; 依赖=story-check
party-skills: export_party_skills.py; 依赖=party-combat
party-rewards: export_party_rewards.py; 依赖=party-combat,enemy-rewards
items: export_chapter_items.py; 依赖=无声明依赖
item-presentation: export_item_presentation.py; 依赖=items,party-skills
recovery: export_chapter_recovery.py; 依赖=无声明依赖
audio: export_audio.py; 依赖=party-skills,item-presentation,chapter-maps,encounters
forest-stage: export_forest_stage.py; 依赖=无声明依赖
menu: export_operation_menu.py; 依赖=items,party-skills
battle-ui: export_battle_ui.py; 依赖=无声明依赖
battle-lifecycle: export_battle_lifecycle.py; 依赖=无声明依赖
skill-test: export_skill_test.py; 依赖=无声明依赖
battle-result: export_battle_result.py; 依赖=无声明依赖
battle-packs: export_battle_packs.py; 依赖=party-skills,item-presentation,forest-stage,battle-ui,battle-lifecycle,skill-test,battle-result,battle-stages
menu-techniques: export_menu_techniques.py; 依赖=menu,party-skills
menu-fonts: export_menu_text_gdi.py; 依赖=menu-techniques
startup-media: export_startup_media.py; 依赖=无声明依赖
startup-menu: export_startup_menu.py; 依赖=无声明依赖
prologue-presentation: export_prologue_presentation.py; 依赖=chapter-story
dialogue-ui: export_dialogue_ui.py; 依赖=catalog,chapter-story
world-map-ui: export_world_map_ui.py; 依赖=无声明依赖
configuration: export_runtime_config.mjs; 依赖=party-skills,enemy-rewards,encounters
catalog: build_catalog.py; 依赖=configuration,chapter-maps
content: export_content_registry.mjs; 依赖=catalog,party-rewards,battle-packs,audio,menu-fonts,save-menu,dialogue-ui,prologue-presentation,map-effects
enemies: export_enemy_content.py; 依赖=无声明依赖
enemy-rewards: export_forest_rewards.py; 依赖=无声明依赖
encounters: export_encounters.py; 依赖=无声明依赖
story-check: check_content.mjs; 依赖=chapter-story,opening-seed,enemies
battle-stages: export_battle_stages.py; 依赖=forest-stage
[自动生成：构建目标结束]

当前检查覆盖什么
Phaser无素材预检查：node remake/runtime/tools/verify_phaser.mjs。核对固定运行库指纹、正式／预览入口模块图与JS语法，并报告现有JSON所引用的素材缺失。默认允许缺失素材，输出分别标明code.passed与assets.passed。
有素材交接检查：同一命令加--assets，要求素材齐全且已声明SHA／PNG尺寸匹配。--report <runtime/evidence内路径>可保留完整JSON报告。浏览器预览为/phaser-preview.html，正式流程验收仍从/进入。
战斗单帧逻辑路径按battle_packs.json解析到实际图集页，检查沿用BattleResources的图集定义校验；运行交付无需在图集之外重复提供这些单帧源PNG。地图、菜单、字体、音视频等直接加载的媒体仍须提供。
无素材时默认命令可在code.passed=true、assets.passed=false时成功退出；--assets在素材缺失时失败。两者都不表示完整主线已通过实玩验收。
verify_current检查JS／Python回归、Python语法、原输入、保留资产、现有导出台账、配置／登记、HTTP资源和归档，写current_validation.json、current_validation.tap和current_python_tests.log。
检查需要8767服务，数量和时间以报告为准。它核对历史浏览器观察及指纹，不重播UI，不运行原GAME.exe，不会自动完成后续剧情。
缺少原版输入／历史evidence时，verify_current可能在来源核对阶段终止；不沿用旧current_validation作为当前Phaser通过记录，应另存本轮预检查与限定范围浏览器结果。
规则／事务变化运行对应回归；实际页面／动画变化另做浏览器观察。独立页面在web/tests，包括battle_loading.html、dialogue_alignment.html和startup_storage.html，各有其限定范围。
verify_*中的旧阶段门槛不能替代当前回归；写--record的新现场按工具说明生成，已冻结观察不重写。

常见问题
登记未编译：执行content --run后刷新；只运行catalog不会编译最终登记。
缺少原输入或来源台账：按报错恢复对应来源／基础提取；不跳过来源校验。
未知行为：先实现并验证规则，再登记；不改raw记录或放宽校验来绕过。
配置原版模式拒绝差异：恢复parameters原值，或明确使用debug验证；模式不重置用户进度。
生成资源缺失或指纹变化：检查对应步骤日志及产物，针对性重建。文件路径迁移必须同步工具、索引与引用。
历史证据不匹配：只表示代码时点不同，需要新观察；不改旧报告使其看起来匹配。

资料维护
来源证据、现场记录及历史归档的目录、准备方式与缺失处理统一见../../local_materials.txt；可选本地索引或旧压缩包不作为当前命令的唯一说明。
assessment只维护validation_design.txt和menu_alignment_workflow.txt；旧兼容跳转页已清理。清理文件及迁移工具的原路径、SHA与Git恢复版本见tool_index.json的retired_documents和工具previous_path字段。
verify_runtime_config.py的复核文字报告输出到evidence/runtime_config_recheck.txt，不再生成assessment下的旧跳转页。
