# 第七封印 · 地图、NPC、对白与任务

路径以`runtime`为基准，命令从仓库根目录执行。区域盘点和阶段选择见[区域方法](../assessment/region_remake_workflow.md)，当前范围与待办见[开发计划](../assessment/validation_design.md)。

## 编辑入口与运行链

| 内容 | 编辑／生成位置 |
| --- | --- |
| 地图、NPC槽、物件、进入／加载、出口、ANM选择 | 编辑`web/data/runtime_content.json` |
| 自行编写的独立事件、任务定义 | 编辑`web/content/events/`和`web/content/quests/`，显式加入`story.events`／`story.quests` |
| 原DAT／TLK／ANM来源台账 | `chapter_story.json`、`opening_program.json`、`data/events/`及地图资源表，由导出器生成，不手改原字节或文案 |
| 浏览器剧情运行包 | `web/data/story/`，由`export_story_packages.mjs`生成，不直接编辑 |

原TLK、自编事件与旧核对事件统一编译为StoryFlow。StoryFlowRunner执行流程，ChapterRunner提供世界事务和游戏行为；新增区域沿同一执行器，不复制剧情VM。

来源、编辑和生成层各有职责；修改参数用[统一配置](config_guide.md)，修改原剧情必须先核对来源。按原编号查角色／道具／技能，重名不静默选择，来源目录中的未接入技能不可直接执行。

## 地图与NPC接入

1. 按区域方法全量盘点，明确本轮完整事件链、前后交接、外部旗标写者和暂缓项。
2. 在`maps`登记原ID、NPC零基槽、triggers／objects／rests／routes；新演出在`programs`登记。同图角色以“地图ID＋原slot”识别，不按名字或共用图集合并。
3. 准备chapter-story源表，再运行preflight。能力检查沿每个已登记入口的全部可达分支展开，当前旗标不成立也不能跳过未知能力。
4. 补共同处理器和实际资源依赖，执行content构建；最终内容编译同时生成剧情包，无需新建地图专用Scene或手写route_events。
5. 从声明前置完成进入、交互、奖励实际使用、离开／返回和存读档；失败／取消与跨区交接纳入同一流程。开发交接与自然贯通分别记录。

