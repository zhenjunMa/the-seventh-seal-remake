# The Seventh Seal Remake

《第七封印》重制项目。仓库保存游戏代码、可编辑配置、运行定义、资源导出工具和测试。音乐、图片、动画贴图等素材由使用者从自己的原版游戏文件中提取。

## 当前状态

已接入序章、火之谷至白木森林的初期主线，以及战斗、操作菜单、成长和存读档。娃蒂作为第三名队友接入开发样本；正式主线的入队剧情尚未添加。

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
python -B remake/runtime/serve.py
```

访问 <http://127.0.0.1:8767/>。仅启动静态服务不能补齐缺失素材。

开发依赖包括 Python、Node.js、Pillow；部分媒体工具还需要 FFmpeg，GDI 字体导出需要 Windows。完整的统一依赖安装和首次导出命令仍需补齐，不承诺所有原版发行版本都适用。

## 配置与开发文档

- [项目入口](remake/README.txt)
- [运行与操作说明](remake/runtime/README.txt)
- [代码架构](remake/runtime/architecture.txt)
- [配置与内容扩展](remake/runtime/config_guide.txt)
- [导出与验证工具](remake/runtime/tools/README.txt)
- [当前计划](remake/assessment/validation_design.txt)

技能、道具、战斗和奖励数值统一维护在 `remake/runtime/web/data/config/`。修改 `parameters`，保留 `original` 和 `source` 核对字段。当前 `original` 模式要求原版参数一致，应用修改使用 `debug` 模式；普通导出保留已有参数，显式重置才恢复原值。

现有详细文档中的 `evidence/`、`archive/` 和 `observation/` 引用指向本地开发材料，不属于公开仓库内容。完整验证工具也依赖这些材料；历史验收结果不能视为干净克隆的构建验证。
