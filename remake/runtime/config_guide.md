# 第七封印 · 配置与内容登记

路径以`runtime`为基准，命令从仓库根执行。地图／NPC／任务编写见[剧情指南](story_guide.md)，构建CLI见[工具说明](tools/README.md)，当前能力范围见[开发计划](../assessment/validation_design.md)。

## 选择修改位置

| 要修改的内容 | 入口 |
| --- | --- |
| 开放角色、技能、地图、交互、舞台和ANM | `web/data/runtime_content.json` |
| 技能、敌人、奖励、装备、药品、晶石数值 | `web/data/config/index.json`及skills／battle／rewards／items |
| 独立对白或任务定义 | `web/content/`，显式加入runtime_content.story |
| 玩家等级、资源、库存、旗标和学习进度 | 正式游戏及存档，不通过数值配置重写 |
| 原来源、图集和运行包 | 通过导出器生成，不手改`party_*`等来源表、`data/story`或`runtime_content.mjs` |

`web/data/skills.json`是历史核对基线，当前调参使用`data/config/skills.json`。Phaser显示层沿用同一登记与规则；同类内容不新增专用Scene或角色数值分支。

## 查找原编号

`data/library/index.json`关联全量角色、CHR记录、MAG及道具来源和唯一配置，保留名称、归属及runtime_registered。全量来源远大于实际开放范围，重名查询必须选具体编号。

| 对象 | 稳定身份 |
| --- | --- |
| 角色 | 原CHR编号；001～006为队友 |
| CHR技能 | 原角色编号＋零基技能索引，如001_22；旧yantu等ID由configuration_id／skill_aliases指向同一项，不重复登记 |
| MAG记录 | system_magic_零基记录索引；原ID可能重复，只用于来源核对 |
| 道具 | 原item_id；同名道具不合并 |

```console
node remake/runtime/tools/build_content_library.mjs --query roles 004
node remake/runtime/tools/build_content_library.mjs --query skills yantu
node remake/runtime/tools/build_content_library.mjs --query items 125
node remake/runtime/tools/build_content_library.mjs --query search 海皇印 items
```

工具代码可复用`core/content_library.mjs`的resolveContentReference／searchContentLibrary。目录中的runtime_registered=false不开放执行、入队或学习。

## 数值配置

`index.json`选择original／debug并引用四个文件。skills／items为v3，battle／rewards为v2；身份、name、owner及文件级source_hashes只读，只编辑稀疏`parameters`。

- `{}`沿用来源默认值，不表示禁用；删除修改字段即恢复默认。
- 嵌套对象按字段合并，数组整体替换；未知字段、错误范围、身份错配和来源漂移拒绝。
- original要求生效值与来源一致；debug应用修改并保留差异／快照。
- 普通导出迁移旧格式、补新编号并保留调参；`--force`只强制生产，配置导出器显式`--reset`才清空修改并恢复original。
- 页面启动时读取并编译一次配置，各入口取得独立副本。改参数或模式后先保存、刷新，再读档继续；返回标题或新游戏不重新读取，无需重启静态服务。

例如把燕突耗蓝改为5，只修改其parameters：

```json
{"mp_cost": 5}
```

装备速度的局部修改示例：

```json
{"attributes": {"speed_flat": {"minimum": 40, "maximum_exclusive": 40}}}
```

默认与生效值只读查询，不导出或写文件：

```console
node remake/runtime/tools/export_runtime_config.mjs --reference skills yantu
node remake/runtime/tools/export_runtime_config.mjs --reference items 4
```

类别支持skills／battle／rewards／items，省略编号返回该类别。未接入记录仍可查来源，不因配置存在而可执行。

### 参数分工与边界

| 文件 | 可调内容及规则 |
| --- | --- |
| skills | mp_cost、physical_multiplier_percent、element_power、defense_bonus、term4_bonus、hp_term_bonus、hp_max_term_bonus、preparation_delay_raw、required_role_level等已接入字段。required_role_level为0～99的人物等级门槛，学习扫描、菜单及战斗使用共用；技巧前置、动作、目标、接触、反击和状态行为仍来自源记录与处理器。 |
| battle | enemy_编号的新敌人HP／MP、attack／defense／speed／抗性；ai_编号的原技能权重与组合概率。权重不自动归一化，人物当前资源／等级不在此覆盖。 |
| rewards | experience、money和有序drop_item_ids；重复候选保留抽签次数，掉落及非零金钱合计最多六个原槽。 |
| items | 全部原item_id的drop_rate和已实现装备／药品／晶石参数；未恢复特殊行为不能用enabled强开。 |

