# 重制目录约定

- 重制代码、提取素材、方案、日志、截图和验证报告统一保存在本 `remake` 目录中。
- 正式游戏位于 `runtime`；当前计划统一维护在 `assessment/validation_design.md`。运行素材与内容位于 `runtime/web/assets` 和 `runtime/web/data`，来源与验收证据位于 `runtime/evidence`。
- 当前实现连接见 `runtime/architecture.md`：`web/app.js` 只组装共享状态与控制器；浏览器流程放 `web/controllers`，规则／事务放 `web/core`，绘制沿用对应视图。当前待办只在工作计划维护；配置说明放 `runtime/config_guide.md`，导出／验证命令放 `runtime/tools/README.md`。
- Phaser运行层放`runtime/web/phaser`：场景在scenes，临时人物显示在actors，可组合姿态／时钟在components，纹理与战斗绘制适配在rendering。复用已有世界／剧情／战斗规则和素材契约，不在Sprite中复制存档状态或另起命中时钟；菜单／对白沿用对应视图。固定运行库及许可在web/vendor/phaser，修改后核对manifest.json。
- `prototype` 只保留实验页面与定向验证，可复用 `runtime` 的正式模块与素材；正式运行及构建不引用实验目录。共享移动模块在 `runtime/web/core/movement.mjs`，解码器在 `runtime/tools/source`，基础导出器在 `runtime/tools`，媒体统一在 `runtime/web/assets`。基础来源清单在 `runtime/web/data/source`，保留其历史来源字节；迁移映射见 `runtime/tools/layout_migration.json`，旧素材／证据用 `migrate_local_materials.py` 核对并复制。历史方案／阶段报告与压缩会话快照归 `archive`，不要把历史限制当作当前进展。
- 明确进行版本交付时使用 `runtime/tools/verify_current.py`，默认 release，汇总同一测试入口并复用输入未变的便携结果，另核对真实运行资源；不自动完成正式浏览器实玩。历史来源、旧工作区与归档复核仅在专项审计使用 `--legacy-audit`；普通任务和区域接入不以旧历史证据齐全为前置。旧日期报告保留原范围，新观察单独记录当时指纹。
- 无原版素材／历史来源材料时，先运行`runtime/tools/verify_phaser.mjs`核对代码和资源引用，用`web/phaser-preview.html`做示意图验证；素材交接加`--assets`并补正式流程实玩。完整来源检查受阻时明确原因，不能把旧current_validation当作Phaser迁移通过记录。
- 已注册导出统一入口是 `runtime/tools/build_runtime.py`，依赖既有基础内容与来源台账。文档维护优先盘点／核对；普通导出保留参数，`--force` 不等于配置 `--reset`。
- 原版游戏输入位于上一级游戏目录，已有独立存档分析位于上一级的 `save_analysis_20261010`。工具应只读这些输入；修改原作程序、资源或存档需有用户对应的任务授权。
- 新增队友和技能必须遵循 `runtime/config_guide.md` 的接入规范：所有已接入技能数值统一登记到 `runtime/web/data/config/skills.json`，以原角色编号＋技能索引绑定；原记录／动作留作核对，只编辑 `parameters`，不得添加队友专用调参文件或按角色／技能名覆盖数值的分支。未实现行为先恢复规则和验证，再登记为可用。
- 移动目录或调整结构时，同步修正提取工具、启动入口和文档引用，并验证素材加载与输入来源。
- 全部道具的配置统一放在 `runtime/web/data/config/items.json` v3，以原道具ID绑定；装备、药品、水晶与材料不另建各自调参文件。`data/items.json` 保留原来源；只在 `parameters` 填写修改项，空对象使用来源默认值，嵌套对象按字段合并、数组整体替换。技能配置同为v3，战斗／奖励为v2；来源指纹按文件集中登记，默认值与生效值用配置导出器`--reference`只读查询。普通导出迁移旧格式、补齐新编号并保留调参；原实例／存档不因调参重写。特殊行为先还原通用处理器再启用，不能把 source-only 字段当作已实现效果。

- 当前指南按职责重写维护，不继续累加逐次修复日志；历史过程放有日期的evidence或archive并建索引。工具导航见runtime/tools/tool_index.json，本地资料与缺失处理见local_materials.md；新增或迁移工具同步其分类、导入关系及引用，构建派生清单用runtime/tools/sync_tool_docs.py生成并以--check核对。清理临时文件先核对引用，保留原路径／SHA与恢复映射；构建日志、原生证据及观察材料不能仅按日期删除。
- 持续维护的说明、设计、计划和操作指南统一使用UTF-8的Markdown（`.md`），命令使用代码块，文档导航使用相对链接；文档迁移同步当前脚本及索引引用。`requirements.txt`等依赖清单、机器输出、原始资料和历史证据保留原格式与原字节。
- 后续区域按“区域全量盘点、按剧情阶段实现、沿连续主线集成验收”推进；任务以“区域＋剧情阶段＋完整事件链”为单位，优先延长正常主线，不要求先完成同一区域全部后期重访与结局。方法与验收口径见 `assessment/region_remake_workflow.md`，阶段范围、外部依赖、暂缓项和完成状态只在 `assessment/validation_design.md` 维护。阶段名不新增运行状态；已登记入口的全部可达分支仍须通过能力检查，不能用当前旗标或开发样本绕过。保留火之谷／白木森林既有成果，开发交接验收与自然贯通分别记录，正常前置接通后补跨区域复验。
- 地图／NPC／对白／任务接入见runtime/story_guide.md。runtime_content.story显式登记独立事件和任务，web/content保存编辑内容，web/data/story由export_story_packages.mjs生成；保留原TLK／ANM来源台账，正式浏览器按地图加载运行包。任务读取既有世界状态，奖励仍在剧情事务中提交，不另存重复进度。
- TLK、测试片段和自行编写的NPC事件统一编译为StoryFlow，通过StoryFlowRunner执行，ChapterRunner提供共同事务与游戏行为适配。不得为炎城或其他区域新增独立剧情VM；旧EventRunner仅为来源核对适配，正式入口不使用native-entry提交。

- 回归统一使用 `runtime/tools/verify_tests.py`，默认 task，按工作区改动和代码依赖选择；用 `--list --explain`预览原因，`--since`指定基线，`--changed`显式登记改动。区域阶段收口使用 `--profile phase --region 区域名`，明确版本交付使用 release，来源／媒体／历史专项使用 audit 或对应职责组；普通任务完成不自动升级为全量交付。`--suite daily`保留运行规则整组兼容入口，完整区域动态遍历归 content-full。成功便携结果仅在代码／结构化数据／环境指纹一致时复用，`--fresh`强制执行；来源、真实媒体、HTTP和历史检查不缓存。先收口构建和自动检查，再做受影响的正式浏览器验收；相关输入未变且本次范围通过即结束，不机械追加 all。新增或迁移测试同步 `runtime/tests/suites.json`并用 `--check`核对。同机制内容扩充数据与共享案例，新机制或高风险边界才增加行为测试；辅助代码放 tests/helpers，不导入 evidence 下执行代码。报告仅由统一入口 --report 写新目录。设计与第一版边界见 `assessment/testing_strategy.md`，命令语义见 `runtime/tools/README.md`。