登记字段及最小示例见[配置指南](config_guide.md#地图与演出登记)。无TLK地图保留真实DAT、空records和缺失来源声明，不生成虚构Flow；DAT物件可直接使用共同事务。

### 加载、到达与保存

| 入口 | 行为 |
| --- | --- |
| `setup:true` | 选择DAT +0x8A，prepare时通过共同StoryFlow只读投影NPC；不移动保存中的玩家、不写旗标、不发奖。 |
| `entry:true` | 选择DAT +0x13A，普通出口或大地图真实进入时执行；地点和剧情共用未提交草稿，失败一起回滚。 |
| NPC slot499 | 保留来源结构根，本身不证明属于加载或到达入口。 |
| 读档／缩略图 | 使用目标世界恢复布局，不读旧world替代、不重播到达；已保存的玩家坐标优先。 |

当前地图NPC通过可选`map_npc_state`保存位置、方向、帧和显隐，ANM变化随剧情draft提交。恢复顺序为来源默认→加载布置→存档人物投影；普通离图清除旧图快照，重新进入加载来源。旧档无字段时保持原默认行为。

ANM按原头部uint32数量执行全部74字节命令，不设256条截断。opcode12通过`objectCommand`写同一剧情draft，并由`object`显示接口启动原CF7时钟；opcode31与移动、人物动作共用屏障，等待物件正播state2→3或反播state5→0。当前仅允许已恢复且无奖励、生成或额外TLK联动的CF7来源。物件显示模型不直接修改正式世界状态；失败或取消仍回滚整条剧情。

TLK条件8比较当前控制角色的原槽号与记录+0x0B完整DWORD；条件10检查角色是否在当前队伍。前者读取`leader_id`，不能用队伍包含关系替代。

物理state0出口由原DAT推导；TLK kind2使用目标marker和原排序，不能误用对白跳转号。原CF1物件可按tlk-object登记+F6入口，主动交互沿同一StoryFlow事务执行，保持可重复交互；其kind2传送继承当前原排序，目标准备失败回滚物品和旗标。原障碍入口允许移出但不改terrain；无cells描述符不补自选触发格。物件CF1／CF4／CF7和动作绑定的共同规则见[来源规则速查](../assessment/region_remake_workflow.md#来源规则速查)。

## 来源查询

来源索引独立于运行登记，保留各时期、原记录、SHA、旗标读写和跨区调用；索引完成不表示开放或可玩。

| 区域 | 索引与导出目标 |
| --- | --- |
| 火之谷 | `data/library/fire_valley.json`；`fire-valley-index` |
| 外层白木森林 | `data/library/white_forest.json`；`white-forest-index`，不含里白木森林 |
| 翠碧湖 | `data/library/jade_lake.json`；`jade-lake-index`，不含同前缀研究所遗迹 |
| 炎城 | `data/library/ember_city.json`；`ember-city-index`，保留M01020A等原ID |
| 里白木森林／幻影之森／封印之森 | `data/library/inner_white_forest.json`；`inner-white-forest-index`，完整保留17图，运行准入另看`runtime_content.json` |
| 飘城 | `data/library/floating_city.json`；`floating-city-index`，含ANM实际加载的独立地图，未找到入口的候选另列 |

各`tools/export_<区域>_index.py`共用`--query`、`--map`、`--flag`和`--check`查询方式，示例见[工具说明](tools/README.md#来源查询)。`external_callers`记录原调用者，`potential_call_roots`表示静态可达，二者都不保证某个存档当前能进入。

## 城镇服务与金钱

TLK kind8经同一个StoryFlow打开服务，关闭后继续原next记录。`controllers/native_services`连接原Boss菜单视图与`core/native_economy`；商品、资金和配方规则不写进视图。买卖／制作修改外层draft，整条对白／演出成功才提交。

| 来源 | 规则 |
| --- | --- |
| TLK +0x37起32个ushort | 原商品ID；+0x2C区分买卖、锻造及合成，不从名称猜服务。 |
| ITM +0x14C | 售价；回收价有符号右移一位，拥有上限99计入已拥有角色装备／镶嵌。 |
| recipe_unlock_indices | 原零基解锁索引，产物ID为索引加1；ITM +0x392为原料数量，+0x393起为原料ID。 |
| 制作 | 扣原料、不额外收费；武器按原掩码选当前或最低编号的已拥有角色并直接替换，旧武器不返还。产物走共同原实例初始化，不零填或开放未知随机属性。 |
| 宿屋 | condition2检查有符号金钱门槛，mutation3按原32位加法及负数归零；恢复、扣款与完整住宿演出共用事务。 |

锻造按武器／水晶分类，合成按材料／全部配方分类，全部列表只读。原记录只检查资金而未扣款时，不因对白声称收费补造扣款。道具取得、装备、使用和材料能力仍需按实际登记入口完整准入；部分制作服务可用不代表工会晋级或赌场模式全部完成。

## 新增独立NPC对白

创建`seventh-seal-story-event`版本1文件，并把相对web的路径加入`runtime_content.story.events`。以下仅为格式示例，不自动接入游戏：

```json
{
  "schema": "seventh-seal-story-event",
  "version": 1,
  "id": "fire-valley-villager-example",
  "map_id": "M17020",
  "npc_slot": 10,
  "program": [
    {"op": "say", "id": "greeting", "speaker": "火妖精", "text": "一路小心。", "style_raw": 2},
    {"op": "end"}
  ]
}
```

- `npc_slot`绑定已导出的原NPC；同一NPC只登记一个事件，在内部处理首次、重复和阶段分支。独立人物也可用既有`npc`格式指定id、名称、坐标、朝向及真实媒体。
- 每句say使用稳定且唯一的id。跳转用label及字符串target／if_true／if_false，由构建解析地址，不手算数组下标。
- say可选style_raw 0～3、portrait_id和portrait_left；0画像表示无画像，思考对白随绑定NPC定位。
- 编写入口支持say、旗标、跳转、等待和物件状态等已实现指令。新指令先补共同处理器和导入映射；自编来源标记authored，不伪造原作来源。
- 可用`conditions:[{"index":原旗标索引,"value":原完整旗标值}]`限定独立NPC资格；原NPC显隐和移动继续读原记录。

事件成功后原子提交，失败不消耗任务旗标。新增异步行为传递playback／signal，等待使用场景时钟，返回后先核信号再安装资源或修改草稿。

## 新增任务

文件使用`seventh-seal-quests`版本1和quests数组，登记到`story.quests`；已有示例为`web/content/quests/fire-valley.json`。

| 字段 | 约定 |
| --- | --- |
| 任务 | 稳定id、name、maps及有序stages |
| 阶段 | id、status、text、when；选择第一个符合条件的阶段，通常先完成／失败，再进行中，最后默认 |
| status | hidden、available、active、completed、failed |
| when | all、any、not、flag:{index,bit,value}、party_member；`{"all":[]}`可作默认，不执行脚本表达式 |

任务只观察既有世界状态，不自动发奖、写旗标或重复保存进度；奖励仍由剧情事务及原事件状态去重。查询用`storyRepository.journal(world)`或`questJournal`，控制器更新`state.questProgress`供界面使用。独立新持久状态须另做明确的存档设计。

## 运行包与构建

`data/story/index.json`绑定当前登记及各包指纹；shared保存共用定义／任务，maps保存版本2的flows、NPC入口、演出资源和文本表。文本ID由地图／原记录或事件／句子稳定ID产生；来源字节一致性、能力和跳转在编译时校验。

浏览器启动只读索引及共享包，序章和地图按需加载；四图缓存保护当前和准备中的地图，多图共享ANM有租约。加载成功安装前核完整包，失败可重试，不写世界进度。旧`events.mjs`仅作来源核对。

| 修改范围 | 构建目标 |
| --- | --- |
| 新地图、角色、原ANM登记 | chapter-story准备来源→preflight→content完整构建 |
| 仅独立事件／任务或story登记 | story-pack，复用现有台账和已编译身份，不需要原安装 |
| 仅核对剧情包过期 | `node remake/runtime/tools/export_story_packages.mjs --check`；verify_phaser已包含 |
| 新增字体字形 | 相应字体／UI构建；独立故事包不会补原字体媒体 |

命令与前置统一见[工具说明](tools/README.md)。

## 既有火之谷跨区合同

这些原来源关系仍供后续自然集成使用；当前开放状态归计划。位写作“索引:位”，位从1开始；r为一基TLK记录，c为零基ANM命令。

| 链 | 原条件、操作顺序与交接 |
| --- | --- |
| 新游戏与离谷 | resurrect加载M17020；M17029:r24写51:1邀请凯，M17026:r8写48:1领装备。M17010:r48核48:1后走r41～43大地图链。 |
| 首次返谷与朱特 | M01050:r24写5:3，r82调完整44命令m01050-2，先在炎城交接，再到M17010调用r5链写10:1。M17010描述符31在16:1未置时调m17010-2，005入队至M17014:r16写16:1；完成后改走m17014-1。 |
| 佛兰珂房间回谷 | M03039 NPC11根r7需428:3（原写者M03044:r49）；426:2未置且同意后到r13，置426:2并调用m17010-3。c1加入001、c2加入005、c3切控制、c4离队004，c5才加载M17010；写10:2后最终到M17032。不提前换图或调整队伍顺序。 |
| 祭坛选择与返程 | M17032描述符2按10:2／12:1选择M17030／M17030-1／终章链；三个祭坛地图旗标为11／471／469，身份独立。描述符1返程在10:2已置时还核471:1，否则原对白拒绝。 |
| 圣山后回谷 | M73014:r33写12:1，调用来自m73013-1:c96；同演出c102到M55010，c105／106离队004／006。M17010加载r69布置；真实到达r90在10:5未置时调m17010-6并加入002、写10:5。恢复不重播。 |
| 提前回归 | M55010先核465:1（M72064:r24）及12:1；首次给334并写477:1，后续需10:5再写477:2。M03030描述符3经r13～15调用m03030-1，c8调用r7链写23:1，c14才尝试加入004。满队可使004仍留候补，23:1不保证其活跃。 |
| 终章分支与结束 | m17030-1的c7／c35都读23:1；未置先加入005／004、再离队003，满队不倒序重试。M17030-2:r31为stage12／032战；25影片、1999:1和最后等待完成后，整条事件提交再切标题、禁resume，不自动存档或额外拼片尾。 |

入队／离队保留实例和原阵形空槽。源mutation5非零index消费库存后再按原角色／部位查装备／晶石；不重抽随机或重置raw资源。M03039的恢复HP／MP只处理已拥有active＋reserve，不生成缺席模板。无cells的M17020回谷描述符不伪造触发格。

详细原字节回查`data/library/fire_valley.json`，开发交接准备见`evidence/fire_valley_20261025/phase_handoffs.json`和`phase_fixture_manifest.json`，现行辅助与回归在`tests/helpers/fire_valley_world.mjs`及`tests/test_fire_valley_phase_fixtures.mjs`。这些开发档不属于原存档，也不证明区域外流程已重放；材料缺失时按[本地资料](../local_materials.md)处理。