`minimum／maximum_exclusive`沿原取值函数解释。41D990／41C610在上限≤下限时返回下限且不抽RNG，如原(200,0)合法；正跨度仍核32位范围及溢出。速度采样使用自身有序正区间，不能套此例外。preparation_delay_raw是准备量而非毫秒，0沿调度默认800；调度20ms一tick，average_speed_factor来源默认200。

技能按owner的role_id／skill_index／side绑定，MAG按source_kind／magic_index；未分类CHR side=source。接入敌人时，普通导出核身份、名称和SHA后迁移side，保留共同修改；mp_delta_raw仅按已恢复语义转换，不猜为耗蓝。敌方非零耗蓝及不足后备未恢复，继续拒绝。场外技能与战内同记录共用一个ID及配置。

道具drop_rate=-1不抽签、0走特殊必掉落分支、1～100沿原概率叠加已恢复连击奖励。配置不重写原字节、已保存实例、当前资源或学习状态，不接受表达式，也不关闭奖励去重。

## 道具、装备与晶石

默认准入从已登记玩家原初装、已登记入口可达的真实授予、kind8货架及mutation17配方产物推导。NPC未登记的其他奖励不因导出整张TLK而开放；准入说明在`catalog.equipment_admission`与`catalog.item_capability_admission`。开启一件奖励须完整验证其使用闭包。

