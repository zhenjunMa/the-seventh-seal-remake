第七封印重制 · 项目入口
更新：2026-10-22

启动
双击start.cmd或start_runtime.cmd，访问 http://127.0.0.1:8767/ 。
在游戏根目录也可执行：python -B remake/runtime/serve.py
操作与保存说明见runtime/README.txt。
正式入口使用本地Phaser 3.90.0运行库，无需npm安装或CDN。无素材时访问http://127.0.0.1:8767/phaser-preview.html体验示意图探索与战斗；预览不读写正式存档，不代表完整主线或原素材验收。使用serve.py --port自定义端口时，相应替换访问地址。

当前可以体验
本轮迁移接入了Phaser主循环、探索／战斗场景和人物显示；菜单／对白沿用现有实现，规则、配置、存档及素材路径保持原契约。下述已接入内容仍需在素材齐全环境完成迁移后的实玩验收。
正式主线已接入：神殿序章→火之谷邀请凯→住处领取装备与茶→离谷→大地图→白木森林探索、自然遇敌、战斗结算和存读档。
操作菜单支持状态、装备、道具、技巧编成／设定／测试、队列、数值晶石镶嵌和系统设置。组合记录可编辑保存，组合攻击执行仍未恢复。
娃蒂已接入行走、技能、菜单、战斗、成长和保存；从“开发检查→进入三人扩展样本”验证。该样本没有向正式主线添加娃蒂入队剧情。
后续主线、新机制与未覆盖表现的开发顺序只维护在assessment/validation_design.txt。

阅读入口
runtime/README.txt                 启动、操作、保存和开发样本
runtime/architecture.txt           当前模块、状态、事务、资源和扩展位置
runtime/config_guide.txt           内容登记、技能／道具调参、新内容接入步骤
runtime/tools/README.txt           构建、导出、验证及工具分类
assessment/validation_design.txt   唯一当前计划与完成标准
assessment/menu_alignment_workflow.txt  界面与动态表现验收方法
runtime/evidence/README.txt        来源台账、当前检查和历史观察索引
archive/README.txt                归档、整理记录和恢复方式
AGENTS.md                        工作目录与维护约定

目录用途
runtime/web/      正式游戏代码、生成内容、统一配置和运行素材
runtime/web/phaser/  scenes场景、actors人物显示、components组件、rendering纹理／战斗适配
runtime/web/vendor/phaser/  固定运行库、MIT许可和指纹清单
runtime/tools/    当前构建工具、共享解析器、独立提取器及历史复核入口
runtime/tests/    JS与Python回归；web/tests是独立浏览器验证页
runtime/evidence/ 来源证据、构建台账、截图／录屏及验证输出；部分是构建输入
prototype/        正式版仍使用的共享移动模块、角色资源和解码器，以及早期实验
assessment/       当前开发计划与界面／动态表现验收方法
observation/      原版隔离观察副本；用途见其中README.txt
archive/          冻结文档、会话快照与整理前备份

日常入口（游戏根目录）
内容接入：python -B remake/runtime/tools/build_runtime.py --target content --run
只调参数：node remake/runtime/tools/export_runtime_config.mjs
只盘点：python -B remake/runtime/tools/build_runtime.py --target content --validate
无素材代码检查：node remake/runtime/tools/verify_phaser.mjs（分别报告code与assets结果）
素材交接检查：node remake/runtime/tools/verify_phaser.mjs --assets（素材齐全且已有指纹／尺寸匹配才通过）
完整检查：python -B remake/runtime/tools/verify_current.py（8767服务需启动）
仅更新文档或整理目录时核对引用与现有产物，不需要重新导出全部素材。
最近检查的执行时间、测试数量与历史浏览器证据匹配状态见runtime/evidence/current_validation.json。
current_validation.json属于依赖原输入与来源台账的完整检查；缺少这些材料时可能无法生成新报告，不能将旧报告当作Phaser迁移通过。无素材检查先看verify_phaser输出；真实素材验收顺序见assessment/validation_design.txt。

维护边界
所有重制产物保存在remake。上一级原版程序、资源和原存档只读。
当前构建仍读取上一级原资源、save_analysis_20261010及本目录证据；正式服务只暴露runtime/web和/prototype/对应的prototype/web。
不按文件名中的forest、sample、prototype或日期判断文件是否可删除；先核对实际引用。
旧阶段报告保持记录时点的结论。当前指南按职责维护，详细变更经过归档，不在入口中持续追加。
本轮目录整理记录：archive/20261022_before_directory_cleanup/；检查报告：runtime/evidence/organization_20261022/report.json。
