# RailMind 本地演示

在 [AI 工作流](http://localhost:9222/agents)、[切片管道](http://localhost:9222/agents?canvas_category=dataflow_canvas)、[编译算子](http://localhost:9222/agents?canvas_category=compilation_template_group) 和 [知识库](http://localhost:9222/datasets) 中可以找到下列演示资源。样例采用虚构设备、人员和编号，可直接上传或现场展示。

## 铁路资料复核工作流

| 工作流 | 画布与结果 | 导出键 |
| --- | --- | --- |
| 设备生产许可材料预审 | 先查适用细则再分岔。对象和申请事项明确、且有适用依据时才继续查材料，输出逐项补正清单。 | `license-review` |
| 设备验收证据审计 | 验收依据、检测记录和交接凭证三路并行，汇合查错批。批次冲突单列，其他情况出具证据对照表。 | `acceptance-evidence` |
| 规章修订影响分析 | 旧版、新版分别定位和摘录，汇合比对。输出条款差异及制度、表单、培训改动，区分文本比较和效力核验。 | `revision-impact` |
| 质量整改销项核验 | 问题单关联、独立复验、签认三段逐关推进，证据不足就停止在对应关口。 | `corrective-closeout` |

点击画布的「运行」，可用开始节点里的样例核验实际执行路径。结果是给人工复核的资料草稿，不是审批、验收或销项决定。

## RAG 切片管道

| 管道和对应知识库 | 切片方式 | 本地验证的样例格式 |
| --- | --- | --- |
| 01 通用文档 | 按句段合并，目标 420 tokens，12% 重叠。文本 PDF 用 Naive 文本提取。 | PDF、Markdown、HTML、TXT |
| 02 手册与制度 | 按 Markdown 标题、章／节／条或编号层级归组。 | DOCX、Markdown |
| 03 台账与表格 | 按记录切片，保留列名与对应字段。 | XLSX、CSV |
| 04 FAQ 问答对 | 每对问答存为一片。XLSX 用前两列，TXT 每行用 Tab 隔开问题和答案。 | XLSX、TXT |
| 05 演示文稿 | PPTX 按幻灯片切片，PDF 保留解析块的页码。 | PPTX、PDF |
| 06 扫描件与图片 | DeepDOC OCR，目标 340 tokens，8% 重叠。原件清晰度影响识别质量。 | 扫描 PDF、PNG、JPEG |
| 07 论文与技术报告 | DeepDOC 布局抽取，开启多栏识别，依章节标题切片。 | 双栏 PDF |
| 08 邮件与纪要 | EML 提取发件人、收件人、抄送、日期、主题和正文。正文目标 360 tokens，10% 重叠。 | EML、TXT |

现场演示时，打开 [台账知识库](http://localhost:9222/dataset/files/c6dc1df37ad2425f984958216434ae31)，选择「设备责任表.xlsx」，查看 DEMO-01 的责任人和频次是否落在同一片。上传自己的文件时，先选择对应的知识库。更新管道后，发布新版本，在知识库设置中选中该版本，再重新解析需要更新的文件。

## 编译算子和成果

| 编译算子 | 展示内容 |
| --- | --- |
| 设备与档案关系 | 设备、档案、人员、位置及归档关系，附带证据思维导图。 |
| 手册可定位目录 | 章节目录与摘要树，保留条款编号、层级和原文位置。 |
| 交接决定与行动 | 从邮件与纪要抽取时间、行动、责任人和待确认事项。 |
| 规章知识 Wiki | 按提交、复核、归档和纠正等主题组织知识库级 Wiki。 |

打开 [演示成果 档案证据图谱](http://localhost:9222/dataset/compilation/f1fbad4dd7f24852a21bb2bd1b1a3c4f)，在成果类型中选择图谱或思维导图，再选择「设备与档案关系.md」。其他算子在数据管道的 Compiler 节点选择对应模板组，再把已发布的管道版本绑定到目标知识库。

## 在其他空间复用

- `pipelines/` 存放切片和成果编译管道 JSON。从 **数据管道 → 导入 JSON** 导入，发布后绑定到对应知识库。成果编译管道还要为 Compiler 选择编译模板组和模型。
- `rail-workflows.mjs` 生成工作流 JSON。在仓库根目录运行 `node example/railmind-demo/rail-workflows.mjs license-review > license-review.json`，用表中的导出键选择其他工作流。从 **Agent → 工作流 → 导入 JSON** 导入，再配置目标空间的聊天模型和知识库，保存、试跑后发布。
- `compilation-groups/` 存放四组编译算子的名称、模板组合和提取规则，供在其他空间创建时参考。
- `samples/` 按 01–09 分类存放 20 份样例。当前空间的演示知识库使用 Ollama 的 BGE-M3 向量模型，工作流与编译算子使用账号已配置的 DeepSeek Flash。
