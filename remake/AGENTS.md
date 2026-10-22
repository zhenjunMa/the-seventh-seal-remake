# 重制目录约定

- 重制代码、提取素材、方案、日志、截图和验证报告统一保存在本 `remake` 目录中。
- 正式游戏位于 `runtime`；当前计划统一维护在 `assessment/validation_design.txt`。运行素材与内容位于 `runtime/web/assets` 和 `runtime/web/data`，来源与验收证据位于 `runtime/evidence`。
- 当前实现连接见 `runtime/architecture.txt`：`web/app.js` 只组装共享状态与控制器；浏览器流程放 `web/controllers`，规则／事务放 `web/core`，绘制沿用对应视图。当前待办只在工作计划维护；配置说明放 `runtime/config_guide.txt`，导出／验证命令放 `runtime/tools/README.txt`。
- `prototype` 保留实验、共享移动模块／角色素材和提取器，正式版仍依赖该目录。历史方案／阶段报告与压缩会话快照归 `archive`，不要把历史限制当作当前进展。
- 日常验证使用 `runtime/tools/verify_current.py`，写当前检查结果；旧日期报告只保留对应阶段，不再累加当前结论。该工具核对已有浏览器证据，不重新操作浏览器；新观察需单独记录范围与当时指纹。
- 已注册导出统一入口是 `runtime/tools/build_runtime.py`，依赖既有基础内容与来源台账。文档维护优先盘点／核对；普通导出保留参数，`--force` 不等于配置 `--reset`。
- 原版游戏输入位于上一级游戏目录，已有独立存档分析位于上一级的 `save_analysis_20261010`。工具应只读这些输入；修改原作程序、资源或存档需有用户对应的任务授权。
- 新增队友和技能必须遵循 `runtime/config_guide.txt` 的接入规范：所有已接入技能数值统一登记到 `runtime/web/data/config/skills.json`，以原角色编号＋技能索引绑定；原记录／动作留作核对，只编辑 `parameters`，不得添加队友专用调参文件或按角色／技能名覆盖数值的分支。未实现行为先恢复规则和验证，再登记为可用。
- 移动目录或调整结构时，同步修正提取工具、启动入口和文档引用，并验证素材加载与输入来源。
- 全部道具的配置统一放在 `runtime/web/data/config/items.json` v2，以原道具ID绑定；装备、药品、水晶与材料不另建各自调参文件。`data/items.json` 保留原来源；只编辑 `parameters`，原实例／存档不因调参重写。特殊行为先还原通用处理器再启用，不能把 source-only 字段当作已实现效果。

- 当前指南按职责重写维护，不继续累加逐次修复日志；历史过程放有日期的evidence或archive并建索引。工具导航见runtime/tools/tool_index.json，证据导航见runtime/evidence/README.txt；新增或迁移工具同步其分类及引用。清理临时文件先核对引用，保留原路径／SHA与恢复映射；构建日志、原生证据及观察材料不能仅按日期删除。
