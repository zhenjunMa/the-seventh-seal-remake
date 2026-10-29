# 重制目录约定

- 所有交互使用中文；不使用 `ruff check` 格式化代码；只为必要的新机制或高风险边界补行为检查，不随意增加单测。
- 重制输出统一留在本目录。正式游戏、工具和测试在 `runtime`；`prototype` 只做实验并复用正式模块，正式运行及构建不依赖实验目录。
- 原版程序、资源和存档只读；修改它们须有用户对应授权。原版操作使用 `observation` 中的隔离副本。
- `web/app.js` 只组装共享状态和控制器；流程放 `web/controllers`，规则和事务放 `web/core`，显示放对应视图及 `web/phaser`。Sprite 不持有可保存进度，也不另起伤害时钟。详见[架构](runtime/architecture.md)。
- 接入选择统一在 `runtime/web/data/runtime_content.json`；技能、道具、战斗和奖励调参统一在 `data/config/`，只编辑 `parameters`，按原编号绑定。不得另建区域或角色专用数值覆盖。格式及迁移见[配置指南](runtime/config_guide.md)。
- TLK 与自编事件统一编译为 StoryFlow，由同一个执行器运行；任务读取既有世界状态，奖励在剧情事务中提交。不得新增区域专用剧情 VM。接入步骤见[剧情指南](runtime/story_guide.md)。
- 新区域先全量盘点，再按“区域＋剧情阶段＋完整事件链”延长正常主线。阶段名不新增运行状态；已登记入口的全部可达分支必须通过能力检查，不能按当前旗标绕过。开发交接和自然贯通分别记录；既有后期成果继续保留。详见[区域方法](assessment/region_remake_workflow.md)。
- 构建统一使用 `runtime/tools/build_runtime.py`；普通导出保留调参，`--force` 不等于配置 `--reset`。原来源字节、指纹和历史清单不手改；正式媒体统一在 `runtime/web/assets`，解码器在 `runtime/tools/source`。
- 回归统一使用 `runtime/tools/verify_tests.py`，默认 task；阶段收口用 phase，明确版本交付用 release，来源与历史专项用 audit。先用 `--list --explain` 确认范围，输入未变且本次范围通过即结束，不机械追加 all。页面变化补受影响正式浏览器验收。详见[测试规范](assessment/testing_strategy.md)和[命令说明](runtime/tools/README.md#测试职责与运行)。
- 新增或迁移工具同步 `runtime/tools/tool_index.json`，构建派生清单用 `sync_tool_docs.py` 同步；测试同步 `runtime/tests/suites.json`。辅助执行代码放已提交目录，不导入 `evidence` 下代码。缺原输入或媒体时如实报告边界，可先做代码预检查和示意图验证。
- 当前范围、待办和验收状态只在[开发计划](assessment/validation_design.md)维护；指南按职责更新，不追加逐次修复日志。证据和归档保留原日期、原字节及来源，不能仅按日期删除；本地材料与恢复方式见[本地资料](local_materials.md)。
- 长期文档使用 UTF-8 Markdown、相对链接和命令代码块。移动或删除文件时同步启动入口、脚本和索引引用；被替代文档登记原路径、SHA、替代入口及 Git 恢复版本。项目导航只维护在[根 README](../README.md)。
