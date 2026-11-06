# 第七封印 · 构建、导出与验证

命令从仓库根目录执行，示例使用Python 3和Node.js；Windows可将python3换为python或py -3。正文中的web／tools／evidence相对runtime；remake开头的路径相对仓库根。

## 环境与前置

| 操作 | 前置 |
| --- | --- |
| 本地游戏服务 | Python 3.12+、Pillow，首次素材构建完成 |
| 代码／剧情包预检查 | Node.js；`verify_phaser.mjs`默认允许媒体缺失，分别报告code与assets |
| 首次素材构建 `media` | `--original-dir` 指定完整原版目录；`runtime/requirements.txt` 固定 Python 依赖，Node.js、FFmpeg／FFprobe；内置字库随仓库提供 |
| 开发用规则／来源重导出 | 对应原版输入和来源台账；沿用原有开发目标及其环境要求 |
| 原字体GDI导出、部分原版观察 | Windows及对应组件 |
| 开发目标声明及文档同步 | 导出依赖需安装；来源发现延迟至实际输入核验，列计划和文档同步不读取原版文件；首次 `media` 帮助只用标准库 |
| 来源、真实媒体、历史专项 | 检查声明的原文件、媒体、证据与环境；HTTP／保存集成需本地服务 |

首次构建使用 `media` 目标，只从原版提取素材，读取仓库中固定的规则、数值、剧情和字库，不读取历史台账、观察存档或 GDI。`content`、`all` 等仍是开发用内容重导出目标，保留各自的来源审计依赖。

## 首次素材构建

