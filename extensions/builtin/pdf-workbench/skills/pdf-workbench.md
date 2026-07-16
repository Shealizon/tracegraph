# PDF Workbench

先判断任务关注文字内容、页面结构还是视觉版面，再选择最小工具集合。

- 少量页阅读使用 `pdf_extract_text`；长文档先用 `pdf_parse`，再用 `pdf_search`。
- 表格、公式、图片、双栏和疑似扫描页必须用 `pdf_render` 核对。
- `low_text_pages` 表示文字层不足；这不是 OCR 结果，应改用 `paddle_ocr`。
- 所有引用使用文件名和 1-based 页码，不编造定理、公式或章节编号。
- 修改 PDF 时不要覆盖原文件。生成后用 `pdf_render` 检查受影响页面。
- 合并、抽页、旋转、拆分、删页、插页、图片叠加和水印使用对应确定性工具。
- 简单文本 PDF 可用 `pdf_create_text`；复杂排版需要专门生成并逐页验收。
