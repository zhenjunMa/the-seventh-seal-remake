# 第七封印 · 实验与定向验证

本目录保留早期地图／素材／战斗演示与定向检查，复用正式runtime的模块、媒体及解析器。正式游戏和构建不依赖本目录；项目入口见[根README](../../README.md)。

```console
python3 -B remake/prototype/serve.py
```

访问<http://127.0.0.1:8765/>；Windows可双击remake/start_prototype.cmd或本目录start.cmd。实验服务不提供正式存档写接口，`/runtime/`映射正式web，`/assets/`映射正式媒体，旧清单URL映射正式data/source。

移动复用runtime/web/core/movement.mjs，Python检查复用runtime/tools/source与正式导出器。旧媒体／证据按[旧环境升级](../runtime/tools/README.md#旧环境升级)迁移，保留原字节和SHA；web/combat_observations.json继续保存实验观察。

新内容按[配置](../runtime/config_guide.md)及[剧情指南](../runtime/story_guide.md)接入。无素材预览使用正式服务的/phaser-preview.html；实验限制不代表当前游戏进度，具体范围见[开发计划](../assessment/validation_design.md)。