安装固定依赖的命令见[根 README](../../../README.md#本地运行)。指定原版目录，不加 `--run` 时只读检查完整资源配方、原版缺项、指纹、内置字库和环境：

```console
python3 -B remake/runtime/tools/build_runtime.py --target media --original-dir "/path/to/DiQiFengYin"
python3 -B remake/runtime/tools/build_runtime.py --target media --original-dir "/path/to/DiQiFengYin" --run --serve
```

默认先对照已提交的 `tools/media_inputs.json`，按文件清单和 SHA-256 核验来源；缺少基准文件、内容变化或多出素材均返回非零，在任何媒体写入前停止。基准覆盖 `GAME.exe`、安装根目录的背景 DGP，以及 Animate、anilink、Fight_Bk、Fight_Role、Font、Map、mapm、picture、ROLE、sound、System 目录的全部文件。文件名大小写和背景 DGP 的根目录／Map 位置归一化；玩家存档、日志、临时文件和系统杂项排除，安装器、驱动及第三方启动器不纳入游戏素材基准。

确认使用另一份来源时显式加 `--ignore-fingerprint`。该选项只放行来源清单／指纹差异，仍检查必需原文件、内置字库、解码、固定 PNG／图集和音视频转换；无法兼容的资源仍会失败，不生成占位内容。修改过的来源不会用旧图片缓存或同指纹别名掩盖，已按同一输入与配方验证的缓存可以复用。

```console
python3 -B remake/runtime/tools/build_runtime.py --original-dir "/path/to/DiQiFengYin" --ignore-fingerprint --run
```

维护者确认完整原版来源后，可生成新的基准。此操作只更新 `tools/media_inputs.json`，保留规则、剧情、数值、旧来源指纹和历史证据，随后退出；无需 Pillow、FFmpeg 或 Windows。不能与 `--run`、`--serve`、`--force`、`--images-only` 或 `--ignore-fingerprint` 同用：

```console
python3 -B remake/runtime/tools/build_runtime.py --original-dir "/path/to/DiQiFengYin" --write-reference
```

基准由维护者选择并验证，指纹只证明与基准一致，不自动认定发行版本或资源可信度。修改基准后需随代码提交该 JSON；普通素材构建不会重写它。

`--serve` 在素材构建及 `verify_phaser.mjs --assets` 通过后启动正式服务；可加 `--port`、`--save-dir`。后续直接运行 `serve.py`。原版文件保持原位，只读访问；路径按 Windows 文件名解析，兼容目录和文件大小写以及已声明背景 DGP 的根目录位置。

固定定义中的媒体描述决定物件初始帧、动作分区、图层、裁切和图集坐标。构建不重写 `web/data`、`web/content` 或数值调参。PNG 按固定清单核 SHA；音频保留 MPEG 字节或核转码前后 PCM，影片核帧数、时长及画面质量。音视频编码后的实际指纹写入 `assets/media_manifest.json`，与固定规则的原来源记录分开；来源基准 SHA、实际输入清单、缺失／变化／多出项和是否显式放行记入该清单及构建报告；`source_variants` 继续保留相对固定定义历史来源的差异。

`runtime/.cache/media` 保存可核验缓存，失败可续跑；缺失或损坏输出重建，`--force` 重新提取但不重置调参。战斗图集按已提交页面布局直接从解码像素恢复；其余静态图片按素材目录／使用范围生成纹理页，动画按逻辑帧裁切，大图离线分页，重复页面共享物理文件。字体、感应平面和需要直接读取的遮罩保持专用图片。`assets/image_catalog.json` 将原逻辑路径映射至纹理页，构建不要求散 PNG 中转；现有散 PNG 可作为经核验的迁移输入，旧文件不自动删除。正式交付文件以 `assets/media_manifest.json` 的 `files` 为准，`images` 记录逻辑图片指纹。

`--images-only` 只用于定向排查图片；该结果不记完整首次构建通过。完整构建缺少已声明音视频时返回非零，不生成占位素材。工具与报告入口为 `media_definitions.py`、`media_fingerprints.py`、`image_atlas.py`、`export_media.py` 和 `evidence/builds/<本次 media 构建>/run.json`。

## 常用操作

| 目的 | 命令或目标 |
| --- | --- |
| 启动 | `python3 -B remake/runtime/serve.py` |
| 首次素材构建并开玩 | `build_runtime.py --target media --original-dir <原版目录> --run --serve` |
| 独立存档验收 | `serve.py --port 8786 --save-dir remake/runtime/evidence/<本次验收>/saves`；使用空目录，与玩家存档分开 |
| 无媒体代码预检查 | `node remake/runtime/tools/verify_phaser.mjs` |
| 实际媒体核对 | 同上加`--assets`，再做正式浏览器流程 |
| 新内容完整生产 | `python3 -B remake/runtime/tools/build_runtime.py --target content --run` |
| 沿固定规则追加支线来源 | `python3 -B remake/runtime/tools/build_runtime.py --target side-content --run` |
| 仅独立事件／任务 | build_runtime目标`story-pack --run`；地图／角色／ANM变化走content |
| 查看目标计划／缓存原因 | build_runtime加`--target content --explain`，不导出 |
| 同步／核对派生工具文档 | `python3 -B remake/runtime/tools/sync_tool_docs.py`；只读核对加`--check` |
| 预览日常检查范围 | `python3 -B remake/runtime/tools/verify_tests.py --list --explain` |

### 游戏存档

正式服务的存档目录仍为`remake/saves/`。普通槽00～19对应原版文件`SaveGame0.Dat`～`SaveGame19.Dat`，F4／F5使用快速档`Game.SAV`；读取、保存、导入与导出都使用原版v2二进制格式。可将原版普通档或快速档复制到对应目录后读取，JSON文件和浏览器旧档不再自动读取。

[native_save.py](../native_save.py)负责原版格式与游戏状态的转换；剧情、菜单、战斗及奖励使用恢复后的当前状态，来源标记不决定流程资格。HTTP与磁盘验收使用`--save-dir`指定独立目录，保留玩家目录供正常游戏使用。

普通／快速保存和游戏内导出会把服务端当前北京时间写入文件头的16字节时间区，与累计游戏时长分开。读取优先使用文件内有效日期，旧档无有效日期才回退到文件修改时间；复制存档不改变已嵌入的日期。该时间区用作保存日期属于重制版约定，原GAME对此字段的语义和动态兼容尚待核实。单纯解析、格式往返或修复不会自动补写日期。

已有重制版JSON档使用一次性工具`migrate_native_saves.py --backup-dir <saves之外的新目录>`预览；加`--apply`后安装原版格式、移除已转换JSON。输入文件和被覆盖的测试档均备份至指定目录，正式游戏不依赖迁移工具。

早期重制版写出的原版格式坏档使用`python3 -B remake/runtime/tools/repair_native_saves.py --save-dir remake/saves --backup-dir <saves之外的新目录>`预览；先备份全部输入并生成候选和逐段字节校验报告，加`--apply`才原地安装。保留原文件名（包括自行编号的`SaveGame31.Dat`）及修改时间，修复角色身份／队列、地图人物初始化字段及原版加载进度总量，保留人物当前姿态、路线与AI进度；仅已识别旧缺失身份签名且设置八字节全零的档恢复默认声音设置，健康原版静音设置保持原值。HP、成长、装备、背包、旗标、事件、技巧及累计时间按允许修复字段外的字节不变校验，正式游戏不依赖该工具。 对已确认由旧重制版把时长写到SYSTEMTIME、原版计数仍为零的档，额外加`--restore-missing-play-time`将已有时长恢复到`+0x7D`；该选项只处理身份完整、内部时间块前四WORD及毫秒为零、原版计数为零的已知写档形态，非零原生计数保持不变。

### 新地图接入顺序

```console
python3 -B remake/runtime/tools/build_runtime.py --target chapter-story --run
python3 -B remake/runtime/tools/build_runtime.py --target content --preflight
python3 -B remake/runtime/tools/build_runtime.py --target content --run
```

preflight只读已有源表，不导出、不写报告、不核原媒体；新地图须先准备来源。显式入口未知能力返回非零，旧隐式NPC只提示；正式登记与最终内容编译继续检查全部可达分支。

`side-content`用于沿已提交规则追加地图、原NPC、ANM及奖励来源。它核对当前`GAME.exe`固定SHA、全416条ITM原字节和所有取得路径，复用共同地图／图层解码器与已验证音视频载体，重新计算道具准入、配置、资料库、音频绑定和剧情包；最后仍执行`export_content_registry.mjs`的完整能力及资源闭包检查。已有调参保留，玩家存档不参与。现存历史原生查询继续保留；缺失查询在本轮报告明确列出，不补造旧Evidence记录，也不把当前原字节快照称为重跑反编译。石像、数字符盘及赌场的固定 PCM 音效在音频刷新步骤通过既有媒体转码器导出，并逐一核对原始与导出 PCM；原名 Random.wav 缺失时登记静音，不替换 Random_old.wav。其他新增战斗规则、角色、尚未恢复的玩法或实际音视频载体仍须走各自完整来源导出；这个目标不会放行未知能力。

剧情ANM字面引用不存在的声音时，来源发现将原文件名和调用者写入`story_media.json.missing_sounds`，只对这份明确清单静音继续声音命令，保留地图音乐释放／恢复时序；不会用近名文件替换。缺失视频仍拒绝构建。补回原声音后重新发现来源并完整导出该载体，缺失声明随之移除。

### 参数与内容查询

```console
node remake/runtime/tools/export_runtime_config.mjs --reference skills yantu
node remake/runtime/tools/export_runtime_config.mjs --reference items 4
node remake/runtime/tools/build_content_library.mjs --query roles 004
node remake/runtime/tools/build_content_library.mjs --query search 海皇印 items
node remake/runtime/tools/export_content_registry.mjs --check
node remake/runtime/tools/check_content.mjs --json
```

参数查询支持skills／battle／rewards／items，省略编号查整个类别；不导出或修改文件。普通参数导出执行`export_runtime_config.mjs`，保留现有修改。配置编辑和刷新生效规则只在[配置指南](../config_guide.md)维护。

## 来源查询

区域来源索引独立于运行登记。用下表目标生成，对应`export_<区域>_index.py --check`核来源和产物；查询共用`--query`、`--map`、`--flag`、`--limit`。

| 区域 | 构建目标 | 导出脚本 |
| --- | --- | --- |
| 火之谷 | fire-valley-index | export_fire_valley_index.py |
| 外层白木森林 | white-forest-index | export_white_forest_index.py |
| 翠碧湖 | jade-lake-index | export_jade_lake_index.py |
| 炎城 | ember-city-index | export_ember_city_index.py |
| 里白木森林／幻影之森／封印之森 | inner-white-forest-index | export_inner_white_forest_index.py |
| 飘城全时期 | floating-city-index | export_floating_city_index.py |
| 力城／劲风岛／圣山／海岸 | wind-region-index | export_wind_region_index.py |
| 研究所遗迹与地下深层来源 | research-index | export_research_index.py |

```console
python3 -B remake/runtime/tools/build_runtime.py --target ember-city-index --run
python3 -B remake/runtime/tools/export_ember_city_index.py --check
python3 -B remake/runtime/tools/export_ember_city_index.py --query 小吉 --limit 20
python3 -B remake/runtime/tools/export_ember_city_index.py --map M01020A
python3 -B remake/runtime/tools/export_ember_city_index.py --flag 4:12
```

全角色／MAG来源分别用source-catalog／source-magic，引用索引用content-library；上述步骤已纳入content依赖。索引收录不开放角色、技能或剧情。`resource_inventory.py`另盘点原目录、文件头与程序导入，输出`evidence/resource_inventory.json`。

## 构建执行语义

| 选项 | 作用 |
| --- | --- |
| 不加`--run` | 只列依赖计划，仍需入口载入声明所要求的环境 |
| `--run` | 按依赖生产并复用有效缓存；缺失／修改产物或输入变化触发相应步骤 |
| `--validate` | 核工具、既有台账和产物，写`evidence/export_inventory.json`；不导出，不等于原输入与旧来源已全量一致 |
| `--explain` | 显示no-cache／inputs-changed／outputs-changed／cached |
| `--force --run` | 强制生产，保留parameters；配置`--reset`才重置数值 |
| `--check --run` | 成功后调用verify_current；相应前置和8767服务需准备 |
| `--target all --run` | 选择所有目标，仍复用缓存；通常按本次所需目标执行 |

签名按声明实际输入及导出器本地导入链计算，不把全部tools／core纳入每步；登记按消费字段计算指纹。调度依赖只决定顺序。来源／配方或产物SHA不匹配时重建，单凭文件存在不接受缓存。

`evidence/resource_cache`保存逐资源指纹、输出SHA和首次验证；命中后跳过重复解码／转码／像素重审。缺失或损坏按资源修复，内容相同的PNG／JSON不重写。旧步骤缓存初次升级仍可能重新核验；日常不要清空缓存开始构建。

统一构建使用进程文件锁；成功步骤即时保存，失败可续跑。`evidence/builds/<UTC时间-唯一ID>/`保存run.json、步骤日志、资源明细与generated-evidence。顶层日期报告被重新生成时先留新副本，再恢复旧字节；直接调用历史导出器不经过此保护，先确认其输出范围。

### 战斗图集与资源规划

```console
python3 -B remake/runtime/tools/export_battle_packs.py --plan --roles 001,012 --stage stage13
```

plan只用已提交元数据及既有图集区域，不读PNG或写正式产物。entry_existing_atlas／entry_planned估基础入战集合，filtered_existing_atlas／planned估参战角色完整表现；均不含HUD／结算。缺像素时去重可能保守高估，不能当作实际性能。可用`--report`写evidence内新路径，拒绝覆盖旧报告。

正式生产走battle-packs目标：按角色、舞台、HUD／结算及特效使用者集合分组，跨特效去重可见像素。默认追加，保留旧页面和坐标，新像素增加页面；页面损坏按原坐标恢复并核SHA。`--force`重核全部源像素且保留布局，显式`export_battle_packs.py --repack`才集中重排，日常接入不使用。

旧图集仍可运行，重新分组收益须实际重建页面；不手改group冒充。完成后核`--assets`并做正式战斗冷／热、首次行动和离场释放观察。

## 旧环境升级

1. 在新项目根目录盘点旧媒体／来源：

   ```console
   python3 -B remake/runtime/tools/migrate_local_materials.py
   ```

2. 确认来源后加`--run`复制；跨项目在两次命令均加`--source-root "/path/to/old-project"`。

3. 脚本将prototype旧assets复制到runtime/web/assets、旧evidence复制到runtime/evidence/source；原文件保留，同SHA复用，冲突不覆盖。记录写evidence/layout_migration，files=0只表示该来源没找到可迁移文件，不表示新环境素材齐全。
4. 运行`verify_phaser.mjs --assets`，按[项目启动入口](../../../README.md#本地运行)运行正式服务，核受影响剧情／战斗／保存。无媒体时限定代码与示意图检查；迁移不自动完成Windows实机、首次构建或全主线验收。

源码和三份基础清单随版本更新提供，迁移脚本不复制它们。映射见`layout_migration.json`，来源清单保留旧字节和历史路径，不作为新的手工编辑表。

## 工具导航与生产归属

[tool_index.json](tool_index.json)维护工具分类、共享导入者及恢复映射。新增／迁移工具时人工核path、role、imported_by；`sync_tool_docs.py`仅从build_runtime.STEPS和plan更新目标数量、content_plan、build_targets及下方依赖表。

| 分类 | 用途 |
| --- | --- |
| daily-entry | 常用构建、检查和维护入口 |
| registered-build | 统一构建生产步骤 |
| shared-current／shared-helper／source-decoder | 当前复用助手与只读解析器 |
| standalone-check | 不属于构建的独立检查 |
| specialized-evidence-check | 旧观察及专题复核，按其原范围解释 |
| fixture-or-observation-preparation／source-observation | 隔离样本准备、原版观察及只读记录 |
| independent-source-export | 基础来源或旧样本生产，分类不代表可以删除 |
| one-time-save-migration／one-time-save-repair | 旧存档转换或已知错误修复；先预览和备份，显式安装 |

基础导出器extract、export_movement、export_combat_lab、export_combat_presentation已在本目录；正式生产不引用prototype。各自仍需原输入及保留证据，使用前核范围。共享原版资源与存档解析、道具初始化模块在`source/`，通过`source.<模块名>`导入；媒体统一`web/assets/`。

每份共享生成表只有一个生产者；例如状态表由enemies生成，party-skills只校验引用。content贯通地图、剧情、怪物、玩家、配置、表现、声音、字体和最终登记。独立原城镇菜单素材使用native-services目标，已经包含在content中。该目标还登记石像盘面107帧、数字符盘及三种赌场游戏的原 PAK/BMP 图像、原GAME.exe内RT_CURSOR载荷及音效调用字串来源；首次素材构建按pe-cursor配方重建CUR并解码，使用原hotspot，不读取evidence图像。

力城／劲风岛交接使用`node remake/runtime/tools/create_wind_region_fixtures.mjs --from <FF-02结束档> --out <新输出目录>`；`--near-events`仅调整交互附近的玩家坐标和八向朝向。加`--services-only`只准备力城宿屋、普通道具商和合成师的现场样本，保留原资金、背包及角色资源；成功买卖、住宿和合成由正式页面实际操作。

### 原版存档分析

游戏读写使用[原版编解码](../native_save.py)；下列工具用于只读分析与来源核对。

| 目的 | 工具 |
| --- | --- |
| 解析原版存档结构、背包、角色属性和技能 | [source/save_format.py](source/save_format.py) |
| 解析存档中的角色装备实例 | [source/inspect_equipment.py](source/inspect_equipment.py) |
| 读取原版道具定义、检查历史基准样本的背包 | [source/read_inventory.py](source/read_inventory.py) |
| 复用原版道具确定性初始化逻辑 | [source/native_item_init.py](source/native_item_init.py)，供导出器导入 |

从仓库根目录执行；两条命令只读输入，并将解析结果以JSON输出到标准输出：

```console
python3 -B remake/runtime/tools/source/save_format.py /path/to/SaveGame0.Dat
python3 -B remake/runtime/tools/source/inspect_equipment.py /path/to/SaveGame0.Dat
```

存档和装备解析还需要仓库根目录下的`SYSTEM/Object.ITM`；工具会校验其版本指纹。分析指定存档的背包使用`save_format.py`；直接执行`read_inventory.py`只检查其绑定的历史基准样本。

上述源码已从根目录的`save_analysis_20261010/`迁入；旧目录只保留历史本地输入含义，样本与证据准备见[本地资料](../../local_materials.md)。

## 构建目标与直接依赖

自动区由sync_tool_docs.py维护，不手工改表格。

<details>
<summary>展开全部构建目标</summary>

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
| `menu-fonts` | [export_menu_text_gdi.py](export_menu_text_gdi.py) | `menu-techniques`、`enemies` |
| `startup-media` | [export_startup_media.py](export_startup_media.py) | 无声明依赖 |
| `startup-menu` | [export_startup_menu.py](export_startup_menu.py) | 无声明依赖 |
| `prologue-presentation` | [export_prologue_presentation.py](export_prologue_presentation.py) | `chapter-story` |
| `dialogue-ui` | [export_dialogue_ui.py](export_dialogue_ui.py) | `catalog`、`chapter-story` |
| `world-map-ui` | [export_world_map_ui.py](export_world_map_ui.py) | 无声明依赖 |
| `configuration` | [export_runtime_config.mjs](export_runtime_config.mjs) | `party-skills`、`enemy-rewards`、`encounters`、`source-catalog`、`items`、`source-magic` |
| `catalog` | [build_catalog.py](build_catalog.py) | `configuration`、`chapter-maps`、`content-library` |
| `content` | [export_content_registry.mjs](export_content_registry.mjs) | `catalog`、`party-rewards`、`battle-packs`、`audio`、`menu-fonts`、`save-menu`、`dialogue-ui`、`prologue-presentation`、`map-effects`、`story-media`、`native-services` |
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
| `ember-city-index` | [export_ember_city_index.py](export_ember_city_index.py) | 无声明依赖 |
| `inner-white-forest-index` | [export_inner_white_forest_index.py](export_inner_white_forest_index.py) | 无声明依赖 |
| `floating-city-index` | [export_floating_city_index.py](export_floating_city_index.py) | 无声明依赖 |
| `wind-region-index` | [export_wind_region_index.py](export_wind_region_index.py) | 无声明依赖 |
| `research-index` | [export_research_index.py](export_research_index.py) | 无声明依赖 |
| `seal-region-index` | [export_seal_region_index.py](export_seal_region_index.py) | 无声明依赖 |
| `native-services` | [export_native_services.py](export_native_services.py) | 无声明依赖 |
| `items-admission` | [refresh_item_admission.py](refresh_item_admission.py) | `chapter-story` |
| `configuration-refresh` | [export_runtime_config.mjs](export_runtime_config.mjs) | `items-admission`、`encounters` |
| `map-presentation-refresh` | [refresh_map_presentation.py](refresh_map_presentation.py) | `chapter-maps` |
| `audio-map-refresh` | [refresh_audio_map_bindings.py](refresh_audio_map_bindings.py) | `chapter-story`、`native-services` |
| `story-media-refresh` | [refresh_story_media_selection.py](refresh_story_media_selection.py) | `chapter-story` |
| `content-library-refresh` | [build_content_library.mjs](build_content_library.mjs) | `configuration-refresh` |
| `catalog-refresh` | [build_catalog.py](build_catalog.py) | `configuration-refresh`、`content-library-refresh`、`map-presentation-refresh`、`audio-map-refresh`、`story-media-refresh` |
| `side-content` | [export_content_registry.mjs](export_content_registry.mjs) | `catalog-refresh`、`native-services` |

<!-- 自动生成：构建目标结束 -->

</details>

## 测试职责与运行

普通任务默认task，按相对HEAD的工作区、暂存及未跟踪改动选择；先查看原因再执行：

```console
python3 -B remake/runtime/tools/verify_tests.py --list --explain
python3 -B remake/runtime/tools/verify_tests.py --report
python3 -B remake/runtime/tools/verify_tests.py --since HEAD~1 --list --explain
python3 -B remake/runtime/tools/verify_tests.py --changed remake/runtime/web/core/exploration/movement.mjs --explain
```

`--changed`可重复，须列全相关变化；`--domain battle`追加系统范围，可用于干净工作区。动态数据依赖第一版仍保守选便携整组，原版解析器变化追加source。只改文档不启动游戏回归。

| 档位 | 当前自动范围 |
| --- | --- |
| task | 受影响runtime／content／tooling；共享剧情机制变化另加content-full |
| phase | 共享便携组及指定区域content-full；不指定区域则全阶段遍历 |
| release | 除history外全部职责组，需要对应原版／媒体／HTTP前置 |
| audit | source／assets／integration／history |

```console
python3 -B remake/runtime/tools/verify_tests.py --profile phase --region ember-city --report
python3 -B remake/runtime/tools/verify_tests.py --profile release --timeout 1800 --report
python3 -B remake/runtime/tools/verify_tests.py --profile audit --list
python3 -B remake/runtime/tools/verify_tests.py --check
```

当前区域为fire-valley、white-forest、inner-white-forest、jade-lake、ember-city、floating-city。区域参数选择已登记动态遍历，不自动生成阶段事件链或执行浏览器。

| 显式组 | 范围 |
| --- | --- |
| runtime／daily | 运行规则、事务、菜单、时钟与控制器整组，无原安装／真实媒体 |
| content | 内容、配置、运行包和关键区域行为 |
| content-full | 完整区域动态遍历，保留既有保障 |
| tooling | 选择范围、前置、失败和缓存失效的隔离行为 |
| source | 原字节、独立解码、指令与真实地形，需要原输入及声明证据 |
| assets | 实际媒体加载与绘制 |
| integration | HTTP、磁盘存档及构建，需对应环境 |
| history | 旧录制／交接生成器复核，不代表新实玩 |
| all | 全职责含history，仅明确需要时执行 |

`--suite`与profile范围参数分别使用，`--match`可定向筛文件，定向结果不冒称完整档位。例：`--suite source --match '*map_collision*' --list`。前置缺失则所选范围不执行、不以skip称通过。

便携runtime／content／content-full成功结果缓存于runtime/.cache/test_results，第一版绑定全部便携代码／数据／环境；`--fresh`强制执行。来源、真实媒体、HTTP、history及工具自身检查不缓存。`--jobs`默认4，`--timeout`为每文件或准入命令上限；报告区分执行／复用及实际墙钟时间，语言组seconds为文件耗时和。

`--report`只写新的evidence/test_runs目录。`verify_current.py`默认release，与统一入口共用便携结果并核正式资源；旧工作区／归档专项显式加`--legacy-audit`。current_validation.json按scope解读，actual_browser_flow_checked_this_run仍为false，不能代替实玩。

## 资源与浏览器检查

引擎集成检查使用 `/tests/phaser_lifecycle.html`：覆盖实际 WebGL 场景、七类粒子、七种转场、界面合成、超长图集裁切、取消释放和上下文丢失恢复。页面使用合成素材，不代替正式媒体的主线实玩和冷／热性能验收。

`verify_phaser.mjs`核固定运行库、入口模块图、JS语法及剧情包，并报告JSON中的资源引用。默认可在code.passed=true、assets.passed=false时成功退出；`--assets`要求媒体齐全且声明SHA／尺寸匹配。`--report`可写runtime/evidence内新路径。

静态图片逻辑路径由 `assets/image_catalog.json`／`battle_packs` 解析至图集页，交付不要求重复携带已入图集的散 PNG；提供素材构建清单 `files` 中列出的页面、专用字库／感应图及音视频即可。

正式浏览器从`/`执行受影响流程，素材不足可用`/phaser-preview.html`限定示意检查。`/tests/phaser_lifecycle.html`用合成资源验证真实引擎，其他独立页面见web/tests。截图、时间、界面矩阵和报告要求统一见[测试与验收规范](../../assessment/testing_strategy.md#界面与动态表现)。

## 排错与维护

| 现象 | 处理 |
| --- | --- |
| 缺原输入／来源台账 | 按报错和步骤声明恢复；不复制未知报告绕过SHA校验 |
| 登记未编译 | content构建后刷新；仅catalog不足以编译最终登记 |
| 未知条件、动作或物品行为 | 核原来源，先恢复共同处理器再登记，不改raw或放宽校验 |
| original拒绝参数差异 | 恢复修改项，或明确用debug验证；模式不重置玩家进度 |
| 媒体缺失／SHA变化 | 查本次步骤日志，针对性重建；路径迁移同步工具与索引 |
| 历史观察指纹不同 | 保留原范围，新观察另建目录；不改旧SHA获得通过 |
| 文档同步导入失败 | 准备Pillow及构建声明实际读取的原文件；本环境缺材料时说明未执行，自动区保持来源并静态核对 |

文档删除／迁移在tool_index的retired_documents登记原路径、SHA、替代位置及Git恢复版本；历史资料和现行构建输入不能仅按日期删除。旧verify_*只复核其原时点，不能作为当前完整版本验收入口。
