# 第七封印重制 · 文档导航

项目概览、环境准备与素材前置条件见[项目说明](../README.md)。Windows 快速启动可双击 `start.cmd`；其他启动方式见[运行与操作](runtime/README.md)。

## 阅读入口

| 文档 | 用途 |
| --- | --- |
| [项目说明](../README.md) | 项目介绍、当前范围和环境准备 |
| [运行与操作](runtime/README.md) | 启动、操作、保存和开发样本 |
| [代码架构](runtime/architecture.md) | 模块、状态、事务和资源边界 |
| [配置与内容扩展](runtime/config_guide.md) | 内容登记、技能／道具调参与新增内容 |
| [地图、NPC、对白与任务](runtime/story_guide.md) | 剧情编写、阶段合同与运行包接入 |
| [构建、导出与验证工具](runtime/tools/README.md) | 构建、导出和验证命令 |
| [当前开发计划](assessment/validation_design.md) | 当前范围、未完成事项和完成标准 |
| [界面和动态表现验收方法](assessment/menu_alignment_workflow.md) | 通用检查矩阵与证据要求 |
| [全区域重制工作方法](assessment/region_remake_workflow.md) | 区域全量盘点、按剧情阶段实现、连续主线验收与来源经验 |
| [测试体系设计方案](assessment/testing_strategy.md) | 测试分层、任务范围、Phaser 验收与现有测试迁移 |
| [实验目录说明](prototype/README.md) | 实验入口与正式模块复用 |
| [本地素材、证据与历史资料](local_materials.md) | 本地资料的准备、交接与缺失处理 |
| [目录维护约定](AGENTS.md) | 工作目录与维护规则 |

## 按任务阅读

- **运行游戏**：从[项目说明](../README.md)确认素材前置条件，再看[运行与操作](runtime/README.md)。
- **旧环境升级**：先看[旧环境升级步骤](runtime/tools/README.md#旧环境升级)，再按[本地资料说明](local_materials.md)准备媒体与来源证据。
- **扩充地图／剧情**：先看[区域工作方法](assessment/region_remake_workflow.md)全量盘点区域与外部依赖，在[开发计划](assessment/validation_design.md)选择承接连续主线的阶段和完整事件链，按[剧情指南](runtime/story_guide.md)和[配置指南](runtime/config_guide.md)接入，再按[工具说明](runtime/tools/README.md)构建；不要求先穷尽同一区域的所有后期内容。
- **核对完成情况**：以[当前开发计划](assessment/validation_design.md)的范围、待办与验收标准为准。

## 维护分工

| 内容 | 维护位置 |
| --- | --- |
| 当前实现关系 | [architecture.md](runtime/architecture.md) |
| 当前任务与验收状态 | [validation_design.md](assessment/validation_design.md) |
| 参数与内容接入步骤 | [config_guide.md](runtime/config_guide.md) |
| 地图、NPC、对白与任务编写 | [story_guide.md](runtime/story_guide.md) |
| 命令选项与执行语义 | [tools/README.md](runtime/tools/README.md) |
| 通用验收矩阵 | [menu_alignment_workflow.md](assessment/menu_alignment_workflow.md) |
| 本地资料目录、交接与缺失处理 | [local_materials.md](local_materials.md) |

README 保留范围摘要和操作入口，本页维护导航。实际过程记录放在本地 `evidence`、`archive` 或 `observation` 中。构建派生清单通过 `runtime/tools/sync_tool_docs.py` 同步；工具分类与历史恢复信息仍需人工核对。

## 文档格式约定

- 持续维护的说明、设计、计划和操作指南统一使用 UTF-8 的 `.md` 文件，标题、列表、命令代码块与相对链接采用 Markdown 语法。
- `requirements.txt` 等约定格式的依赖清单，以及机器输出、原始资料和历史证据，保留原格式与原字节。
- 文档重命名或迁移时，同步更新文档、AGENTS、脚本及结构化索引中的当前引用；历史路径和恢复映射保留原义。
