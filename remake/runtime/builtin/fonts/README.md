# 内置位图字库

此目录保存重制版固定版本的菜单、对白和字幕字形图集。对应字形坐标、字宽、基线与 PNG SHA-256 在 `web/data/menu_fonts.json`、`dialogue_fonts.json`、`prologue_fonts.json` 中维护。

首次素材构建只核验并复制这些字节，不运行 GDI、FreeType 或操作系统字体解析器。新增文字时先更新字形图集与对应定义，再一起提交。

当前字形来自此前生成的 Noto Serif CJK SC／Noto Sans CJK SC 替代字库，保留现有原生布局参数；不是从原版程序截图提取的 GDI 字形。菜单成品及配套指标经 `fonts_runtime_20261105/before` 的 SHA 核对，另两套成品与 `cross_platform_fonts_20261105/preview` 指标核对后固化。历史目录只记录开发出处，不是构建输入。

字体来源、固定上游版本和源文件 SHA 保留在各字形定义的 `font_source` 中。许可证见本目录的 `LICENSE.txt`。

追加中文宽字符可使用离线维护工具 `tools/append_builtin_glyphs.py`。先取得定义中完全相同 SHA 的字体文件，按 `font_source.file` 命名放在同一目录，再显式选择需要补字的 profile。例如：

```bash
python remake/runtime/tools/append_builtin_glyphs.py --manifest menu --font-directory /path/to/fixed-fonts --keys simsun19_text --characters 赌 --evidence menu_glyph_append_new.json
```

工具核对字体 SHA、FreeType 版本和已有字形像素，仅在图集底部追加整行，保留所有旧像素、坐标、字宽及基线；定义与内置 PNG 一起更新。它不参与正常素材构建，也不调用系统字体。修改后用正式构建入口复制内置图集到素材目录。
