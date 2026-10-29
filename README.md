# The Seventh Seal Remake

《第七封印》重制项目。仓库保存浏览器游戏代码、配置、内容定义、资源导出工具和测试；图片、音乐、影片等媒体由使用者从自己的原版安装中提取。

当前代码使用随仓库提供的 Phaser 3.90.0，包含探索、剧情、战斗、操作菜单和存读档。区域接入范围、自然路线与开发交接验收的区别，以及下一阶段任务，统一见[当前开发计划](remake/assessment/validation_design.md)。

## 本地运行

**首次构建尚未打通。** 干净克隆只有代码和结构化定义；现有构建入口仍依赖部分本地来源台账和历史样本。运行正式游戏需要与当前定义匹配的已生成媒体，准备与缺失处理见[本地资料](remake/local_materials.md)。

从仓库根目录启动（Python 3）：

```console
python3 -B remake/runtime/serve.py
```

Windows 可用 `python -B remake/runtime/serve.py`，或双击 `remake/start.cmd`。访问 <http://127.0.0.1:8767/>；服务将重制存档写入 `remake/saves/`，与原版二进制存档不直接兼容。具体操作以游戏内提示为准。

没有媒体时，可访问 <http://127.0.0.1:8767/phaser-preview.html>，用示意图检查探索、缩放和战斗。预览不读写正式存档，其结果不代表原作画面或主线验收。

代码与运行定义预检查需要 Node.js：

```console
node remake/runtime/tools/verify_phaser.mjs
```

素材齐全时加 `--assets` 核对资源存在性、已声明指纹和尺寸。环境依赖、增量构建和验收命令见[工具说明](remake/runtime/tools/README.md)。

## 文档入口与维护分工

| 要做的事 | 唯一说明入口 |
| --- | --- |
| 查当前范围、待办和验收状态 | [当前开发计划](remake/assessment/validation_design.md) |
| 理解模块、状态、事务和时钟 | [实现架构](remake/runtime/architecture.md) |
| 调整数值，接入角色、技能、怪物 | [配置与内容登记](remake/runtime/config_guide.md) |
| 接入地图、NPC、对白与任务 | [剧情指南](remake/runtime/story_guide.md) |
| 盘点新区、选择阶段、核对交接 | [区域重制方法](remake/assessment/region_remake_workflow.md) |
| 选择检查范围、核对界面和动态表现 | [测试与验收规范](remake/assessment/testing_strategy.md) |
| 构建、导出、排错、旧环境升级 | [工具说明](remake/runtime/tools/README.md) |
| 分析原版存档、背包和装备 | [存档分析工具](remake/runtime/tools/README.md#原版存档分析) |
| 准备媒体、来源证据和恢复旧资料 | [本地资料](remake/local_materials.md) |
| 使用早期演示与定向检查 | [实验目录](remake/prototype/README.md) |
| 修改项目前先读维护约束 | [目录约定](remake/AGENTS.md) |

## 仓库布局

| 路径 | 职责 |
| --- | --- |
| `remake/runtime/web/` | 正式代码、内容登记和生成的运行定义；媒体在被 Git 忽略的 `assets/` |
| `remake/runtime/tools/` | 构建、提取、验证；`source/` 为共享原版资源与存档解析、道具初始化模块 |
| `remake/runtime/tests/` | 自动检查及已提交的辅助代码 |
| `remake/assessment/` | 当前计划、区域方法、测试规范 |
| `remake/prototype/` | 复用正式实现的实验页面，正式游戏不依赖它 |

原版 `GAME.exe`、`Map/`、`Fight_Role/`、`SYSTEM/` 等输入放在仓库根目录，由工具只读访问，不提交。`.gitignore` 同时排除提取媒体、原存档、观察副本、证据、归档和缓存。

文档描述当前职责和操作；详细开发过程留在证据记录中。变更状态只在开发计划维护，其他指南通过链接引用。
