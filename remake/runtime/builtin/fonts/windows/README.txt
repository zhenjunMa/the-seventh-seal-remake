Windows GDI 对照字库

menu、dialogue、prologue 子目录与默认 Noto 字库的字号配置和字符逐一对应。
来源参数及实际字体解析结果记录在 web/data/*_fonts_windows.json。
全真特黑體、Benguiat Bk BT 在本机未安装，GDI 实际解析为宋体。
这些图片不适用上级目录的 Noto SIL Open Font License。
微软的 Windows 字体许可不自动授予将逐字位图字库随游戏分发的权利。
https://learn.microsoft.com/en-us/typography/fonts/font-faq#document-embedding

重新生成：
python -B remake/runtime/tools/export_windows_fonts.py --original-dir "原版安装目录"
