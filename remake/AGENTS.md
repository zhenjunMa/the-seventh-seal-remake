# 项目维护约定

- 所有交互使用中文；不使用 `ruff check` 格式化代码；专注功能，不随意增加单测。
- 项目说明统一维护在[根 README](../README.md)，以当前实现和实际试玩结果为准。
- 正式游戏、工具和检查在 `runtime`；`prototype` 复用正式模块，正式运行及构建不依赖实验目录。
- 原版程序、资源和存档只读；观察原版使用隔离副本。玩家存档不得被检查或实验覆盖。
- `web/app.js` 负责装配，流程在 `web/controllers/`，规则与事务在 `web/core/`，显示在视图和 `web/phaser/`；画面对象不持有可保存进度。
- 内容登记统一在 `runtime/web/data/runtime_content.json`；调参统一在 `web/data/config/`，只修改 `parameters`，按原编号绑定。
- 原版剧情与独立事件统一使用 StoryFlow；任务读取既有世界状态，奖励在剧情事务中提交。
- 构建使用 `runtime/tools/build_runtime.py`，普通导出保留自定义参数；来源字节和指纹不手改。
- 工具增删同步 `runtime/tools/tool_index.json`，派生字段由 `runtime/tools/sync_tool_index.py` 更新；现有检查用 `runtime/tools/verify_tests.py` 按改动范围执行，先用 `--list --explain` 确认范围，通过后不机械扩大检查。
