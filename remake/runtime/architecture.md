# 第七封印 · 当前实现架构

更新：2026-10-23；路径以runtime为基准。

## 目录

- [启动与分层](#启动与分层)
- [正式与实验的边界](#正式与实验的边界)
- [Phaser目录（相对web）](#phaser目录相对web)
- [时钟与暂停边界](#时钟与暂停边界)
- [三个状态边界](#三个状态边界)
- [内容生产与运行登记](#内容生产与运行登记)
- [数据分工](#数据分工)
- [地图、剧情与演出](#地图剧情与演出)
- [战斗规则与表现](#战斗规则与表现)
- [菜单、保存与声音](#菜单保存与声音)
- [扩展位置](#扩展位置)
- [当前边界与维护](#当前边界与维护)

## 启动与分层

`serve.py`提供静态文件和固定存档接口：/只映射web；GET／PUT `/api/saves/00`至19及quick读写`../saves/SaveGame00.json`至`19.json`与`QuickSave.json`，GET `/api/saves`批量列出21个槽的存档／空／损坏状态。manual兼容00，旧`SaveGame0.json`仅作为00的后备读取来源。封装校验后在同目录临时写入并原子替换，创建及覆盖使用If-None-Match／If-Match防止并发误覆盖；仅接受本地同源请求，不提供原程序、原存档、证据目录或任意文件路径。

Phaser `3.90.0`运行库固定在`web/vendor/phaser`，保留MIT许可和SHA清单；直接随静态服务提供，不依赖CDN或npm安装。

`web/app.js`创建共享state和actions，装配services、map、story、menu、session、battle、inspection、input、boot控制器，再调用boot。

app先创建`phaser/runtime.mjs`中的PhaserRuntime。runtime场景只推进共享转场与界面；exploration和battle分别在自己的update中调用探索／战斗适配器并绘制，地图控制器不再推进战斗。原SceneController继续负责世界地点准备／提交／回滚。

controllers处理浏览器流程和系统连接；core处理来源校验、资格、规则与事务；视图负责输入层级和绘制。新规则不写入`app.js`或按人物名字分支。

input连接fullscreen适配器：点击全屏后仅申请锁定Escape，短按沿用游戏返回；全屏内保留退出按钮与长按Esc提示。退出全屏／释放输入时解除锁定，不支持或拒绝权限时在画面内提示。

boot读取目录、内容登记、来源数据、配置和界面清单，准备共享视图及世界／场景／战斗入口。新增控制器通过同一`state/actions`连接。

## 正式与实验的边界

正式生产链：原版只读输入→`tools/source`解析器与tools导出器→`web/data`及`web/assets`→正式游戏。

实验复用方向：prototype→runtime的正式模块、媒体和基础清单。正式运行与构建不读取实验目录。

共享移动位于`web/core/movement.mjs`；DGP／地图／CHR只读解析位于`tools/source`；extract、export_movement、export_combat_lab和export_combat_presentation位于tools。正式媒体统一位于`web/assets`，正式素材URL使用/assets/。

`web/data/source`中的`manifest.json`、`combat_manifest.json`、`combat_presentation.json`是迁入的基础导出清单，保留原字节及历史来源引用；当前正式运行清单已使用新路径及匹配的文件哈希。新增内容的编辑登记仍是`web/data/runtime_content.json`，数值编辑仍在`web/data/config`。

prototype自有服务默认8765，只读挂载正式模块、媒体和基础清单供实验复用，不提供存档写接口；正式服务默认8767，只挂载web。

旧媒体及来源证据的迁移映射在`tools/layout_migration.json`；复制与交接步骤见[README.md](tools/README.md)的“旧环境升级”。evidence中的来源／台账仍属于当前构建依赖，目录分离不代表首次构建已打通，历史浏览器观察也不能作为当前代码重播。

## Phaser目录（相对web）

- **`phaser/runtime.mjs`**：引擎创建、阶段到场景生命周期的映射、暂停原因、缩放、同步截图和释放。探索／战斗切换使用sleep／wake，菜单／加载保留画面并pause，主菜单与启动阶段休眠游戏场景。

- **`phaser/scenes`**：exploration_scene与battle_scene，分别拥有update、动作时钟和显示对象；shutdown与destroy都清理自有对象、纹理引用和待执行任务。

- **`phaser/actors/map_actor.mjs`**：可销毁重建的地图人物／物件显示组合，持有SpritePose。

- **`phaser/components`**：sprite_pose适配原帧／光层和可选的逐帧阴影；action_clock由所属Phaser更新步的delta推进，负责源动作等待、并发和取消。探索演出用探索时钟，战斗规则与表现共用战斗时钟，共享转场用runtime时钟；Sprite不额外启动命中时钟。

- **`phaser/rendering`**：texture_cache管理纹理引用，battle_surface将既有绘制命令适配为Phaser对象。

- **`phaser/preview.mjs`与`phaser-preview.html`**：独立示意素材验证入口，不进入正式内容登记。

- **`vendor/phaser`**：固定版本运行库、许可及`manifest.json`。controllers、core、data、assets及导出工具继续保留原位置。

截图临时选择可见场景，完成后恢复原模式，不推进时钟或世界。

## 时钟与暂停边界

PhaserRuntime按原因集合管理页面隐藏、手动暂停和错误挂起，全部原因解除后才恢复；场景休眠／暂停时，其update及ActionClock不推进。探索／战斗唤醒或恢复，以及runtime时钟恢复的首帧丢弃该次delta。

正式ANM、物件演出、DialogueView文字／画像、CaptionView字幕及事件wait使用`exploration.clock`，战斗动作／充槽／生命周期使用`battle.clock`，共享入战转场与默认加载展示使用`runtime.clock`；序章加载显式使用探索时钟。这些时钟由Phaser的delta推进，暂停时不消费等待时长。

战斗调度按累计场景时间逐个执行20ms逻辑步，保留不足20ms的余量；充槽、状态效果及行动仲裁随每个逻辑步推进，卡顿不丢步，战斗结束或中断立即停止补步。待机绘制仍采样当前场景时间，暂停／恢复沿用场景时钟及首帧丢弃delta的规则。

`controllers/story.playStory`为序章、地图入口剧情、NPC、物件和休息事件建立唯一StoryPlayback会话，传递同一个取消信号；嵌套TLK／ANM复用会话。暂停不接收对白确认／选择，恢复首帧不补算后台经过时间；成功、失败及中止分别收尾，统一清理对白、字幕、临时演员、物件预览与按键。取消／错误会阻止后续指令和世界提交，正常事件仍由原事务完成一次提交；pagehide与引擎错误会中止当前会话。

视图无注入时钟时保留独立展示／工具的浏览器计时退路，正式入口始终注入场景时钟。菜单和启动页的tick仍接收Phaser传入的now，媒体也有独立生命周期；全局暂停剩余边界与完成标准见[validation_design.md](../assessment/validation_design.md)。本轮不提供剧情快进或跳过。

## 三个状态边界

- **WorldStore持有可保存世界**：地点、人物资源／成长、背包／装备、旗标、事件、队列、技巧／晶石、遇敌RNG与奖励去重记录。变更通过草稿及revision提交，避免异步加载覆盖期间的新操作。

- SceneController管理地图准备、切换和回滚；先准备必需资源，再提交地点／图层／NPC状态，失败恢复原场景。

- BattleController持有本场参战者、资源快照、充槽、输入、按人物保存的待执行指令、动作和生命周期。`scheduler.pending`保留首条，queued_commands保存其余队员的指令；原充能／阵营仲裁选择人物，不能把某人的指令借给其他人。确认时保留道具数量，使用事件才消耗。通过planning／commit向世界一次提交本场结果，重复返回不重复扣费或发奖励。胜利演出与跳过输入统一使用战斗场景时钟。

配置快照和浏览器偏好分别独立于WorldStore；菜单焦点、预览、动画和加载锁也不写进世界进度。

## 内容生产与运行登记

唯一编辑登记是`web/data/runtime_content.json` v2；只选择角色阵营、技能原索引／处理器、资源阵容、舞台、ANM程序和地图交互。

`tools/content_registration.py`直接读取编辑定义选择生产输入，不要求新地图／怪物预先有生成产物。

`tools/build_runtime.py`按声明依赖导出；chapter-maps／chapter-story准备地图与剧情，enemies准备怪物，随后准备玩家、遭遇／奖励、配置、表现、音频、字体和目录。

story-check读取已导出的源表，沿显式入口遍历TLK分支和ANM嵌套对白，提前阻断未实现能力。旧隐式NPC仅列提示，显式npcs作为构建门槛；最终内容编译再次执行同一检查。`--preflight`提供只读入口，不要求本次重导媒体。

`core/content_definition.mjs`与`tools/resolve_content_definition.mjs`共用来源解析：展开角色身份／原槽、默认技能ID、ANM来源、地图原旗标与休息选择。

`export_content_registry.mjs`核对跨文件依赖和原输入，生成`web/data/runtime_content.mjs`。boot比较其中definition快照与编辑JSON，拒绝未编译登记。

运行登记不进入存档；添加登记不自动入队、学会技能、打开触发器或实现新机制。

## 数据分工

`web/data/config/index.json`及skills／battle／rewards／items是唯一数值配置。skills和items为v3，battle和rewards为v2；每条只保留name、必要的owner和稀疏parameters，source_hashes按原文件集中登记。默认值及完整来源保留在生成数据中，可由配置导出器`--reference`只读查询。

`core/config_overrides`把修改项按字段合并到来源基线，数组整体替换，再交给既有编译器校验范围、身份及机制支持。original模式拒绝实际数值差异；编译后的审计与战斗快照仍保留完整生效参数。空parameters不表示关闭或未接入。普通导出迁移旧完整配置，补齐新角色／怪物的技能、属性、AI和奖励条目，并保留已有调参；未知编号和来源指纹变化拒绝写入。

CHR／DAT／TLK／ANM和生成的`party_*`、`forest_*`、`enemy_*`等JSON保存来源及可执行输入，不作为另一套手工调参表。部分forest命名保留历史接口兼容。

`library/roles.json`、`skills.json`、`magic.json`是全量静态来源，`library/index.json`将它们与既有`items.json`及统一配置关联，供内容编写按原编号引用。全量配置保留现有技能ID和参数，只追加缺项；源技能与已实现技能分别校验，`compiled.skill_registry`仍只容纳已实现处理器。原生MAG存在重复ID，按原记录索引绑定。原始全表启动时读取一次，不复制进世界或存档；查询与索引构建复用`core/content_library.mjs`。

地图数据放`data/maps`，资源放`assets/maps`及角色／物件图集。catalog记录可用地图、资源入口及文件身份；content登记进一步限制已接入交互与机制。

技能／道具注册按原角色ID＋技能索引、原道具ID绑定；保存实例、角色当前资源和学习进度独立于参数与原字节。

详细编辑步骤与字段见[config_guide.md](config_guide.md)，构建命令和工具分类见[README.md](tools/README.md)。

## 地图、剧情与演出

`runtime_content.story`显式登记独立事件与任务文件；`web/content`为编辑内容，`web/data/story`为生成产物。`tools/export_story_packages.mjs`核对保留来源、可达能力和引用，生成共享包、分地图包、文本表与序章包；content编译同时生成这些产物。详细编写／快速构建入口见[story_guide.md](story_guide.md)。

`core/story_flow_compiler.mjs`将原TLK和旧／自编NPC事件统一编译为StoryFlow命令图，`core/story_flow.mjs`提供唯一流程执行器。ChapterRunner提供共同事务与游戏行为适配；NPC入口只引用flow_id。炎城侦探作为开发片段保留，也采用完整成功后提交。`core/events.mjs`仅保留旧来源核对适配，调用同一个执行器，正式浏览器入口不引用它。

map controller提供地图载入、视口、连续移动、NPC与交互的探索适配器，由`exploration_scene.update`调用；terrain、占格、路径、移动／遇敌规则由对应core及`core/movement.mjs`中的MovementMap处理。

`core/map_locomotion`供玩家、剧情与普通NPC共用46CED0移动间隔换算和地图native_step_shift，以实际接受的轴向距离推进步伐；4984E0先减后测的计数对应行走两次步进、跑步三次步进。玩家保留连续键盘控制与斜走速度归一化，走跑／转向保留相位，受阻／松键站立。map_npcs保留源路径、占格、逐轴逻辑步进与独立RNG；visual坐标只追随已接受位置，并以相同源速度平滑，motion携带显示位置／朝向／帧，身体与阴影共用。停谈与暂停冻结显示，剧情接管从显示姿态开始；这些场景内状态不进入存档或遇敌计数。连续显示不声称原版逐帧动态等价，普通NPC斜走仍沿源逐轴步进。

旧地图包缺少源步长字段时，nativeMapMovement在prepare阶段使用同一DAT路径／SHA的完整370字节来源头恢复+0x144／145，并拒绝已有值冲突；不猜默认镜头速度。

MapNpcRuntime在角色加载时按469F50从完整ROLE动作raw+7E派生20通道，保留DAT模板绑定；缺walk才继承idle。OpeningView复用同一初始化结果，不能把DAT的FF模板当成已加载动作，或给特定NPC写默认动作。

MapObjectRuntime以地图／原物件索引绑定CF1单动作和既有CF4动作，原记录与DGP动作字节严格校验。主层与intrinsic同帧显示，透明来源也保留原队列身份。CF1按410850初始化、4137C0逐次循环；独立场景视觉CRT不写WorldStore或消耗持久遇敌RNG。隐藏物件继续走源时钟，ANM接管NPC不停止物件；加载、页面挂起及非探索场景按统一暂停策略处理。

ANM33的+25低字节经anm_runtime以arrivalFacingRaw传递：0保留当前朝向，1..8在到达时减1写入方向，不参与速度计算。OpeningView按移动动作及源人物speedBias得到步进速度，用相同DistanceGait推进逻辑序列帧；直达／分轴路线沿现有舞台配置。零距离只处理到达状态，短路径按实际长度完成；原指令、并发等待和取消仍由ANM执行器管理。

`core/map_presentation`生成按原图层／地面Y排序的只读显示描述。`phaser/scenes/exploration_scene`使用MapActor与SpritePose在同一深度组合人物阴影、主层和光效层，Phaser相机保持640×480原逻辑平面。阴影由map_shadows按原DGP逐帧跨度掩码导出，按动作包围框压缩图集，shadow_geometry恢复原帧内偏移；黑色alpha128近似原16位RGB分量减半。MapActor为临时显示对象，不保存HP、成长或旗标。

map_scene_view保留为存档缩略图与几何对照绘制，消费同一map_presentation。OpeningView同时提供显示描述与兼容draw回调；正式ANM动作、物件动作和战斗转场由Phaser驱动的ActionClock推进，原等待、并发与取消契约不变。

chapter-maps从原DAT的state0描述推导已登记地图间的物理出口；剧情型出口、前置条件和演出继续走TLK／ANM系统。

TLK kind2通过同一StoryFlow的transfer_native_map处理：地形触发器明确传递原descriptor，+2A提供入口排序，TLK +2F提供目标地图marker。controller先租用／准备／校验目标地图，ChapterRunner在同一草稿和播放会话运行目标到达事件；失败／取消回滚场景与进度，成功后释放地图包，不另开场景事务。

跨地图ANM依赖由真实opcode10与TLK／DAT调用来源推导，保留caller_maps、control_maps和最终地图。StoryRepository按演出显式依赖租用地图，按图加载不会递归拉取图内其他演出依赖；多图共享程序在最后一个持有图释放后才回收。DAT +14E指定Mapm物件资源目录，共用背景的地图变体不按地图文件名猜物件路径。

map_connections按登记与源描述连接大地图出口，并共用原标记／排序规则推导大地图进入位置。chapter_story覆盖已登记出口来源，route_events只兼容尚未接入TLK的旧地图。

`maps.entry`明确选择DAT +0x13A到达剧情；SceneController与WorldMapController通过同一enterMap钩子执行，位置和剧情共用未提交草稿。失败回滚显示及世界状态，过期revision拒绝覆盖；启动、恢复和缩略图不触发到达剧情。

`maps.setup`对应DAT +0x8A的地图加载布置，由`core/map_stage.mjs`在每次prepareMap时通过共享StoryFlow投影NPC。读档先使用恢复草稿计算布局，预览使用被预览存档；不会读当前游戏的旗标替代目标存档。加载布置只读且不移动玩家或消耗一次剧情。M17030、M17030-1、M17030-2保持独立地图、NPC表和旗标身份。

`core/native_story_conditions.mjs`恢复原物件状态、背包装备及队员资格判断；`core/native_story_mutations.mjs`处理按源技能ID学习、合成配方解锁与原无效果指令。缺席队友的学习请求保留在native_pending_skill_unlocks，入队时应用；recipe_unlock_indices只记录配方，不等于合成界面已经实现。可选存档字段不重写旧存档或已存技能成长。

`maps.export`标记生产归属：新地图默认chapter素材和story=true；existing地图由已有专用导出器负责，story=false表示尚未接入其TLK。该选择不替代运行交互登记。

chapter-story按登记读取原记录，道具定义从mutation5引用推导，角色初值按登记玩家生成；ANM地图依赖取实际TLK／DAT调用者和opcode10加载目标的并集，保留加载顺序及最终控制地图。允许多图演出，没有opcode10时继承唯一实际调用地图；未恢复格式明确拒绝。

`core/chapter.mjs`适配已恢复剧情行为，保留草稿、源记录与事件状态，控制流交给StoryFlowRunner，失败不提交。`core/chapter_animation.mjs`验证受支持ANM指令；`core/anm_runtime.mjs`处理动作等待、并发、取消和过期完成。

入队统一经`party_members.mjs`检查原身份、初始化和重复入队，补队列空位及遇敌计数；已有成员保留资源／成长，RNG不重置。原离队将完整成员及遇敌进度保存在可选reserve_party封装，清除对应阵型槽且不压缩；再次入队恢复原实例。party_roster提供active＋reserve归属校验，实际行动仍只使用active；opcode36 mode3单独切换控制角色。

TLK kind5通过`core/scripted_battle.mjs`读取原stage＋6个固定文件字段，编译为同一个StoryFlow的native_battle。`controllers/battle`在独立WorldStore中运行本场，延续持久CRT流，不抽STG组或重置移动计数；正常返回后合入外层剧情draft并恢复ANM游标。战斗失败／取消或后续演出失败不提交整段剧情；全队败北结束当前剧情并进入原game-over策略。入战像素表现继续使用既有独立视觉随机适配，不能据此宣称全局原生RNG调度完全一致。

ANM媒体由story-media目标提取，`controllers/story`按需构造StoryMediaView，显式声音句柄、BGM临时静音／恢复与媒体清理共用剧情会话。转码头部增益写在`manifest.audio.playback_gain`并由临时WebAudio GainNode恢复；不会更改保存的音量偏好。浏览器编解码、路径插值与原混色仍为适配，原音视频执行需另做观察。

DialogueView管理原对话板、画像、打字、滚动／换页与选择，OpeningView及字幕／加载视图负责对应演出。空白对白、退出或失败都须完成相应等待与清理。

## 战斗规则与表现

encounters从登记地图的原DAT频率和STG池生成来源表；运行端按成功移动步长、可保存RNG及A／B池生成敌组。

party_sample／forest_sample组装本场来源，party_attributes组合当前人物、装备与晶石派生属性；skill_registry／runtime_config应用同一配置快照。

combat、combat_rules、forest_ai、battle_scheduler等core模块负责原公式、抽随机、选招、20ms充槽、目标与动作仲裁。技能学习、人物等级和实现处理器分别门控。

`core/battle_techniques`将保存的编成记录映射为本场命令，只引用各成员已编译的技能，不另建数值配置。轮盘和招式列表共用命令资格／目标检查；combat按原顺序合并成员动作，准备量和MP合计、熟练度逐招记录，动作与独立特效接触读取各自的成员属性。未接入或等级不足的成员保留存档并显式禁用该组合。

native_skill_loading在不可变CHR来源上派生4FED00加载后的技能code，正常战斗使用真实入口4451C0设置的模式0；forest_ai消费派生值并保留原选招RNG次序，不直接将文件code当作组合资格。

类型恢复、受击／反击、状态、死亡／起身、技能成长、奖励池与结算各有独立core模块；BattleController连接它们并保持单次资源提交。

BattleView消费时间线和只读表现数据，不修改HP／MP或抽战斗随机。场景、角色和效果共用640×480逻辑坐标。

战斗头顶光标使用同帧人物绘制坐标（含反击通道位移和native_z_raw），Y为人物Y－DGP extra_header+0x0C高度－64－光标自身锚点Y；高度随资源编号导出，并同步battle_packs内嵌清单，不按队伍索引或姓名配置。原调用分支的保留指令见`tests/fixtures/battle_cursor_native.json`。

正式BattleView注入`phaser/rendering/battle_surface`提供的绘制接口。已有源图集裁切、平移、缩放、加色和文本命令转为复用的Phaser Sprite／Graphics／Text；不将整场旧Canvas逐帧上传为背景。BattleResources原SHA、尺寸、分片和资源租约检查继续生效。

第一版选择Phaser的Canvas渲染后端以衔接现有加色语义。TextureCache仅拥有Phaser纹理引用，不取代ImageResources／BattleResources的解码与来源校验；每帧回收未使用的纹理引用。`battle_scene.update`驱动战斗控制器与已有源时间线，动作、充槽和生命周期使用同一场景时间；休眠或暂停时均不推进，Sprite不额外启动自动播放时钟。

forest_stage先完成天空、地面、全部场景贴图，再画按地面Y排序的战斗人物，最后画效果和HUD。人物升空与地面锚点分开，背景纹理不与人物混排。

battle_layout按保存的四个固定队列槽定位，不压缩空位；idle、受击和防御的已接入时序读取各自源动作。普通攻击／技能仍有预览时钟与轨迹适配边界。

battle_lifecycle_view独立推进入场、死亡、起身，完成后回执core；死亡完成前不结算终局，复活epoch使旧回执失效。

存活／死亡仲裁区分原rawHP、装备后的显示HP和死亡类别。正式败北返回在`core/recovery.planPartyDefeat`要求完成死亡类别7、落地、非active且无待结局／生命周期；不得再要求装备后的显示HP为0，旧无类别适配快照才沿HP0合同。复活的候选、排队、派发及接触共用原类别资格，不重复以显示HP过滤；复活只开启新生命epoch，不重置正在运行的源Z与浮空时钟。

battle_packs用裁切图集保留源PNG核对关系；资源完成解码后才开放战斗。准备期间保留原画面，不显示通用或地图载入页；随后直接衔接七种原来源转场和人物入场。转场首帧绘制完再显示共享画布，防止残留载入图闪现。battleEntryPending、加载锁和有限并发图片池控制入场，表现随机与战斗RNG分开。

BattleView按本场resource_id选择人物动作及本体图层；特效归属从技能／反应序列、生命周期和用药计划推导，包含command4原记录+0x4E的接触特效。多个角色可引用同一份特效，特效目录本身不表示全局加载。当前保守准备参战角色的全部已接入表现与药品效果，不因临时HP／MP、沉默或倒下而裁掉后续可能使用的资源。缺失原文件继续遵循原失败分支；同ID表现沿既有首次匹配规则选择，后续来源变体只供导出核对。

图集按role-原角色ID、stage-舞台ID及独立HUD／结算分组；特效先按原资源ID登记引用、跨特效去重相同可见像素，再按每个图块的角色使用者集合分组为effects-roles-编号集合。相同使用范围的特效合页，重复像素只有一份，避免每个特效独占页面的碎片；无引用的保留来源不会自动载入。继续裁透明并以2048为页面上限，不同舞台或无关特效不再混在同一公共组。旧图集映射仍可读取，但必须真实重建页面才获得分组后的驻留收益。BattleResources继续按页面合并请求与租约保留，192MiB为解码页面缓存的软预算，不强制淘汰本场活动页面。离场／取消释放本场引用，闲置页面再按预算回收。

`tools/export_battle_packs.py --plan`用已编译登记、源表现元数据和既有图集区域估算新分组；支持按本场角色／舞台比较旧加载、仅筛选及重分组后的页面体积。该入口不读取媒体或写正式图集，不替代来源、像素和浏览器验收。

battle-stages按登记读取原SCN／DGP生产同格式背景，复用来源解码／像素审计和默认镜头规则；战斗背景与音乐按本场实际stage选择。旧专用舞台产物继续由原导出器维护。

## 菜单、保存与声音

菜单、对白、字幕、加载及像素转场沿用已有DOM／局部Canvas视图；这些界面保持现有输入层级、字体和音频控制。Phaser不安装第二套键盘和音频系统。输入在运行挂起时清除按键，事件监听通过AbortController在退出时解绑。

phaserHost承载可见游戏画布。stage与battleCanvas保留为透明的兼容焦点／截图目标；入战截图调用captureScene同步渲染当前Phaser显示列表，截图过程不推进世界或动作时钟。

menu controller通过core事务连接装备、用药、技巧、队列和晶石；OperationMenuView及子视图管理页签、候选、焦点、取消和动画。

队列formation_slots、七槽technique_bindings、组合technique_combinations、六槽crystal_sockets及技能skill_progress是可选保存状态；旧格式沿现有兼容规则读取。

技巧测试复用正式战斗和同一数值配置，以私有票据保留菜单页／焦点。测试门控控制HP、MP及敌方主动派发，药品等真实资源变化仍按正常事务提交。

菜单站立interval由party_battle_view中相同角色idle生成；队列、状态和装备共用，不维护第二份速度参数。原菜单DGP的120ms留作来源，并非当前统一播放策略。

`core/audio`管理素材、音量、静音与cue；menu_feedback对每次输入／事务只发一次反馈，音效诊断有限保留。音频导出按登记地图及技能／动作来源建立清单。

session controller管理保存、载入、导入／导出、主菜单与缩略图。新截图绑定世界payload，旧存档预览只读重建，过期异步结果不覆盖当前页面。

`core/save_slots`统一20个普通槽与快速槽身份。save_storage批量读取并隔离单槽错误，仅在空00槽迁移旧浏览器存档。services统一存取锁及save-io阶段；save-menu阶段保持画面并暂停探索，只有当前页面的选择可以发起存取。SaveMenuView使用save-menu导出的Game_Save_01／02／03原始像素及按钮矩形，显示三行、滚动选择与覆盖确认；打开／选择／取消均不写文件。标题读取页滚动显示所有已有普通档与快速档。读档复用WorldStore校验和SceneController恢复事务；偏好仍独立保存在浏览器。

剧情style1选择从TLK原始三槽解码；床铺继续核对登记选择。主动NPC交互到达mutation4时只返回save_requested，剧情成功提交后再显示通讯水晶保存界面，避免在未提交草稿上落盘。

终章由`core/story_completion`读取原1999:1，并维护独立版本化MenuCode等价元数据；不改世界存档格式或原注册表。成功ANM只提出收尾请求，story会话将其绑定world／完整预期快照／场景请求，session等世界提交后切标题并禁用resume；`SceneController.afterCommit`覆盖地图到达事件的外层提交。标题显示失败不能撤回已经提交的世界或重新开放探索，浏览器存储失败仍进入标题。原25影片已在ANM中播放，不额外拼一段credits。

只有完整ANM产生的终章请求才声明resume_exploration:false：保持源隐藏人物位置，跳过探索落点校验、NPC姿态采用和探索HUD重建，仍校验世界结构、地图身份与提交版本。普通事件继续严格校验可通行落点；不为终章发明一次归位传送。

## 扩展位置

- **地图／出口**：登记、导出器、map controller、`core/scenes`／route／world_map规则和地图资源；共用`phaser/scenes/exploration_scene`显示，几何描述放`core/map_presentation`。

- **剧情／演出**：chapter来源、story controller、chapter／chapter_animation／anm_runtime及OpeningView；通过`phaser/components/action_clock`同步动作，人物主层／光效由SpritePose显示。

- **队友／技能**：登记、原CHR／技能动作、`party_*`导出、统一注册／配置、party_sample、菜单和表现；地图显示共用MapActor，战斗显示共用battle_scene／battle_surface及原动作时间线。content_sample只用于隔离验证。

- **怪物**：enemies、enemy-rewards、encounters目标及统一配置；新增行为先补规则，再登记。

- **道具／晶石**：源ITM、item_registry、items／equipment／crystal_sockets等通用处理器及界面连接。

- **UI**：现有controller和view、Phaser显示场景及相应组件，原素材／字体导出及状态验收；通用方法见[menu_alignment_workflow.md](../assessment/menu_alignment_workflow.md)。

## 当前边界与维护

`web/phaser-preview.html`使用独立示意图和现有战斗定义，复用正式PhaserRuntime、Scene生命周期和动作时钟，支持暂停／恢复及动作中切换探索／战斗；检查探索、缩放、动作命中及截图，不写正式存档、不关闭正式素材校验。检查命令、选项与结果解读见[README.md](tools/README.md)。

当前代码已接入Phaser运行与显示层；各阶段验收范围及本版待办只维护在[validation_design.md](../assessment/validation_design.md)。

构建支持已恢复的矩形v6地图、全局STG池、指令、状态和掉落类型。SCN v2／mode4默认镜头支持通用舞台导出；stage13与TestStage保留专用导出器，新格式和新机制按实际内容补齐。

剧情由`core/story_repository.mjs`统一提供，启动只加载索引和共享包，地图包与序章按需读取；四图缓存保护当前和正在准备的地图。`core/story_packages.mjs`管理文本编号、包指纹和紧凑对白校验，`core/story_quests.mjs`从既有世界状态推导任务阶段。能力扩展与性能待办见唯一当前计划。

来源资料、报告位置和缺失处理见[local_materials.md](../local_materials.md)；检查命令见[README.md](tools/README.md)，通用验收方法见[menu_alignment_workflow.md](../assessment/menu_alignment_workflow.md)。
