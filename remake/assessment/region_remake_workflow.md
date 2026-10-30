# 第七封印 · 区域重制方法

本文维护可复用流程与来源规则；具体任务、开放范围和状态只在[开发计划](validation_design.md)维护。字段见[剧情指南](../runtime/story_guide.md)与[配置指南](../runtime/config_guide.md)，检查口径见[测试规范](testing_strategy.md)。

## 交付单位

首次处理区域先盘点全部实际时期和变体，再按“区域＋剧情阶段＋完整事件链”实现，优先延长已有正常主线。跨地图的同一演出保留完整调用链；不要求先穷尽同一区域的后期重访和结局。

阶段名只组织排期，运行继续读取原旗标、队伍、物品等事实。来源、登记、行为实现和流程验收分别记录；自然前置接通后才能称“阶段已贯通”。来源交接档可验证局部行为，不能补作区域外旅行和成长历史。

| 远期内容 | 安排 |
| --- | --- |
| 既有机制下的对白、站位、显隐 | 可一起接入，分别记录范围 |
| 前置及交接已核实的独立事件 | 可提前实现，用来源交接档做局部验收 |
| 新复杂机制或外部语义未明 | 保留来源和依赖，随主线安排；无法独立准入的入口暂缓 |
| 已有后期／结局成果 | 保留，正常主线到达后补跨区集成复验 |

## 接入流程

1. **确认已有终点。** 阅读当前diff、计划、未完成构建及本地资料，确认真实输入版本和已验收的主线结束状态，不重置现有调参或用户存档。
2. **全量发现区域。** 用原地图名和真实DAT连接确认成员；前缀仅提名候选。保留原ID、独立变体、无TLK地图和无独立对白的NPC。
3. **提取来源与关系。** 盘点地形、入口标记、各类描述符、物件、NPC、加载／到达TLK和所有选项；扫描全游戏ANM调用者、跨图加载和旗标读写者。
4. **建立阶段矩阵。** 列真实进入条件、地图变体、队伍、NPC差异、任务、奖励使用、演出／战斗、退出／重进及外部依赖。物理出口、TLK传送和脚本加载分开建有向关系；无向连通不证明可达。
5. **选择完整事件链。** 在唯一计划记录稳定编号、包含／暂缓范围、前置和结束状态。已登记入口的全部可达分支须准入，不能按本次存档旗标删分支、跳指令或裁演出。
6. **先恢复能力。** 准备chapter-story源表，运行只读preflight；缺条件、变更、模式或资源时先恢复共同处理器。入口不能独立准入则明确阻断，不新增区域VM或阶段开关绕过。
7. **展开奖励闭包。** 核“取得→实际使用／装卸→再次装备或镶嵌→保存恢复”；学习需对应角色原索引和可执行技能，配方需有真实制作入口、材料与产物。不得为一件奖励泛启用全道具库。
8. **统一构建并检查。** 正式内容走content；只改独立事件／任务可走story-pack。检查当前新增来源、完整入口及真实媒体；修改生成表前确认其唯一生产者。
9. **完成阶段流程。** 通过正式输入或声明的来源交接点，完成进入、事件、战斗、奖励使用、离开／返回、保存重载及关键失败／取消；记录结束存档、样本条件和新指纹。

普通导出保留调参，`--force`不重置配置。构建签名按声明输入和导出器本地导入链计算，调度依赖只决定顺序；共享工作区不要并发运行会写同一生成表的生产任务。步骤和命令只在[工具说明](../runtime/tools/README.md)维护。

## 来源规则速查

以下保留会影响后续区域正确性的共同语义。表中代码路径相对`runtime`。详细推导、历史现场和原生证据可从[本地资料](../local_materials.md)索引及Git基线回查；数值和身份以当前来源文件为准。