| 类别 | 接入合同 |
| --- | --- |
| 装备 | allowed_role_mask按原角色位，0不限；slot_id沿来源。26个已参与getter的attributes按原范围链接实例，不重抽、不改source_raw_hex；换装保留raw HP／MP，充槽读原raw速度。 |
| 普通恢复药 | use_in_field／use_in_battle限定场合，effect控制已恢复固定／百分比恢复；普通恢复不复活。 |
| 状态／复活药 | status-cure、status-clear、status-attack及revival-item按原mode／目标判定；菜单、排队、派发和接触共用资格，实际接触才按原规则抽签与消费。 |
| 火蜥之血272 | mode1只解除首个ID5状态，不清其他状态、不抽随机；无匹配状态仍可演出但不扣库存。原场外数值为零而拒绝使用，不靠enabled扩大场合。 |
| 清状态331 | 原mode5／id0与敌方单体，来源为042实际掉落；免疫或无有效目标不消费，不按名称补效果。 |
| 数值晶石 | 同一items配置；人物保留六槽，武器决定当前可操作孔数。替换先返还，换武器保留隐藏槽；禁用后已有项仍可卸除。 |
| 已恢复被动 | mode6保留原块、状态槽顺序、成功率和CRT消耗。127是35号免疫，非自动复活；170按原rand()%100<=60初始化6号免疫。 |
| 材料 | crafting-material可保存、买卖并按原配方消耗，不进用药菜单；服务见[剧情指南](story_guide.md#城镇服务与金钱)。 |

已有装备的数值合同与被动准入分开，例如51烈焰冠的既有数值／装卸仍支持，未登记被动不注入状态或增加RNG。未知特殊块、遭遇修饰、动画技能和初始化继续阻断；来源描述不符仍拒绝。旧完整配置仅在只读基线精确匹配时迁移，显式禁用使用稀疏enabled:false。

## 地图与演出登记

runtime_content编辑格式v2只保存选择；默认路径、原旗标、角色原槽、ANM来源和休息选项由共同来源解析器推导。

| 字段 | 职责 |
| --- | --- |
| maps | 原地图ID及npcs、triggers、objects、rests、routes；空图可为{}。objects绑定原index与共同handler，rests选择descriptor_id。 |
| maps.npcs | 显式原零基槽数组，[]保留显示但不开放交谈；省略兼容旧隐式行为，未知分支仅提示。新地图使用显式登记作为能力门槛。 |
| maps.objects | index绑定原零基物件。handler为stationary-chest（CF3剧情箱）、keyed-chest（CF4直接奖励，钥匙0表示不需要钥匙）或tlk-object（CF1可重复主动交互，沿原+F6执行TLK）。 |
| maps.entry／setup | true分别选择DAT真实到达／加载布置，事务及恢复行为见剧情指南；不手填替代记录。 |
| maps.routes | 可只登记descriptor_id，由DAT推record_id；已有前置演出保留原requires_flag、animation及denial_record_id等来源条件。 |
| maps.export | 默认{assets:"chapter",story:true}；assets="existing"保留旧生产者，story=false不开放该图TLK。生产归属不替代交互登记，无TLK图仍保留DAT入口来源。 |
| programs | 原ANM ID；地图依赖来自实际TLK／DAT调用者与opcode10。无加载指令时继承已核实调用地图，不由名字猜测。 |
| stages | 同格式新舞台可登记ID与{}，默认Fight_Bk/<ID>.scn；可指定path／schema／asset_prefix。旧path默认existing，通用导出显式export:"source"。 |

通用舞台支持已恢复的SCN v2／mode4、默认640×480零镜头、天空单循环及静态景物。新格式、非天空动画或动态镜头先补规则。大地图入口从原marker和sort_code推导，缺少支持拒绝，不填兜底坐标。

新图流程为chapter-story→preflight→content；显式入口远期可达分支也须通过。不能独立准入的入口登记依赖阻断，不能按存档旗标隐藏。独立事件与任务格式见[剧情指南](story_guide.md)。

## 新增角色、技能与怪物

1. 核原CHR／DGP、身份、初装、成长、技能索引、动作及需要的舞台。新机制先恢复共同处理器，不在脚本按名字特判。
2. 在roles选择player／enemy；玩家battle_skills／field_skills登记原index与处理器，primary_skill选主要表现。技能可省略id生成原编号格式，已有ID保持兼容。
3. battle_rosters保存明确资源身份；正式阵容可使用`$players`／`$enemies`。技能登记、剧情入队与学习进度分别处理。
4. content构建统一生成玩家、怪物、AI／反应、状态、技能、生命周期、成长、遭遇／奖励、道具动作、声音、字体与图集，并向统一配置补项。
5. 核队列／菜单、等级与学习门控、自然遇敌或剧情战、目标／动作／反应、胜败／奖励、保存恢复及取消。角色入队还须有真实剧情，不由登记自动发队友。

敌方遭遇来自已登记地图DAT频率和全局STG池，不用配置编造。森林状态表由enemies唯一生产，party-skills及道具只校验引用；同一生成表不维护第二生产者。

学习进度使用party[].skill_progress v2的learned_indices及records，旧v1兼容；原技能等级、初始学会字节和前置熟练度保留。候补恢复同一实例，离队不压缩阵形；满四人入队不写入。组合容量与晶石孔数各沿原定义，不混用。

重制学习规则：有前置时同时检查人物等级和全部非空前置技巧等级；无前置的命名技能只检查人物等级，等级0表示没有额外等级门槛。援攻（队友原技能ID71／72）只由剧情授予，不参加自动学习。胜利结算先处理熟练度并扫描学习，人物升级后再按新等级扫描；满级旧档也能在下一次胜利补学，已学技能不会重复通知。朱特005／29、30援攻在运行副本中纠正为type3，原CHR字节、来源类型0及指纹保留；菜单、编成、统一配置和战斗共用纠正结果。配置original／debug仅决定数值覆盖，不切换这些修复规则。

人物等级门槛统一修改`data/config/skills.json`对应编号的`parameters.required_role_level`，并将`data/config/index.json`的mode设为debug。当前四项覆盖为001_48超魔剑50级、003_51疯狂爆裂击53级、005_33崩壁35级、006_35贝鲁吉斯52级。配置在页面启动时编译，刷新后生效；原CHR记录不改写，旧档已学标记不撤销，但使用同样受新等级门槛约束。例如：

```json
"001_48": {
  "name": "超奥义．超魔剑",
  "owner": {"role_id": "001", "skill_index": 48, "side": "player"},
  "parameters": {"required_role_level": 50}
}
```

已接入处理器包括direct、effect-carrier、native-support、native-revival等，各自仅代表已恢复模式。辅助状态与攻击状态分开；越界物理帧可保留原时钟但不绘制，精确缺失特效沿原加载失败，不补替代媒体。浮空、原技能加载派生、wait0独立载体和type0资格的共同约束见[来源规则速查](../assessment/region_remake_workflow.md#来源规则速查)。

游戏内“开发检查”提供三人扩展样本与99级全技能A／B档，均只改变独立世界、不自动存档或修改正式学习来源。A组出战001／002／003／004，B组001／004／005／006，其余队友候补；原条件表和导入档按[本地资料](../local_materials.md)交接。
