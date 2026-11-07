# The Seventh Seal Remake

《第七封印》重制项目。仓库保存浏览器游戏代码、接入配置、自定义参数、结构配方、内置位图字库和工具；原作文本、原始记录、大型运行数据及图片、音乐、影片由使用者从自己的原版安装中提取生成。

当前代码使用随仓库提供的 Phaser 3.90.0 和 WebGL 渲染，包含探索、剧情、战斗、操作菜单和存读档。已接入范围、剩余支线、工程待办与验收边界，统一见[当前开发计划](remake/assessment/validation_design.md)。

## 本地运行

首次准备需要 Python 3.12 或更新版本、Node.js、FFmpeg 和 FFprobe。从仓库根目录安装固定 Python 依赖，然后指定完整原版安装目录：

```console
python3 -m venv .venv
.venv/bin/python -m pip install -r remake/runtime/requirements.txt
.venv/bin/python -B remake/runtime/tools/build_runtime.py --target media --original-dir "/path/to/DiQiFengYin" --run --serve
```

首次构建先按结构配方从原版还原文本、原始记录和运行表，再生成媒体及素材清单；不依赖历史台账、观察存档或 Windows GDI。自定义的 `web/data/config/` 和接入配置保持原值，技能优化在原版默认值之上继续生效。默认先按已提交的 `media_inputs.json` 核对原版来源，缺失、内容变化或多出素材都会拒绝导出。`--ignore-fingerprint` 可放行整体来源清单差异，但运行数据实际引用的原字节及重建结果仍须与配方一致。已完成且通过指纹核验的输出会复用。构建完成后在 <http://127.0.0.1:8767/> 开玩。

仅准备文本和运行数据、不提取图片音视频时，使用同一命令并将目标改为 `--target data`。不加 `--run` 只读检查并列计划；正常启动仍须完成完整素材构建。

维护者确认一份完整原版可作为新基准后，可单独执行以下命令。它只更新来源指纹清单，不导出素材或重生成规则，不能与 `--run` 同用：

```console
.venv/bin/python -B remake/runtime/tools/build_runtime.py --original-dir "/path/to/DiQiFengYin" --write-reference
```

后续启动无需再次提供原版目录：

```console
.venv/bin/python -B remake/runtime/serve.py
```

Windows 将 `.venv/bin/python` 换成 `.venv\Scripts\python.exe`；已有媒体时也可双击 `remake/start.cmd`。存档目录仍为 `remake/saves/`，普通档使用原版 `SaveGame0.Dat`～`SaveGame19.Dat`，快速档使用 `Game.SAV`。可读取原版普通档与快速档，保存也使用原版二进制格式；JSON存档不再读取。具体操作以游戏内提示为准。

没有媒体时，可访问 <http://127.0.0.1:8767/phaser-preview.html>，用示意图检查探索、缩放和战斗。预览不读写正式存档，其结果不代表原作画面或主线验收。

完成数据提取后，代码与运行定义预检查需要 Node.js；该检查不要求已有图片音视频：

```console
node remake/runtime/tools/verify_phaser.mjs
```

素材齐全时加 `--assets` 核对资源存在性、已声明指纹和尺寸。环境依赖、增量构建和验收命令见[工具说明](remake/runtime/tools/README.md)。

## 文档入口与维护分工

| 要做的事 | 唯一说明入口 |
| --- | --- |
| 查已接入范围、剩余支线与验收边界 | [当前开发计划](remake/assessment/validation_design.md) |
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
| `remake/runtime/web/` | 正式代码、内容登记、自定义配置；生成的运行数据和 `assets/` 媒体不提交 |
| `remake/runtime/tools/` | 构建、提取、验证；`source/` 为共享原版资源与存档解析、道具初始化模块 |
| `remake/runtime/tests/` | 自动检查及已提交的辅助代码 |
| `remake/assessment/` | 当前计划、区域方法、测试规范 |
| `remake/prototype/` | 复用正式实现的实验页面，正式游戏不依赖它 |

原版 `GAME.exe`、`Map/`、`Fight_Role/`、`SYSTEM/` 等保持原安装目录结构，通过 `--original-dir` 只读访问，不提交。`tools/data_recipes/` 保存已核实结构的共享节点与原文件范围引用，不内嵌原版文案或原文件；首次构建还原既有数据路径和文件格式。开发接入变更后须核验并同步配方，见[工具说明](remake/runtime/tools/README.md#运行数据与结构配方)。旧开发导出器仍沿用其根目录输入约定。`.gitignore` 排除生成数据、提取媒体、观察副本、证据、归档和缓存；`config/`、接入声明、独立事件、基础来源清单、内置字库及 `remake/saves/` 中的玩家存档继续纳入 Git。

只查进度时先读开发计划；修改功能时再按上表查对应指南。工具说明含自动生成的目标与依赖表，无需作为进度文档通读。变更状态只在开发计划维护，详细开发过程留在证据与Git历史中。

## 许可证与原作权利

本项目新增且有权授权的代码、工具和文档采用 [MIT License](LICENSE)。

原版《第七封印》的程序、图片、音乐、视频、剧情对白及其他原作内容，以及相关商标和标识，其权利归各自权利人所有，不在本项目的 MIT 授权范围内。本项目不分发原版游戏程序和媒体素材；运行所需原版资源须由使用者从合法取得的游戏副本中自行准备。

第三方组件遵循各自许可证，使用和分发时须保留相应的版权及许可声明。Phaser 使用其[独立的 MIT 许可证](remake/runtime/web/vendor/phaser/LICENSE.md)，Noto 替代位图字库的来源及许可见[字库说明](remake/runtime/builtin/fonts/README.md)。

本项目为非官方重制项目，不代表原作权利人，也不表示获得其背书。
