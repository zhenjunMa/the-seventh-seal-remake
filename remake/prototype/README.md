# 第七封印：实验与定向验证

本目录保留早期地图／素材／战斗演示及定向检查。正式游戏和内容构建位于 `../runtime/`，不依赖本目录；当前开发计划见 [validation_design.md](../assessment/validation_design.md)。

从仓库根目录执行 `python3 -B remake/prototype/serve.py`，访问 `http://127.0.0.1:8765/`。Windows可双击 `../start_prototype.cmd` 或本目录 `start.cmd`。实验保存与正式游戏保存分开，实验服务不提供正式存档写接口。

实验服务只读复用正式资源：`/runtime/` 映射 `../runtime/web`，`/assets/` 映射正式素材；旧演示所需的三个清单URL映射到 `../runtime/web/data/source/`。移动实现复用 `../runtime/web/core/movement.mjs`，Python检查复用 `../runtime/tools/source` 的解码器及正式导出器，不维护第二份实现。

旧 `web/assets` 和 `evidence` 的本地材料用 [migrate_local_materials.py](../runtime/tools/migrate_local_materials.py) 盘点，加 `--run` 复制；命令保留旧文件和原SHA，遇到目标冲突拒绝覆盖。迁移映射见 [layout_migration.json](../runtime/tools/layout_migration.json)。本目录的 `web/combat_observations.json` 继续保存实验观察。

新增正式地图、剧情和数值配置按 [内容指南](../runtime/config_guide.md) 与 [构建工具说明](../runtime/tools/README.md) 维护。无素材预览使用正式服务的 `/phaser-preview.html`；旧实验的限制只描述当时范围，不代表当前正式游戏进度。来源证据和历史资料见 [本地资料说明](../local_materials.md)。
