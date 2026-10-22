第七封印重制 · 文档导航
更新：2026-10-22

项目概览、环境准备与素材前置条件见../README.md。
Windows快速启动：双击start.cmd；macOS/Linux与其他启动方式见runtime/README.txt。

阅读入口（相对本目录）
../README.md                         项目介绍、当前范围和环境准备
runtime/README.txt                   启动、操作、保存和开发样本
runtime/architecture.txt             模块、状态、事务和资源边界
runtime/config_guide.txt             内容登记、技能／道具调参与新增内容
runtime/tools/README.txt             构建、导出和验证命令
assessment/validation_design.txt     当前计划、未完成事项和完成标准
assessment/menu_alignment_workflow.txt  界面与动态表现验收方法
prototype/README.md                  原型用途与正式版共享依赖
local_materials.txt                 本地素材、来源证据、历史归档的准备与缺失处理
AGENTS.md                           工作目录与维护约定

维护分工
当前实现关系只在architecture维护，当前任务／验收状态只在validation_design维护；README保留范围摘要和操作入口。
参数与内容接入步骤在config_guide维护，命令选项与执行语义在tools/README维护，通用验收矩阵在menu_alignment_workflow维护。
来源资料的目录、交接和缺失说明在local_materials维护；实际记录仍放本地evidence／archive／observation。
本页只做导航。构建派生清单通过tools/sync_tool_docs.py同步，工具分类与历史恢复信息仍需人工核对。