| 范畴 | 必须保持的规则 | 当前定位 |
| --- | --- | --- |
| 地图身份与资源 | 原ID可含有源依据的字母、连字符和下划线；素材目录读DAT +0x14E，不从文件名猜。背景复用不合并旗标／NPC身份。 | `tools/source/map_identity.py`、`source/map_data.py`；`web/core/native_map_identity.mjs` |
| 加载与到达 | DAT +0x8A为加载布置，+0x13A为真实到达；NPC slot499不自动等于二者。恢复／缩略图用目标世界只读投影，不重播到达。 | `web/core/map_stage.mjs`、`scenes.mjs`；剧情指南 |
| 传送与触发 | 描述符有0x2B紧凑表与0x42表，字段宽度不同。TLK kind2 +0x2F为目标入口marker，非本TLK记录。无cells描述符不增造触发格。 | `tools/source/map_data.py`；`web/core/chapter.mjs`、`map_connections.mjs` |
| 原落点与移动适配 | 原4A5110可放置到terrain=1入口，允许移出但普通路径不进入。连续脚底不能封死原八邻对角接点；保留原地形、逻辑中心检查和NPC阻挡，不按地图ID补洞。 | `web/core/movement.mjs`；`tests/test_map_collision.mjs`、`test_map_transitions.mjs` |
| 物件与宝箱 | 盘点交互表、更新队列和全部像素通道；CF4 +48为重建序号，F2为钥匙条件，+54起为十个奖励槽。即时完成与重载layer可不同。无TLK可直接走共同物件事务。 | `web/core/map_objects.mjs`、`native_map_chests.mjs`；`tools/export_chapter_story.py` |
| CF1／CF7时序 | CF1物理帧与逻辑序列分开，410850初始化与4137C0单步循环保持原随机次序；隐藏物件继续更新。CF7独立处理默认／保存动作，不能套CF1。 | `web/core/map_objects.mjs`；`tests/test_cf1_map_effect_pixels.py`、`test_cf7_map_pixels.py` |
| 演出调用与索引 | ANM名不决定执行地图；取实际TLK／DAT调用者和opcode10。ANM命令零基、分支目标原一基，TLK记录一基，日志保留偏移。opcode255依原分派，不一概终止。 | `web/core/chapter_animation.mjs`、`anm_runtime.mjs`；来源索引的external_callers |
| 人物动作 | ROLE raw+7E按469F50取首个匹配，缺walk才继承idle；DAT的FF模板不代表已初始化。ANM33 +25低字节为到达朝向，不是速度。 | `tools/map_npc_fields.py`、`web/core/map_npcs.mjs`、`anm_runtime.mjs` |
| DGP帧边界 | 动作可引用全局帧池；CHR显式区间读取DGP +0x16表，不以+0x12声明数裁剪，仍核表容量及物理帧池。存储RLE行可能超出显示矩形，严审完整流，只绘声明矩形。图集合并核身份、原动作、方向／间隔与可见像素。 | `tools/source/dgp.py`、`export_combat_presentation.py`、`web/core/skill_sequence.mjs`；`tests/test_dgp_native_clipping.mjs` |
| 条件与技能 | 条件raw+0B、对象反转、装备／镶嵌持有及活跃slot都有语义；技能source ID须解析到原索引。学会、机制支持、配方解锁与服务可用分别校验。 | `web/core/native_story_conditions.mjs`、`native_story_mutations.mjs`、`skill_registry.mjs` |
| 剧情战身份 | kind5为stage与最多六个20字节文件名，首NUL截断；合法031A1／031B2等basename不得截成三位ID。战斗执行仍查真实CHR、登记和处理器。 | `web/core/native_battle_filenames.mjs`、`scripted_battle.mjs` |
| 原数值与加载派生 | 41D990／41C610上限≤下限时取下限且不抽RNG；速度采样另有规则。技能code需沿真实入口模式在不可变CHR上派生，不能用镜像初值或文件值直接替代。 | `web/core/config_overrides.mjs`、`combat_rules.mjs`、`native_skill_loading.mjs` |
| HP、死亡与复活 | rawHP、显示HP和死亡类别分开；终局等落地及回执，复活候选／排队／接触共用资格。复活只换epoch，不清原Z和浮空时钟。 | `web/core/battle_revival.mjs`、`battle_vertical.mjs`、`recovery.mjs` |
| 药品与被动 | 零HP／MP字段不代表无作用；mode、目标、首个状态解除、重复guard和实际接触共同决定消耗。普通type0记录保持来源资格；朱特005／29、30援攻按明确Bug修复在运行副本中纠正，原字节保留。 | `web/core/items.mjs`、`equipment.mjs`、`item_passives.mjs`、`party_skill_corrections.mjs` |
| 独立载体 | wait0效果沿自己的源时钟继续接触，人物可进入下一行动；尾部效果保留施放时技能，不能迟到切回旧动作或改成wait-all。合并调度与通道推进使用同一绝对到期时间。 | `web/core/combat.mjs`、`battle_view.mjs`、`battle_controller.mjs`；`tests/test_battle_support.mjs` |
| 文件名与媒体 | 原字面路径缺失不猜近名替代；扩展名不等于编码。BIK完整帧／音轨核对，浮点PCM转码要保留明确增益关系。 | `tools/export_audio.py`、`export_story_media.py`；`web/story_media_view.mjs` |
| 菜单字库 | 按实际界面文本收集，包含已接敌人的目标名称；统一构建追加新字符并保留旧字形坐标。规则／战斗回放不能替代实际目标菜单的位图绘制验收。 | `tools/export_menu_text_gdi.py`、`web/core/menu_text.mjs`；`tests/test_menu_text.mjs` |

## 事务与资源边界

- 跨图、剧情战、奖励、队伍和经济操作交还同一个外层draft；完整事件成功才提交，后段失败回滚前段。异步读档或准备不能覆盖期间的新revision。
- 原入队满四人无写入，离队只清对应阵形槽；候补保留原实例、成长、装备与资源，再次入队恢复。旗标与对白不能替代实际队伍检查。
- 地图、演员、动作、音频与战斗资源有明确持有者、租约和取消信号。离开／失败清理，迟到回调先核会话；暂停期间不消费源等待。
- 终章要验证“完整演出→世界提交→标题且禁resume”。原隐藏角色坐标可保留，不为通过探索落点校验另传送；普通事件仍严格核落点。
- 来源像素、规则回放、实际Phaser绘制和正式流程分别验证。空hooks或假Canvas抓不到真实镜头、动作绑定、媒体和外层提交错误。

## 检查与交接

普通任务使用task，阶段收口使用phase及区域参数，版本交付使用release，来源／历史专项使用audit。选择范围、复用条件、界面矩阵与结束条件统一见[测试规范](testing_strategy.md)；具体CLI见[工具说明](../runtime/tools/README.md#测试职责与运行)。

来源检查覆盖新增或受影响输入；解析器变化扩大到其全部受影响来源。旧范围保留有效基线，新增内容独立核对，不能只改固定总数或放宽原字节／像素断言。真实CLI与隔离Python入口需按实际依赖验证，进程内import不能代替子进程启动。

每个阶段交接包含：稳定编号、来源前置／外部写者、实际入口、开始与结束档、操作、预期世界差异、保存重载／重复／失败结果、配置模式、代码／数据／媒体指纹，以及未覆盖范围。卡点写明触发路径、原文件／偏移／函数、已查内容及解除后的验证方式。

新观察使用新目录，旧报告及其输入保留原字节。构建／自动检查先收口，再操作正式页面；有关输入未变且声明范围通过即可结束。下次自然主线抵达旧区域时补对应重访集成，状态只更新计划。
