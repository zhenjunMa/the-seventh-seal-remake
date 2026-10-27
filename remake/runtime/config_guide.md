# 第七封印 · 内容接入与统一配置

更新：2026-10-27；文中web路径以runtime为基准，命令从仓库根目录执行。示例使用python3，Windows可换为指向Python 3的python或py -3。

## 目录

- [先选择修改入口](#先选择修改入口)
- [全量来源与引用索引](#全量来源与引用索引)
- [数值配置](#数值配置)
- [参数分工](#参数分工)
- [装备、药品与晶石](#装备药品与晶石)
- [内容登记的最小职责](#内容登记的最小职责)
- [新增地图和剧情](#新增地图和剧情)
- [新增怪物](#新增怪物)
- [新增队友和技能](#新增队友和技能)
- [开发样本与支持边界](#开发样本与支持边界)
- [构建与调参示例](#构建与调参示例)

## 先选择修改入口

Phaser迁移沿用现有内容登记、数值配置和媒体路径。新增同类地图／角色继续走下述流程，不为每张地图创建专用Phaser Scene；通用显示行为放`web/phaser`中对应组件。phaser-preview使用独立示意图，不写入正式内容登记或素材目录。

内容接入选择：`web/data/runtime_content.json`。角色、原技能索引、地图、舞台和ANM登记放在这里。

地图／NPC／对白／任务的组织与编写见[story_guide.md](story_guide.md)；`story.events`／`story.quests`显式登记独立事件和任务文件，`web/content`保存编辑内容，`web/data/story`保存生成的按地图运行包。

数值调整：`web/data/config/index.json`及`skills.json`、`battle.json`、`rewards.json`、`items.json`。所有人物共用这些文件。

玩家当前HP／MP、等级／成长、背包／装备、旗标、队列、技巧／晶石与学习／熟练度是世界进度，通过游戏和存档维护。

基础导出清单集中在`web/data/source`，正式素材集中在`web/assets`，通用解析器位于`tools/source`；prototype仅做实验验证，不作为新内容的生产入口。其余data JSON、图集和`runtime_content.mjs`是来源或生成结果。不要直接用它们调数值；新增机制先实现对应规则，登记和enabled不会补出处理器。

旧`web/data/skills.json`仅保留为历史验证基线，当前调参统一使用`web/data/config/skills.json`；导出、缓存及配置重置语义见[README.md](tools/README.md)。

## 全量来源与引用索引

`web/data/library/index.json`统一索引全部来源：6名队友、100个CHR角色、1948条CHR技能／待机／反应记录、`System.MAG`的41条全局法术及416条道具。`roles.json`保存角色初值、装备、成长来源和技能引用，`skills.json`保留CHR全部固定记录／动作，`magic.json`保留MAG原记录；道具仍使用既有`data/items.json`，不复制另一份道具目录。

现有`party_*`、已接入技能ID、全部道具编号及既有parameters继续保留，只向统一配置补齐缺项。角色／技能目录中的源数值不作为另一套调参入口。

角色用原CHR文件名编号（001～006为队友）；CHR技能用“角色编号_原零基技能索引”，例如001_22；旧yantu等ID通过索引的configuration_id／skill_aliases对应同一来源，不能重复登记。道具用原item_id。

全局法术用system_magic_原零基记录索引，例如system_magic_0；`owner.source_kind`为system-magic、magic_index为原索引。MAG原ID28有两条不同记录（原索引27与28），所以原ID只作source_id核对，不作唯一主键。

索引entries提供来源与配置位置、角色归属、原索引和runtime_registered；indexes提供名称、角色、类别及来源类型查询。名称可能重复，by_name返回编号列表，resolveContentReference遇到重名会拒绝静默选择。

角色、技能、道具和名称的只读查询：

```console
node remake/runtime/tools/build_content_library.mjs --query roles 004
node remake/runtime/tools/build_content_library.mjs --query skills 001_22
node remake/runtime/tools/build_content_library.mjs --query skills yantu
node remake/runtime/tools/build_content_library.mjs --query items 125
node remake/runtime/tools/build_content_library.mjs --query search 海皇印 items
```

省略 `--query` 后的参数可看数量与六队友索引。

内容工具可复用`web/core/content_library.mjs`的resolveContentReference／searchContentLibrary，按index中的definition及configuration定位来源和参数。该引用可用于地图／剧情编写与接入校验；实际入队、获取、学习及行为执行仍须按既有runtime_content和StoryFlow流程接通。

## 数值配置

`index.json`选择original或debug，并引用四个参数文件。skills／items使用v3，battle／rewards使用v2。每条保留name、必要的owner和parameters；source_hashes按源文件集中登记。name、owner及source_hashes只读，原始字段、完整目录和默认值保留在生成来源数据中。

只在 `parameters` 填写修改项；`{}` 沿用全部来源默认值，不表示禁用或空技能。嵌套对象按字段合并，数组整体替换，未知字段拒绝。删除修改字段即恢复该项默认值，不用复制其余参数。

例如，将燕突耗蓝调整为 5 时，其 `parameters` 写为：

```json
{"mp_cost": 5}
```

装备速度的 `parameters` 示例：

```json
{
  "attributes": {
    "speed_flat": {"minimum": 40, "maximum_exclusive": 40}
  }
}
```

默认值和生效值只读查询：

```console
node remake/runtime/tools/export_runtime_config.mjs --reference skills yantu
node remake/runtime/tools/export_runtime_config.mjs --reference items 4
```

省略最后编号可查看整个类别；分类限 `skills`、`battle`、`rewards`、`items`。查询不导出或写文件，返回 `original` 及合并后的 `parameters`。

original要求合并后的参数与原基线一致，有差异会拒绝；debug应用修改并保留完整生效快照／差异。普通导出迁移旧完整格式、删除等于默认值的冗余项并保留调参，`--force`不重置；只有显式配置`--reset`清空全部修改项并恢复original模式。

批量登记新内容后，统一导出自动补齐所有已接入技能、怪物属性／AI、奖励和道具编号；每张地图及NPC继续走runtime_content与地图来源表，不复制到数值配置。运行要求当前登记编号齐全；源文件指纹变化、已移除编号或身份错配会阻断，核实来源后处理，不通过重置掩盖漂移。

CHR技能owner={role_id,skill_index,side}按原角色ID＋技能索引绑定，禁止按名字或队伍位置覆盖数值；未分类的源角色side=source。MAG技能按source_kind＋magic_index绑定；道具owner按原item_id绑定。名称可重复，原ID与绑定保持稳定。

原side=source条目接入敌人时，普通导出核实原角色／索引、名称和文件SHA后迁移为enemy；共同数值修改继续保留，mp_delta_raw依已证明的耗蓝语义迁移。身份错配、来源变化或先前强开enabled仍拒绝，不能为新增怪物清空整个技能配置。

游戏页面启动时读取并编译一次配置，操作界面、普通／剧情战斗及技巧测试复用本次启动结果，并各自取得独立数据副本。掉落、资源、成长、学习与装备状态仍按最新世界数据计算，不触发配置重编译。修改parameters或original／debug模式后刷新游戏页面生效；返回标题、开始新游戏及读取存档不重新加载配置。先保存再刷新，可读档继续调试，无需重启本地服务。改变来源目录或登记后仍需构建并刷新。

配置不重写已保存的资源／实例或原CHR／ITM，不关闭奖励去重，也不接受可执行表达式。

## 参数分工

`skills.json`：耗蓝mp_cost，physical_multiplier_percent，六槽element_power，defense_bonus、term4_bonus、hp_term_bonus、hp_max_term_bonus与preparation_delay_raw等已接入字段。

未接入CHR记录保留原signed数值槽和mp_delta_raw，不将正MP字段猜成耗蓝；未接入MAG记录目前只有enabled:false。来源默认enabled=false可在稀疏parameters中省略；不能通过改为true启用未恢复行为，来源记录也不进入运行技能表或菜单。`--reference` skills 原编号会标明runtime_registered并展开默认值。原始倒置／负值范围仅作为来源保留，不表示运行处理器支持。

minimum／maximum_exclusive表示原随机下限／不含上限。41D990／41C610参数取值在上限小于或等于下限时固定返回下限、不抽随机；例如003／33原物理倍率(200,0)合法，不应改源数值来满足常规区间规则。正跨度仍校验32位溢出及两端上限；速度采样沿自身的正值有序区间规则，不共用这项例外。伤害继续由原公式、属性、装备和RNG计算，不配置固定damage。

preparation_delay_raw是准备量，不是毫秒；0使用调度默认准备量，原值800。动作、接触、目标、反击与状态规则继续由原记录及处理器决定。

场外恢复、复活等已接入作用仍使用同一`skills.json`。暖心之炎001／41原MP6、恢复300HP；001／43复活之炎的原正MP字段不能解释为耗40或恢复40，沿已恢复复活分支处理。

敌方非零耗蓝及不足后备规则尚未恢复，配置拒绝非零敌方耗蓝。

`battle.json`：enemy_编号控制新生成敌人的HP／MP、attack／defense／speed及六槽抗性；ai_编号控制源技能索引权重和combination_chance_percent。权重不自动归一化，保持原区间和随机后备。

调度按20ms单tick，average_speed_factor原200；speed读取原充能属性，不把装备有效速度混入raw充槽计算。人物当前资源和等级不在此覆盖。

`rewards.json`：experience、money与有顺序的drop_item_ids。重复候选增加抽签次数；候选须有已支持奖励来源，掉落和非零金钱合计最多六个原奖励槽。

`items.json`：全部原编号的统一目录、基础drop_rate和已实现装备／药品／晶石参数。目录登记不等于作用已实现。

drop_rate=-1不抽签、0走原特殊必掉落分支、1～100走基础概率并叠加已恢复连击奖励。

`parameters.enabled`只开放已实现行为；`data/items.json`中definition的behavior及来源字段说明未恢复范围。

默认装备准入由已登记player的原47AE20初装，以及已登记入口可达的TLK `mutation5/index0`真实授予推导；只接纳确定初始化、已恢复装备槽／链接属性且特殊效果块、遭遇修饰、动画技能与效果token均为零的纯数值装备。NPC只走已登记槽，另遍历已登记trigger／物件／进入／加载／休息／出口及ANM14调用的分支；导出整张TLK不会开放该图未登记NPC的赠礼。来源证明保存在`data/items.json`的`catalog.equipment_admission`；登记只开放菜单能力，不发放物品或队员。区域外开发装备、配方解锁、任务材料和内部掉落记录不因此开放。

items构建先生成opening-seed／chapter-story／enemy-rewards，再核对原`GAME.exe`、`Object.ITM`、已登记角色CHR与TLK原字节及生成来源指纹。新增默认准入不改用户数值parameters；稀疏配置显式enabled:false继续拒绝装配。旧v2全量配置只有只读来源和旧基线精确匹配才迁移，保留数值编辑；旧默认false随能力恢复转为true，显式禁用请使用现行稀疏enabled:false。

Python导出器通过`__file__`解析自身tools及原初始化器目录，兼容embedded／isolated Python；无需设置PYTHONPATH。items的共享工具模块、来源证明和生成输入均在构建依赖中声明。回归使用仅含声明输入的临时工程，由`build.execute`真实启动子进程并验证缓存，再以python -I独立运行导出器，覆盖测试进程内import无法检查的启动边界。

## 装备、药品与晶石

装备allowed_role_mask按原角色编号位掩码判断，0不限；slot_id为来源，不能将头饰／耳饰拆为虚构部位。

attributes使用已参与getter的26个字段及原范围；其余原字段留在catalog，未知名称保留native标签。实例按其原范围位置映射参数，不重新抽随机或改source_raw_hex。

换装保留raw HP／MP；派生属性包含装备和晶石链接，原充槽仍读raw速度。

药品use_in_field／use_in_battle控制场合，effect控制已恢复HP／MP固定／百分比恢复。普通药品不复活，不绕过倒下／免疫目标限制；战斗消耗一次行动。

已登记剧情授予的单体同阵营mode1解除状态药，由原ITM及508BB0分派推导到`catalog.item_capability_admission`。火蜥之血272解除首个ID5冻结状态，不清其它状态、不抽随机；有效目标即使无匹配状态仍演出原光效，但不消耗道具。原47D960对其数值全零，因此场外不可用，也不消耗；仅凭enabled不能开放场外范围。森林状态表仍由enemies步骤唯一生成，解除处理器不登记区域外怪物或状态技能。

item-presentation步骤读取`data/items.json`已恢复定义决定实际药品动作及effect token；缓存依赖另观测原ITM单体同阵营动画17所引用的DGP源集合，首次新增token也能被哈希检查。这项观测不扩大道具准入或导出范围。

纯数值晶石通过通用镶嵌处理器支持，属性也在`items.json`。人物保存六槽，当前武器只决定可操作孔数；替换先返还，换武器不丢隐藏槽。关闭enabled后已有晶石仍保留属性并可卸除。

特殊晶石被动、合成、商店、未知初始化或特殊药品需按真实内容恢复，不能仅修改enabled。

已登记原奖励可按ITM+0x2A8的C6原块恢复mode6状态免疫，来源定义的equipment_passive保留原字节，数值仍在同一items配置。运行按原装备组／槽顺序初始化100状态槽，保留原成功率、重复guard与CRT消耗；关闭enabled不删除已保存装备或晶石及其卸除能力。127回转之钥是原35号免疫，原mode6不执行周期恢复，不能从名称推断自动复活；170紫龙晶按原入战rand()%100<=60装入6号免疫。其他特殊块继续阻断，不能泛启用全部mode或晶石。

已有章节数值装备的合同与被动准入分开：例如51烈焰冠继续保留原数值链接、菜单装卸和旧存档，其未登记的id1／mode6块不注入状态槽、不增加入战RNG，也不表示被动已恢复。未开放的其他特殊装备不能通过enabled绕过来源／被动准入；已有equipment_passive描述与原块不符仍拒绝。旧完整配置分别核对当前来源的pre-socket格式及能力恢复前的精确基线，保留数值修改与显式禁用，不混用两个只读目录。

## 内容登记的最小职责

`runtime_content.json`编辑格式v2只保留接入选择。角色source／native_slot、默认技能ID、ANM来源、地图路径／原旗标和休息选项由同一来源解析器推导。

- **roles**：阵营side；玩家battle_skills／field_skills的原index与处理器；primary_skill选择主要表现。技能可省略id，生成“角色编号_原索引”；已有ID保持兼容。

- **battle_rosters**：历史资源样本列明确身份，正式阵容可使用`$players`／`$enemies`。

- **stages**：新增同格式舞台可只登记ID与{}，默认读取Fight_Bk/<ID>.scn，生成`data/stages/`<ID>.json和`assets/stages/`<ID>/。可指定path、schema、asset_prefix；指定path的旧登记默认由既有导出器维护，需要通用导出时显式加export:"source"；export:"existing"保留专用生产。

- 通用舞台支持SCN v2／mode4、固定记录布局、默认640×480零镜头、天空单循环动画及静态地面／景物；从原记录读取素材名和锚点，不为新舞台硬编码文件名单。新格式、非天空动画、动态镜头仍须补规则。

- **programs**：原ANM程序ID。导出从源opcode10及实际TLK／DAT调用者推导地图依赖与顺序；允许同一演出切换多图，不能按文件名猜。没有opcode10的演出必须继承唯一实际调用地图；缺少来源或未恢复的指令／模式明确拒绝。

- **maps**：按原地图ID登记triggers、objects、rests、routes。空地图可为{}；objects绑定原index和已实现handler，rests只选descriptor_id。

- entry:true选择原DAT +0x13A的到达剧情，不能手填替代记录；只在普通出口和大地图真正进入时执行。位置、剧情旗标和奖励成功后一起提交，失败保留原场景和进度；载入存档、启动和预览不重播。

- setup:true选择DAT +0x8A的加载布置。`core/map_stage.mjs`在每次准备地图（含恢复与缩略图）时，通过同一StoryFlow只读投影NPC显隐、坐标和姿态；只允许已核对的纯布局指令，不写剧情旗标、发奖或播放到达对白。NPC槽499不等于setup或entry。

- npcs:[原零基槽]明确开放可交谈NPC，进入构建阻断检查；[]保留人物显示但不开放交谈。省略时保持旧隐式NPC行为，预检查仅提示其未知分支；新地图建议显式登记npcs。

- routes可只登记{descriptor_id:原出口描述编号}，record_id由DAT推导，运行出口直接读取同一chapter_story。存在前置演出的出口继续提供已核实的requires_flag、animation、denial_record_id、speaker_role_id。不再为每张新地图手工编写route_events表。

- 大地图入口使用原entry_marker和sort_code从chapter_story的DAT标记推导坐标，旧地图仍兼容route_entry；缺少标记或排序处理器时拒绝，不填兜底坐标。

- **`maps.export`**：默认{assets:"chapter",story:true}。assets="existing"保留已有开场／路线导出器的素材产物；story=false表示尚未接入该图TLK。新地图一般省略export。该字段只控制生产，不开放剧情。

## 新增地图和剧情

先按[区域工作方法](../assessment/region_remake_workflow.md)全量盘点区域，再选择承接连续主线的剧情阶段与完整事件链；本轮范围和暂缓的后期依赖记录在唯一开发计划。此划分用于排期与验收，runtime_content的原入口、旗标和完整依赖契约不变。

1. 从原DAT／TLK核对本轮阶段的真实入口、出口、NPC、物件、进入事件、跨区域剧情依赖和遇敌／舞台，确认格式及机制已支持。

2. 在maps登记原ID及需要开放的交互、NPC槽和进入剧情；新动画在programs登记。普通state0物理出口从DAT推导到已登记地图，大地图型出口登记routes。遇敌引用的新舞台在stages登记。

3. 先执行chapter-story构建准备新地图源记录，再运行`--preflight`查看能力缺口。该命令只读已有源表，不能替代尚未执行的提取，也不验证原媒体像素／浏览器表现。

4. 执行content构建。story-check在来源准备后、玩家表现和图集生产前遍历显式开放入口的可达分支；缺少条件、变更、选项、ANM或处理器时阻断，并显示地图、入口和记录号。之后统一生成遭遇、舞台、音乐、菜单／对白字体及最终登记。

5. 验收本轮阶段的进入／退出、对白／分支、领取／使用／再次进入、失败回滚、存读档及前后区域交接，保留结束存档。开发交接样本不替代自然主线贯通。新增中文字须随相应字体导出；源表导出不表示所有分支已开放。

已登记入口的后期可达分支仍须通过上述检查；不能以当前存档条件不成立为由省略能力校验。若无法按原入口独立准入，先列为依赖阻断，恢复机制或暂缓开放该入口，不添加运行阶段开关来隐藏未知分支。

content最终编译同时生成story运行包。只修改独立事件／任务内容或story登记可运行`build_runtime.py` `--target` story-pack `--run`；该步骤复用已编译地图身份和既有来源台账，不提取原素材。地图／角色／ANM登记变化仍需完整content流程。

需要扩展源格式解析时复用或补充`tools/source`；正式内容导出放tools，运行机制按[architecture.md](architecture.md)分层接入。实验页面和定向验证放prototype并复用正式实现；`web/data/source`的历史清单不作为新剧情的手工编辑表。

## 新增怪物

1. 准备原CHR／DGP，在roles登记side=enemy。已有机制的源技能由实际学习表识别，不在脚本中增加怪物ID或技能索引分支。

2. enemies导出属性、完整AI／反应记录、已学动作、状态块与图层；默认行动取首个源已学命令。敌我复用素材解码与独立像素审计。

3. enemy-rewards读取同一集合的经验／奖励槽，encounters读取已登记地图DAT频率及全局STG池。池中怪物和舞台必须已登记，不能用配置编造原遭遇池。

4. content构建将新数值补入统一配置，保留旧参数。验证自然遇敌、技能／反应／死亡、胜利奖励和再次保存／返回；特殊掉落或新状态先补处理器。

## 新增队友和技能

1. 核对原角色CHR、原槽、初始属性／装备、行走图、成长行和技能动作。角色登记不会安排正式入队剧情；剧情需按原事件连接。

2. 在roles登记player、battle_skills／field_skills及primary_skill。同类直接攻击使用direct，已恢复的独立效果载体使用effect-carrier；其他行为先实现。

3. 执行content构建：属性、技能／反应、成长、道具动作、生命周期、地图行走、菜单、音频、字体和图集读取同一登记。各角色按自己的源动作／时序导出。

4. 构建自动补齐`config/skills.json`；只在parameters调数值，不另建队友专用配置。

5. 验证入队／重复入队、四槽队列、菜单、等级／学习资格、战斗、用药、倒下／起身、成长与存读档。原剧情离队保存在reserve_party，原入队优先恢复同一实例；满四人不写入，离队只清对应队列槽。自由换人界面尚未接入，不能由候补存储推断其已实现。

技能接入、已学状态、人物等级是独立条件。燕落001／26保留原未学字节及12级要求，仅升级不会自动学会。

party[].skill_progress v2可保存learned_indices和records[{index,level,experience}]，旧v1已学索引仍可读取。熟练度由原记录派生，不改CHR或`skills.json`原基线，不增加独立成长参数表。

编成容量与晶石孔数分别沿原定义，组合记录保存原索引／球数／字符／图标；组合攻击执行未恢复。

## 开发样本与支持边界

开发检查→三人扩展样本共用正式入队／成长／战斗入口，显式测试授予技能，不自动保存，也不向主线编造入队或获取事件。

014的隔离导出只验证内容生产能力；火之谷地图与演出的实际开放范围见当前计划。

effect-carrier按目标已加载的原技能索引选择对应记录，fresh分配与已有目标槽分别核对。native-support用于已恢复的直接恢复及清状态分支，与direct／effect-carrier使用同一技能配置。新状态、动作指令、特殊掉落、局部遇敌分区和舞台格式仍须先补来源规则，不能用处理器名字概括尚未支持的所有模式。

物品目录、素材已提取、登记、可执行机制和正式获取／入队分别核对，不互相替代。

原版浮空受击保留command3的模式2／3、原wait字节与20ms垂直时钟；非wait上升不阻塞人物，落地wait等原Z归零。核心角色持有唯一高度状态，人物序列与独立生命周期都由同一控制器推进，渲染只读取原Z。51CC00按原ID5→8→4→6→待机链、空中受击修正及落地死亡分派续接，不把+62=5替换为普通受击。004／18水晶杖和032对应原受击链可正常预检。涉及尚未接入镜头执行器的command3模式仍在确认前拒绝，不扣MP或抽RNG。原字节、原指令差分与完整动作链测试见`tests/test_battle_vertical.mjs`、`tests/test_native_after_source.mjs`及`tests/test_vertical_playback.mjs`；静态来源见`evidence/fire_valley_20261025/vertical_reaction_admission.json`和`carrier_lifecycle_native.json`。

原command4的wait=0命中特效使用独立carrier时钟，保留分配顺序、原技能源索引和目标；人物主动作完成后可继续下一次行动，已放出的载体仍按原逻辑帧结算，不能通过隐式wait-all串行化。不同载体和新行动按同一时间顺序提交命中及RNG。援攻cvt_p001／002按shadow→main→intrinsic导出和绘制；普通主层覆盖，intrinsic加色，阴影使用既有8位alpha适配，不能声称等同原16位通道逐位减半。五条原type3奖励可由统一登记接入；005／30原type0仅保留学习进度及原菜单资格，444BA0只写学会字节，不会改变类型。

## 构建与调参示例

新增地图先准备源表：

```console
python3 -B remake/runtime/tools/build_runtime.py --target chapter-story --run
```

随后只读核对能力：

```console
python3 -B remake/runtime/tools/build_runtime.py --preflight
```

补齐机制后构建内容：

```console
python3 -B remake/runtime/tools/build_runtime.py --target content --run
```

这些是已有基础内容与匹配来源台账下的接入步骤；首次构建前置见[README.md](tools/README.md)和[local_materials.md](../local_materials.md)。

例如把`index.mode`改为debug，修改`skills.entries.yantu.parameters.mp_cost`，下一场核对资格、真实扣费及保存；恢复原值后将mode改回original。

参数导出、登记检查、完整检查及全部选项统一见[README.md](tools/README.md)。所有JSON严格校验，未知字段、错误范围、来源漂移或未实现行为会报错。
