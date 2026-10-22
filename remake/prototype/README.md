# 第七封印：保留的原型与共享依赖

当前游戏入口是 [remake/README.txt](../README.txt)，当前工作计划见 [validation_design.txt](../assessment/validation_design.txt)。本目录用于早期实验和复用资源。

正式版仍使用 `web/movement.mjs`、角色移动图集／清单，以及 `tools/` 中的解码与提取模块。正式服务通过 `/prototype/` 提供这些素材，移动本目录时必须同步更新引用。

正式运行入口已接入 Phaser 3.90.0，新增显示场景与组件位于 `../runtime/web/phaser/`，并继续复用上述依赖。无素材预览为正式服务的 `/phaser-preview.html`；本目录旧演示的验收范围保持原记录。

双击 `../start_prototype.cmd` 或本目录 `start.cmd`，访问 `http://127.0.0.1:8765/` 可查看旧地图／战斗演示。实验保存与正式游戏保存分开。

原型的手工伤害演示、旧战斗范围和未完成项只描述当时实验。完整历史操作与提取命令见 [旧原型说明](../archive/20261011_before_chapter/prototype/README.md)，各阶段报告位于 [历史资料目录](../archive/README.txt)。

`web/assets/` 保存解码后的运行素材，`evidence/` 保存仍用于核对的来源记录，`tools/` 保存提取器与实验检查。会话恢复快照已压缩归档，可按归档说明恢复。
