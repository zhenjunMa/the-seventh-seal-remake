# 第七封印 · 构建、导出与验证工具

更新：2026-10-28；所有命令从仓库根目录执行。正文中的web/、tools/、evidence/以runtime为基准；remake/开头的路径以仓库根目录为基准。示例使用python3；Windows可换为指向Python 3的python或py -3。

## 目录

- [常用操作](#常用操作)
- [执行语义](#执行语义)
- [登记驱动的生产](#登记驱动的生产)
- [前置与来源](#前置与来源)
- [构建台账](#构建台账)
- [目录迁移与基础来源](#目录迁移与基础来源)
- [旧环境升级](#旧环境升级)
- [基础导出入口](#基础导出入口)
- [工具导航](#工具导航)
- [当前构建目标与直接依赖](#当前构建目标与直接依赖)
- [测试职责与运行](#测试职责与运行)
- [当前检查覆盖什么](#当前检查覆盖什么)
- [常见问题](#常见问题)
- [资料维护](#资料维护)
- [[剧情运行包]](#剧情运行包)

## 常用操作

启动检查用服务：

```console
python3 -B remake/runtime/serve.py
```

新增内容：

```console
python3 -B remake/runtime/tools/build_runtime.py --target content --run
```

已有来源只调参数：

```console
node remake/runtime/tools/export_runtime_config.mjs
```

只读查询技能默认／生效参数：

```console
node remake/runtime/tools/export_runtime_config.mjs --reference skills yantu
```

只读查询道具默认／生效参数：

```console
node remake/runtime/tools/export_runtime_config.mjs --reference items 4
```

补全原版角色／技能来源目录：

```console
python3 -B remake/runtime/tools/build_runtime.py --target source-catalog source-magic --run
```

生成全量引用索引：

```console
node remake/runtime/tools/build_content_library.mjs
```

生成火之谷地图／NPC／剧情来源索引：

```console
python3 -B remake/runtime/tools/build_runtime.py --target fire-valley-index --run
```

生成外层白木森林来源索引：

```console
python3 -B remake/runtime/tools/build_runtime.py --target white-forest-index --run
```

生成翠碧湖全时期来源索引（13图，不含研究所遗迹）：

```console
python3 -B remake/runtime/tools/build_runtime.py --target jade-lake-index --run
python3 -B remake/runtime/tools/export_jade_lake_index.py --check
```

翠碧湖的`--query`、`--map`、`--flag`及`--limit`参数与下方火之谷示例相同。索引保留全部原始阶段，运行开放及验收按开发计划分期。

只读核对火之谷索引与覆盖报告：

```console
python3 -B remake/runtime/tools/export_fire_valley_index.py --check
```

按名称／台词查询火之谷来源：

```console
python3 -B remake/runtime/tools/export_fire_valley_index.py --query 英格妮 --limit 20
```

查询具体原地图：

```console
python3 -B remake/runtime/tools/export_fire_valley_index.py --map M17030-2
```

查询跨地图旗标：

```console
python3 -B remake/runtime/tools/export_fire_valley_index.py --flag 471:1
```

按原编号查询：

```console
node remake/runtime/tools/build_content_library.mjs --query roles 004
```

按名称检索（返回所有同名原编号）：

```console
node remake/runtime/tools/build_content_library.mjs --query search 海皇印 items
```

只核对内容登记：

```console
node remake/runtime/tools/export_content_registry.mjs --check
```

完整当前检查：

```console
python3 -B remake/runtime/tools/verify_current.py
```

列全部构建计划：

```console
python3 -B remake/runtime/tools/build_runtime.py --target all
```

先准备新地图源表：

```console
python3 -B remake/runtime/tools/build_runtime.py --target chapter-story --run
```

盘点当前内容依赖：

```console
python3 -B remake/runtime/tools/build_runtime.py --target content --validate
```

只读剧情能力预检查：

```console
python3 -B remake/runtime/tools/build_runtime.py --preflight
```

结构化检查输出：

```console
node remake/runtime/tools/check_content.mjs --json
```

原版资源盘点：

```console
python3 -B remake/runtime/tools/resource_inventory.py
```

（需要本地原版资源，输出`evidence/resource_inventory.json`）

战斗图集按需加载规划（不需要原版文件或PNG，使用已提交的表现元数据、已编译登记及既有`battle_packs.json`）：

```console
python3 -B remake/runtime/tools/export_battle_packs.py --plan --roles 001,012 --stage stage13
```

`--roles`选择本场人物／敌人的原资源编号，`--stage`选择已登记舞台，两项同时提供；省略两项只盘点全库。规划比较旧公共特效加载、当前筛选沿用旧页面，以及按特效／舞台拆组后的几何体积。它使用旧区域坐标识别重复图块，缺少像素时可能保守高估去重后的体积；不会生成PNG或改写正式清单，也不能作为媒体验收。可加`--report remake/runtime/evidence/本次新目录/plan.json`写新报告，已有报告拒绝覆盖。

素材齐全后沿统一构建入口执行`python3 -B remake/runtime/tools/build_runtime.py --target battle-packs --run`，生成按`role-角色ID`、`stage-舞台ID`及HUD／结算分组的页面。特效按原ID登记后先跨特效去重相同像素，再按图块的使用者集合生成`effects-roles-角色编号集合`，相同使用范围合页，避免每个特效独占页面的碎片；无引用的来源保留在独立组。导出重构核对每份源PNG的可见像素和alpha。旧清单仍可运行，但仅修改加载筛选不能解除旧页面内无关特效的共同驻留；不要手工修改旧页面的group伪装成重建。完成后执行`verify_phaser.mjs --assets`及正式战斗实玩。

同步构建文档：

```console
python3 -B remake/runtime/tools/sync_tool_docs.py
```

只读核对构建文档：

```console
python3 -B remake/runtime/tools/sync_tool_docs.py --check
```

只增量导出人物原始逐帧阴影：

```console
python3 -B remake/runtime/tools/export_map_shadows.py
```

## 执行语义

不加`--run`只列计划。`--validate`检查工具、既有来源台账与产物，记录当前指纹到`evidence/export_inventory.json`；不执行导出，也不等于原输入已经与历史来源逐项一致。

`--run`按依赖执行，命中缓存仍核对产物存在及SHA。缺失、手改或输入变化会触发对应任务；每个成功步骤即时保存，失败可续跑。调度依赖仅决定顺序，缓存按声明的实际输入与导出器的本地导入链计算，不再把全部工具及全部core模块纳入每个步骤。地图／玩家／舞台等登记按对应字段计算指纹，新增地图不会仅因共用runtime_content.json使玩家素材失效。

资源缓存位于`evidence/resource_cache`：角色动作／图层帧、技能特效、地图／地图人物／物件帧、阴影、生命周期、道具表现、舞台帧、MNU页面及菜单／对白源帧、音频和剧情媒体各自登记来源／配方指纹、描述与输出SHA。命中后跳过解码、转码与原像素重审，复用首次成功的验证记录；源或规则变化才重新生成，缺失／损坏产物按该资源修复。GDI字体仍按所需字符集生成；所有已接入的PNG／JSON写入均保留内容相同的旧文件及修改时间。总清单按当前登记合并，生成结果不变时不写盘。

旧步骤缓存首次切换为v2时需要重新核验并登记资源缓存；这次初始化可能仍有解码／验证耗时，但相同PNG和清单保持原字节与修改时间。后续重复构建直接复用。不要仅凭文件存在接纳未核验产物，也不要删除现有缓存来开始日常构建。

只读查看选定依赖链的缓存状态：

```console
python3 -B remake/runtime/tools/build_runtime.py --target content --explain
```

原因显示`no-cache`／`inputs-changed`／`outputs-changed`／`cached`；实际运行另记资源的`new-resource`／`source-or-recipe-changed`／`missing-or-modified-output`及生成／复用数量。构建入口使用系统文件锁，避免两个统一构建同时写同一份清单；进程退出后自动释放。

战斗图集默认追加：校验旧页面SHA并复用旧图块坐标，新像素只生成新增页面；新角色共享旧特效时复用旧页，不因使用者集合变化移动旧图块。首次从既有图集建立图块索引会读取旧页面；索引命中后不再逐页解码。缺失／损坏页面从保留源图与原坐标恢复并核对原SHA。旧页面及暂时无引用的文件不会自动删除；需要集中整理时显式执行：

```console
python3 -B remake/runtime/tools/export_battle_packs.py --repack
```

追加会保留一些空余空间和旧页，`--repack`才重新排版；日常接入不使用。新／变化图像逐像素重构核对，`--force`另对全部源图执行重构检查，同时保留页面布局。

`--force`与`--run`一起强制重建，仍保留当前parameters。配置`--reset`才恢复原值，正常接入不使用。

配置导出自动迁移旧完整格式，当前skills／items为v3、battle／rewards为v2：只保存身份与修改项，来源指纹在文件级集中登记。普通导出补齐新增角色／怪物的技能、属性、AI及奖励，保留旧调参并剔除等于默认值的冗余项；未知编号、身份或来源漂移在任何写入前拒绝。`--reference` <skills|battle|rewards|items> [编号]只读显示来源默认值与生效值，不生成或修改配置。配置`--reset`清空修改项并恢复original模式。

正式游戏页面仅在启动时读取并编译配置，菜单、战斗与技巧测试复用启动快照并取得独立副本。修改参数或切换original／debug模式后刷新页面；返回标题、开始新游戏和读档不会重新加载。导出／reference工具每次调用仍读取当前文件。

`--check`须与`--run`一起使用，在成功后执行verify_current；8767服务需要先开启。

`--preflight`独立使用，检查已有源表的接入能力，不导出、不写报告、不核验原媒体；新地图没有源表时先构建chapter-story。显式入口发现未知能力返回非零退出码；旧隐式NPC仅提示，显式npcs进入阻断检查。

`--target all --run`选择所有目标，仍按缓存复用；`--force`才强制执行。日常文档维护无需重导素材。

## 登记驱动的生产

`runtime_content.json`为唯一运行接入选择；运行素材导出器直接读取它选择地图／角色／程序，来源解析器再从已生成数据编译最终运行登记。

fire-valley-index独立于运行登记扫描`Map/*.dat`、`Map/*.TLK`及`Animate/*.anm`（扩展名不区分大小写）；中文来源地图名提名种子，DAT真实连接确认同来源族内地图，编号前缀只限定候选范围。生成`web/data/library/fire_valley.json`和`evidence/fire_valley_20261024/source_index.json`，不执行剧情或开放地图。索引保留地图变体、NPC原槽／加载站位／可见性、TLK分支／选项、跨地图旗标和ANM位置变更；DAT+0x8A加载入口与+0x13A到达入口独立登记。能力缺口按原字段／指令定位，完整可玩程度仍由正式登记、预检查和实际流程验收决定。

story-media从登记ANM及显式来源准备集合m17010-3／m17030-1的原74字节指令读取opcode60视频、opcode62非空声音；`--source-program`可追加只准备不登记的ANM。生成`data/story_media.json`与`evidence/story_media_export.json`，保留原文件名小写键及逐指令引用，不推断剧情可达或演出时序。BIK转浏览器视频逐帧完整解码核对尺寸／帧率／帧数／时长与SSIM，音频核对完整PCM；原.wav若实为MP3，字节复制至真实.mp3后缀。`--reuse-existing`仍执行完整验证；`--verify-only`只读重核来源、清单、媒体SHA和完整解码，不重写媒体或报告。

chapter-maps按`maps.export`归属准备地图、NPC、物件和源物理出口；chapter-story保留全部chapter资产地图的DAT表，按story和programs准备TLK／ANM、被引用道具与登记玩家初值。无TLK且无物件的通路同样需要原入口标记；records为空，不生成虚构对白或自动开放入口。

white-forest-index复用来源解析与跨区域调用扫描，以原地图名称精确匹配“白木森林”，输出`data/library/white_forest.json`及`evidence/white_forest_20261026/source_index.json`；不纳入“里白木森林”。索引保留全部96个原物件记录与原字节。`export_white_forest_index.py`同样支持`--check`／`--query`／`--map`／`--flag`，只读查询不开放运行内容。

地图没有TLK但登记了keyed-chest时，chapter-story仍导出真实DAT物件／入口表，明确dialogue_status=source-file-absent、source=null与零条对白；不虚构TLK或空剧情流程。物件奖励与钥匙定义从已登记CF4的原F2与十个奖励槽推导。

story-check在源表、初始角色和怪物准备后检查已登记的进入剧情、触发器、箱子、休息、出口和显式NPC的可达分支，报告地图／入口／记录号，阻断未实现机制；最终content再次检查。

battle-stages按stages选择新舞台的SCN／DGP，默认ID路径，不维护每个舞台的素材名单。当前支持SCN v2／mode4及已恢复的零镜头规则；专用旧产物默认existing，可显式export:"source"使用通用导出。

enemies按登记敌人实际学习表生成属性／AI／反应／状态／图层；enemy-rewards读取经验和奖励槽；encounters读取登记地图的DAT／STG池。音频按登记地图及动作生成。

party-skills读取新enemy清单组合正式party反应／表现；敌我复用源图集和独立像素校验，历史forest_full_battle_view／forest_reactions保留。

content目标贯通玩家、怪物、地图、剧情、配置、资源图集、声音、菜单／对白／字幕字体、地图光效、目录与最终登记。新增技能／道具数值仍只进入统一config。

已恢复格式、未知指令／状态／掉落、局部遇敌分区和新舞台的边界见[config_guide.md](../config_guide.md)；登记不会补实现。

## 前置与来源

按任务准备环境：静态服务使用Python 3标准库；verify_phaser需要`Node.js`，脚本内部会调用当前Node执行语法检查。

素材导出另需Pillow；startup-media／story-media还使用NumPy；音视频转换需要FFmpeg／FFprobe；GDI字体导出和部分原版观察需要Windows。完整回归还依赖当前Node的node:test／WebCrypto及各专题工具所需环境。

可先运行python3 `--version`和node `--version`；涉及媒体时再核对所需Python包、FFmpeg／FFprobe或Windows组件。当前尚无统一锁定环境与已验证的跨平台首次安装命令，单个实验依赖文件不能代表全部构建环境。

本入口接管已有基础内容与来源台账，不是从空目录自动重建原游戏的安装器。初始路线／基础资源提取、原资源和save_analysis仍有实际依赖；基础导出器已位于本目录，不再读取prototype。

声明原输入的新步骤可建立首份台账；其他步骤需要既有来源报告。路径、哈希、原像素／解码或未知格式校验仍由对应工具负责。

来源与历史材料的用途、准备及恢复统一见[local_materials.md](../../local_materials.md)。材料不足时先执行无素材预检查；仅列计划不能证明首次构建可执行，`--target` all `--run`也不会自动补齐来源。首次构建任务和完成标准见[validation_design.md](../../assessment/validation_design.md)。

生成的运行表和素材不手工调参；普通配置导出迁移已核对基线并保留parameters。仅参数变化无需重建图集。

## 构建台账

旧台账中的已迁移源码、清单、素材和证据路径按`layout_migration.json`解析到正式目录；原记录及SHA保持不变，迁移映射也参与构建签名。

声明依赖与签名由`build_runtime.py`维护，状态写`evidence/build_state.json`；每次运行在`evidence/builds/`<UTC时间-唯一ID>/记录`run.json`、实际步骤日志及`步骤.resources.json`资源明细。状态、单资源缓存和运行清单以临时文件原子替换；失败不会登记为已完成资源。

历史来源清单位于`web/data/source`，保留原字节与历史引用；当前正式清单使用/assets路径。迁移映射在`layout_migration.json`，旧原型证据迁到`evidence/source`。

日期命名证据如被导出器重新生成，构建入口先保存到该步骤generated-evidence，再恢复旧文件原字节。失败也保留诊断；不要将旧报告重绑成新观察。

当前剧情台账为`chapter_story_export.json`，怪物为`enemy_content_export.json`／`enemy_rewards_export.json`，遭遇为`encounter_export.json`；具体reports／inputs／outputs以STEPS为准。

旧五份提取基线保存在`evidence/export_tools_20261022/legacy_extractions`并按历史SHA核对，当前生成文件按新台账检查。

直接执行历史导出器不经过日期保护，需要先查看其代码和输出范围。

## 目录迁移与基础来源

共享解析器位于`remake/runtime/tools/source`：`dgp.py`、`map_data.py`、`map_objects.py`、`combat_resources.py`。

移动模块、解码器、基础导出器和三份基础清单已随代码迁移；`web/data/source`中的清单保留原始导出字节和历史引用。它们是构建来源，不是新增地图或剧情的编辑入口；内容登记仍使用`web/data/runtime_content.json`。

正式素材统一使用/assets/路径。正式服务8767只挂载`remake/runtime/web`；实验单独运行python3 -B `remake/prototype/serve.py`，默认8765，复用正式模块和媒体。

## 旧环境升级

以下命令从新版本项目根目录执行。迁移脚本只复制本地媒体和证据，源码及基础清单由版本更新提供。

1. 默认只盘点，不写文件：

   ```console
   python3 -B remake/runtime/tools/migrate_local_materials.py
   ```

   从另一个旧项目交接时，先对该目录盘点：

   ```console
   python3 -B remake/runtime/tools/migrate_local_materials.py --source-root "/path/to/old-project"
   ```

2. 按相同来源执行复制：

   ```console
   python3 -B remake/runtime/tools/migrate_local_materials.py --run
   ```

   跨目录交接使用：

   ```console
   python3 -B remake/runtime/tools/migrate_local_materials.py --source-root "/path/to/old-project" --run
   ```

   `remake/prototype/web/assets` → `remake/runtime/web/assets`

   `remake/prototype/evidence` → `remake/runtime/evidence/source`

   原文件保留，同SHA目标复用；发现同名不同内容报错，不覆盖。存在旧文件时，`--run`会把来源、目标、SHA及处理状态记录到`remake/runtime/evidence/layout_migration/`<UTC时间>.json。

   files=0表示选定来源中未找到可迁移文件；该结果不检查新目录中的素材是否齐全。迁移也不会生成缺失媒体或补全原版输入。

3. 素材齐全的环境检查新路径、图集、指纹和尺寸：

   ```console
   node remake/runtime/tools/verify_phaser.mjs --assets
   ```

   只有代码时可省略`--assets`运行预检查，并使用正式服务的`/phaser-preview.html`；报告中的`assets.passed`仍反映素材实际情况。

4. 启动正式服务，再按[README.md](../README.md)的正式路线验证剧情、战斗和存读档：

   ```console
   python3 -B remake/runtime/serve.py
   ```

   真实素材实玩、Windows启动与首次构建的完成情况见[validation_design.md](../../assessment/validation_design.md)；迁移本身不改变这些验收结论。

## 基础导出入口

```console
python3 -B remake/runtime/tools/extract.py
python3 -B remake/runtime/tools/export_movement.py
python3 -B remake/runtime/tools/export_combat_lab.py
python3 -B remake/runtime/tools/export_combat_presentation.py
```

这些独立入口读取对应原输入和保留来源证据，写入`remake/runtime/web/data/source`、`remake/runtime/web/assets`及`remake/runtime/evidence/source`；构建边界见“前置与来源”。新增正式内容继续使用`build_runtime.py`，不在prototype新增生产工具。

## 工具导航

分类见[工具索引](tool_index.json)，记录构建目标、共享导入关系及独立工具用途。新增／迁移工具时人工维护path、role、imported_by及历史恢复字段；不根据命名猜测用途。

`sync_tool_docs.py`从`build_runtime.STEPS`及plan生成registered_steps、content_plan、各工具build_targets和下方依赖清单；其余字段保留。默认同步，`--check`发现过期内容或索引遗漏时非零退出，不运行导出、不改素材或证据。实际构建计划始终以`build_runtime.py`为准。

daily-entry：常用构建／检查／文档维护入口；standalone-check：不属于统一构建的独立检查。

registered-build：统一构建中的生产步骤。

shared-current：当前步骤或检查仍导入的素材助手。source-decoder：source/中的共享只读DGP、DAT、地图物件与CHR解析器；正式导出与实验验证共用。

specialized-evidence-check：专题验收和日期观察复核，按各工具代码检查范围；不是每日全部执行的命令。

fixture-or-observation-preparation：创建独立样本或原版观察副本，不等于正式获取／入队流程。

source-observation：只读检查或记录原版，原目录输入保持只读。

`resource_inventory.py`盘点原资源目录、文件头、`GAME.exe`的PE导入和已有证据索引，不解码自定义格式；生成报告统一保存在`runtime/evidence`，不写assessment。

`export_map_shadows.py`也是map-effects构建步骤的共享助手：从现有`opening/chapter`角色清单及事件NPC取动作组，只新增`assets/map_shadows`与`data/map_shadows.json`，逐帧核对DGP geometry[41]原掩码，保留人物main／intrinsic PNG。按动作全部帧／方向的非空包围盒并集裁剪，shadow_geometry保存原帧偏移及紧凑尺寸；每帧重新展开后与独立原掩码逐像素核对，全空动作跳过。独立命令写`movement_optimization_20261023/shadow_export.json`，不运行全量构建。50%黑色alpha近似原16位背景RGB分量减半；主图／阴影／加色层保持同源帧、锚点及人物depth。

independent-source-export：独立基础来源或旧样本生产入口，可能仍用于初始提取；分类不表示可删除。

## 当前构建目标与直接依赖

下方标记内内容由`sync_tool_docs.py`生成，不手工修改。

<!-- 自动生成：构建目标开始 -->

| 构建目标 | 工具 | 直接依赖 |
| --- | --- | --- |
| `save-menu` | [export_save_menu.py](export_save_menu.py) | 无声明依赖 |
| `opening-seed` | [export_opening_seed.py](export_opening_seed.py) | 无声明依赖 |
| `opening-maps` | [export_opening_maps.py](export_opening_maps.py) | 无声明依赖 |
| `chapter-maps` | [export_chapter_maps.py](export_chapter_maps.py) | 无声明依赖 |
| `chapter-story` | [export_chapter_story.py](export_chapter_story.py) | `chapter-maps` |
| `map-effects` | [export_map_effects.py](export_map_effects.py) | `opening-maps`、`chapter-maps` |
| `party-combat` | [export_party_combat.py](export_party_combat.py) | `story-check` |
| `party-skills` | [export_party_skills.py](export_party_skills.py) | `party-combat` |
| `party-rewards` | [export_party_rewards.py](export_party_rewards.py) | `party-combat`、`enemy-rewards` |
| `items` | [export_chapter_items.py](export_chapter_items.py) | `opening-seed`、`chapter-story`、`enemy-rewards` |
| `item-presentation` | [export_item_presentation.py](export_item_presentation.py) | `items`、`party-skills` |
| `recovery` | [export_chapter_recovery.py](export_chapter_recovery.py) | 无声明依赖 |
| `audio` | [export_audio.py](export_audio.py) | `party-skills`、`item-presentation`、`battle-lifecycle`、`chapter-maps`、`encounters` |
| `forest-stage` | [export_forest_stage.py](export_forest_stage.py) | 无声明依赖 |
| `menu` | [export_operation_menu.py](export_operation_menu.py) | `items`、`party-skills` |
| `battle-ui` | [export_battle_ui.py](export_battle_ui.py) | 无声明依赖 |
| `battle-lifecycle` | [export_battle_lifecycle.py](export_battle_lifecycle.py) | 无声明依赖 |
| `skill-test` | [export_skill_test.py](export_skill_test.py) | 无声明依赖 |
| `battle-result` | [export_battle_result.py](export_battle_result.py) | 无声明依赖 |
| `battle-packs` | [export_battle_packs.py](export_battle_packs.py) | `party-skills`、`item-presentation`、`forest-stage`、`battle-ui`、`battle-lifecycle`、`skill-test`、`battle-result`、`battle-stages` |
| `menu-techniques` | [export_menu_techniques.py](export_menu_techniques.py) | `menu`、`party-skills` |
| `menu-fonts` | [export_menu_text_gdi.py](export_menu_text_gdi.py) | `menu-techniques` |
| `startup-media` | [export_startup_media.py](export_startup_media.py) | 无声明依赖 |
| `startup-menu` | [export_startup_menu.py](export_startup_menu.py) | 无声明依赖 |
| `prologue-presentation` | [export_prologue_presentation.py](export_prologue_presentation.py) | `chapter-story` |
| `dialogue-ui` | [export_dialogue_ui.py](export_dialogue_ui.py) | `catalog`、`chapter-story` |
| `world-map-ui` | [export_world_map_ui.py](export_world_map_ui.py) | 无声明依赖 |
| `configuration` | [export_runtime_config.mjs](export_runtime_config.mjs) | `party-skills`、`enemy-rewards`、`encounters`、`source-catalog`、`items`、`source-magic` |
| `catalog` | [build_catalog.py](build_catalog.py) | `configuration`、`chapter-maps`、`content-library` |
| `content` | [export_content_registry.mjs](export_content_registry.mjs) | `catalog`、`party-rewards`、`battle-packs`、`audio`、`menu-fonts`、`save-menu`、`dialogue-ui`、`prologue-presentation`、`map-effects`、`story-media` |
| `enemies` | [export_enemy_content.py](export_enemy_content.py) | 无声明依赖 |
| `enemy-rewards` | [export_forest_rewards.py](export_forest_rewards.py) | 无声明依赖 |
| `encounters` | [export_encounters.py](export_encounters.py) | 无声明依赖 |
| `story-check` | [check_content.mjs](check_content.mjs) | `chapter-story`、`opening-seed`、`enemies` |
| `battle-stages` | [export_battle_stages.py](export_battle_stages.py) | `forest-stage` |
| `story-pack` | [export_story_packages.mjs](export_story_packages.mjs) | 无声明依赖 |
| `source-catalog` | [export_source_catalog.py](export_source_catalog.py) | `opening-seed` |
| `content-library` | [build_content_library.mjs](build_content_library.mjs) | `configuration` |
| `source-magic` | [export_source_magic.py](export_source_magic.py) | 无声明依赖 |
| `fire-valley-index` | [export_fire_valley_index.py](export_fire_valley_index.py) | 无声明依赖 |
| `story-media` | [export_story_media.py](export_story_media.py) | 无声明依赖 |
| `white-forest-index` | [export_white_forest_index.py](export_white_forest_index.py) | 无声明依赖 |
| `jade-lake-index` | [export_jade_lake_index.py](export_jade_lake_index.py) | 无声明依赖 |

<!-- 自动生成：构建目标结束 -->

## 测试职责与运行

日常回归使用统一入口，默认只运行 `runtime`，不需要原版安装、媒体、历史证据或图像库：

```console
python3 -B remake/runtime/tools/verify_tests.py
```

职责清单位于 [tests/suites.json](../tests/suites.json)。每个测试文件只登记一次，`daily` 是 `runtime` 的别名；运行前始终检查清单是否遗漏、重复或引用已删除文件。

| 组 | 适用改动与前置 |
| --- | --- |
| `runtime`／`daily` | 战斗、事务、时钟、菜单、存档状态与运行配置规则；只使用提交的代码和结构化数据 |
| `content` | 地图／NPC阶段矩阵、内容登记、配置迁移与运行包；只使用提交的数据，包含耗时较长的区域遍历 |
| `source` | 原版字节、独立解码和原指令差分；需要原版输入及各文件声明的本地证据，部分 Python 检查需要 Pillow／NumPy |
| `assets` | 真实媒体加载与绘制合同；需要生成媒体，不能替代浏览器实玩 |
| `integration` | 本地 HTTP／磁盘存档和构建器集成；需要允许监听回环端口，构建模块当前还依赖原版输入及图像库 |
| `history` | 历史录制与区域交接档重新生成核对；需要保留的报告、存档与当时生成器，不代表当前版本的新观察 |
| `all` | 上述全部组，交付时在前置齐全的环境执行；任一失败或跳过均不算完整通过 |

按改动组合执行，或在已选组内用文件名通配符缩小范围：

```console
python3 -B remake/runtime/tools/verify_tests.py --suite content
python3 -B remake/runtime/tools/verify_tests.py --suite runtime --suite content --match '*battle*'
python3 -B remake/runtime/tools/verify_tests.py --suite source --list
python3 -B remake/runtime/tools/verify_tests.py --suite all --report
python3 -B remake/runtime/tools/verify_tests.py --check
```

`--match` 适合定向反馈，不能代替跨模块修改或交付所需的相关整组检查。已声明的前置缺失时，入口先合并列出缺项并非零退出，不执行部分测试后冒称整组通过；来源检查内部仍会核对具体原文件与指纹。清单声明的是环境与已知入口材料，不能替代导出器的完整来源审计。

默认只输出结果。`--report` 在 `runtime/evidence/test_runs` 创建新的运行目录，保存摘要、源码／数据指纹和 JS／Python 日志；运行期间指纹变化则本次结果无效。测试本身不写固定日期报告，`preserve_history.mjs` 仅保留旧命令的兼容入口，不修改文件系统 API。当前完整检查 `verify_current.py` 复用同一清单，另写其现有 current 汇总文件，不再用固定测试数量作门槛。

新增同机制地图、NPC、箱子或技能时，优先扩充内容与共享案例表；新通用机制、高风险回归或跨模块边界需要新的行为断言时，再扩充对应测试。常规测试辅助代码放在已提交的 `tests/helpers`，不得导入被忽略的历史目录中的执行代码。精确重放旧交接档的生成器依赖仅限 `history`，其原字节与前置需保留。独立来源解码器与规则／视图／集成边界分别保护不同风险，不按文件名相似或代码行数合并删除。

浏览器验收继续从正式 `/` 入口完成计划要求的剧情、战斗、退出与存读档，并保留当版源码／配置／媒体指纹。上述自动测试和旧观察复核均不自动完成这一步。

## 当前检查覆盖什么

Phaser无素材预检查：node `remake/runtime/tools/verify_phaser.mjs`。核对固定运行库指纹、正式／预览入口模块图与JS语法，并报告现有JSON所引用的素材缺失。默认允许缺失素材，输出分别标明`code.passed`与`assets.passed`。

有素材交接检查：同一命令加`--assets`，要求素材齐全且已声明SHA／PNG尺寸匹配。`--report` <`runtime/evidence`内路径>可保留完整JSON报告。浏览器预览为`/phaser-preview.html`，正式流程验收仍从/进入。

战斗单帧逻辑路径按`battle_packs.json`解析到实际图集页，检查沿用BattleResources的图集定义校验；运行交付无需在图集之外重复提供这些单帧源PNG。地图、菜单、字体、音视频等直接加载的媒体仍须提供。

无素材时默认命令可在`code.passed`=true、`assets.passed`=false时成功退出；`--assets`在素材缺失时失败。两者都不表示完整主线已通过实玩验收。

verify_current检查JS／Python回归、Python语法、原输入、保留资产、现有导出台账、配置／登记、HTTP资源和归档，写`current_validation.json`、`current_validation.tap`和`current_python_tests.log`。

检查需要8767服务，数量和时间以报告为准。它核对历史浏览器观察及指纹，不重播UI，不运行原`GAME.exe`，不会自动完成后续剧情。

缺少原版输入／历史evidence时，verify_current可能在来源核对阶段终止；不沿用旧current_validation作为当前Phaser通过记录，应另存本轮预检查与限定范围浏览器结果。

规则／事务变化运行对应回归；实际页面／动画变化另做浏览器观察。独立页面在`web/tests`，包括`battle_loading.html`、`dialogue_alignment.html`和`startup_storage.html`，各有其限定范围。

verify_*中的旧阶段门槛不能替代当前回归；写`--record`的新现场按工具说明生成，已冻结观察不重写。

## 常见问题

全量内容补缺：source-catalog遍历全部CHR并核对EOF／逐字节重组，source-magic保留`System.MAG`的41条原记录，items继续维护原道具目录。configuration只补齐新条目并保留旧ID及调参，content-library生成来源与统一配置的关联索引；content构建已包含这些步骤。需要保留的REA证据及边界见`evidence/source_library_20261023`，原始游戏输入只读。

独立复核：`export_source_catalog.py` `--check`、`export_source_magic.py` `--check`及`build_content_library.mjs` `--check`。前两项核对当前原输入及保留原生证据，最后一项核对索引与当前来源／配置。独立工具不导出媒体、不自动开放角色／技能或改写存档。

登记未编译：执行content `--run`后刷新；只运行catalog不会编译最终登记。

缺少原输入或来源台账：按报错恢复对应来源／基础提取；不跳过来源校验。

未知行为：先实现并验证规则，再登记；不改raw记录或放宽校验来绕过。

配置原版模式拒绝差异：恢复parameters原值，或明确使用debug验证；模式不重置用户进度。

生成资源缺失或指纹变化：检查对应步骤日志及产物，针对性重建。文件路径迁移必须同步工具、索引与引用。

历史证据不匹配：只表示代码时点不同，需要新观察；不改旧报告使其看起来匹配。

## 资料维护

来源证据、现场记录及历史归档的目录、准备方式与缺失处理统一见[local_materials.md](../../local_materials.md)；可选本地索引或旧压缩包不作为当前命令的唯一说明。

assessment分别维护当前计划[validation_design.md](../../assessment/validation_design.md)、界面验收方法[menu_alignment_workflow.md](../../assessment/menu_alignment_workflow.md)及区域重制经验[region_remake_workflow.md](../../assessment/region_remake_workflow.md)；旧兼容跳转页已清理。清理文件及迁移工具的原路径、SHA与Git恢复版本见`tool_index.json`的retired_documents和工具previous_path字段。

`verify_runtime_config.py`的复核文字报告输出到`evidence/runtime_config_recheck.txt`，不再生成assessment下的旧跳转页。

## 剧情运行包

`export_story_packages.mjs`从已保留的TLK／ANM来源台账与`runtime_content.story`登记的独立事件／任务编译`web/data/story`；原字节一致性在构建时核对，地图剧情按需加载。content最终编译自动执行此步骤；只改独立事件、任务或story登记可用`build_runtime.py` `--target` story-pack `--run`，不需要原版安装。地图、角色或ANM登记变化仍需完整content构建。

只读核对剧情包生成结果：

```console
node remake/runtime/tools/export_story_packages.mjs --check
```

`verify_phaser.mjs` 已包含该检查。新增文字还需相应字体构建。完整编写规范与现有任务样本见[story_guide.md](../story_guide.md)。
