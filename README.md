# The Seventh Seal Remake

《第七封印》重制项目。仓库保存游戏代码、可编辑配置、运行定义、资源导出工具和测试。音乐、图片、动画贴图等素材由使用者从自己的原版游戏文件中提取。

## 当前状态

当前代码已接入序章、火之谷至白木森林的初期主线，以及战斗、操作菜单、成长和存读档。娃蒂作为第三名队友接入开发样本；正式主线的入队剧情尚未添加。

正式入口已接入 Phaser 3.90.0：主循环、探索场景、人物显示和战斗绘制使用 Phaser，已有规则、配置、存档、素材路径及菜单／对白保持原有契约。运行库随代码提供，无需 npm 安装或 CDN。本版真实素材下的完整流程仍待验收；当前任务与完成标准统一维护在[开发计划](remake/assessment/validation_design.txt)。

**当前发布的是代码与配置基线。干净克隆后，仅凭原版文件生成全部素材的首次构建流程尚未打通。** 现有导出入口用于增量构建，部分步骤仍依赖本地来源台账、原生验证记录和历史样本；这些记录和样本不在仓库中。首次构建准备完成前，运行游戏需要本地已生成的资源，不能直接把克隆仓库视为完整可运行安装包。

## 仓库内容

- `remake/runtime/web/`：正式版浏览器代码、地图与剧情定义，以及技能、道具、人物、怪物和战斗配置。
- `remake/runtime/tools/`：内容构建、素材提取和验证工具。
- `remake/runtime/tests/`：自动测试；部分集成测试依赖未随仓库提供的原版文件和本地证据。
- `remake/prototype/`：正式版仍使用的共享移动模块、解码器及早期实验代码。
- `remake/assessment/`：当前开发计划和验收方法。
- `save_analysis_20261010/`：导出器仍引用的四个共享 Python 解析模块，只提交代码。

`.gitignore` 排除原版程序与资源、提取素材、存档、观察副本、证据报告、历史备份和缓存。`runtime/web/data/` 中的 JSON 是运行定义或结构化资源描述，随代码提交；媒体文件本身不提交。

## 本地目录与运行

当前工具仍按以下布局读取原版文件：

```text
the-seventh-seal-remake/
  GAME.exe                  # 使用者本地提供，不提交
  Map/                      # 使用者本地提供，不提交
  Fight_Role/               # 使用者本地提供，不提交
  SYSTEM/                   # 以及工具需要的其他原版目录，不提交
  remake/                   # 仓库内容
  save_analysis_20261010/    # 共享解析代码；本地样本不提交
```

已有完整本地生成资源时，从仓库根目录启动：

```console
python3 -B remake/runtime/serve.py
```

以上命令适用于 macOS/Linux。Windows 可用 `python -B remake/runtime/serve.py`，或双击 `remake/start.cmd`；所选命令需指向 Python 3。

访问 <http://127.0.0.1:8767/>。本地服务同时读写 `remake/saves/` 下的普通档和快速档；仅启动服务不能补齐缺失素材。

没有媒体素材时，可访问 <http://127.0.0.1:8767/phaser-preview.html>：使用程序生成的示意图体验探索、缩放和基于现有规则的战斗，不读取或覆盖正式存档。该页面不代表原素材表现或完整主线验收。

代码与资源预检查：`node remake/runtime/tools/verify_phaser.mjs`。素材持有者使用 `node remake/runtime/tools/verify_phaser.mjs --assets` 核对资源是否齐全及已有指纹／尺寸。检查通过后仍需实际验证剧情、战斗和存读档。

运行静态服务需要 Python 3；代码预检查需要 Node.js。构建工具另外使用 Pillow、NumPy、FFmpeg/FFprobe，GDI 字体导出需要 Windows；具体前置条件与命令见[工具说明](remake/runtime/tools/README.txt)。统一依赖安装和首次构建仍是未完成任务，不能把增量构建命令当作首次安装流程。

## 配置与开发文档

- [重制文档导航](remake/README.txt)
- [运行与操作说明](remake/runtime/README.txt)
- [代码架构](remake/runtime/architecture.txt)
- [配置与内容扩展](remake/runtime/config_guide.txt)
- [导出与验证工具](remake/runtime/tools/README.txt)
- [当前计划](remake/assessment/validation_design.txt)
- [界面与动态表现验收方法](remake/assessment/menu_alignment_workflow.txt)
- [本地素材、证据与历史资料](remake/local_materials.txt)

技能、道具、战斗和奖励数值统一维护在 `remake/runtime/web/data/config/`。只在 `parameters` 填写修改项，空对象沿用来源默认值；文件级 `source_hashes` 和身份字段只读。默认值及生效值可用 `node remake/runtime/tools/export_runtime_config.mjs --reference skills yantu` 查询。`original` 模式要求原版参数一致，应用修改使用 `debug` 模式；普通导出迁移旧格式、补齐新增内容并保留调参，显式重置才恢复原值。

素材、来源台账和历史观察的用途、交接方式与缺失处理统一见[本地资料说明](remake/local_materials.txt)。历史报告只说明对应阶段的验收范围，不代表当前 Phaser 版或干净克隆的构建已通过。
