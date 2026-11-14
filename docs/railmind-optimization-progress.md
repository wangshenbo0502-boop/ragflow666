# RailMind 优化进度

记录日期：2026 年 11 月 14 日。
参考规划：`railmind-upgrade-proposal.zh-CN.md`。
本轮范围：核对运行基线，实施 R02“统一铁路问答创建入口”。

## 发布版本

目标仓库：`wangshenbo0502-boop/ragflow666`。
在独立目录 `D:\railmind-publish` 中，以 GitHub main 的 `b8a706eac3ca2dfed0acc75e6477ff4df1a172e5` 为基础移植本轮 R02，发布工作分支为 `codex/railmind-r02-20261114`。
本次没有上传原开发目录尚未完成的上游合并，也没有包含个人材料、本地环境配置、依赖下载包或构建产物。

上传版本通过同样的 35 项前端测试、生产构建，以及本轮 7 个前端文件的 `oxfmt --check` 和 `oxlint` 检查。
全仓 TypeScript 检查未通过，有 197 条诊断，未涉及本轮修改文件；没有据此认定全部是历史问题。
使用接口测试数据完成 Chrome 桌面 1440×900 和手机 390×844 的入口检查，确认两处新建入口均打开工作台，问题框在滚动结束后可见且聚焦，返回回到列表，无横向溢出或脚本异常；截图已核对。
浏览器检查发现实际缺少 `/home` 路由，已在发布目录和原开发目录补齐，根路径继续使用同一工作台实现。
Go 包级测试仍因缺少可用 Bash 无法启动，未执行后端格式化、编译或真实模型验收。
预览地址为 `http://localhost:9223/`，只在本机运行，无后端时登录、资料及模型调用不可用。

发布基线没有列表专用的 `use-create-chat.ts`，无需删除该文件；也没有移植开发目录进入本轮前已有的推理选项调整。
知识库的 `dataset_ids` 和 `kb_ids` 两种请求字段均通过已有权限校验。
下文保留原开发工作区的核对记录，不能与本次发布版本的验证结果混用。

## 状态

| 项目 | 状态 | 依据与限制 |
| --- | --- | --- |
| R01-A 现状核对 | 已核对 | 已检查当前分支、冲突状态、前端测试与构建、后端构建环境 |
| R01-B 可复现运行版本 | 未完成 | 28 个未合并路径仍在；Docker 引擎与 Linux 构建环境不可用 |
| R02 统一创建入口 | 已实现，待后端和真实链路验收 | 前端测试和生产构建通过；新增 Go 测试尚未运行 |
| 后续 R03～R14 | 未实施 | 本轮未扩展到设置、助手复用、资料版本或性能改造 |

工作区分支为 `codex/upgrade-v1.0.0`，核对时 HEAD 为 `680f6668`。
原开发目录保留了进入本轮前已有的修改和未合并索引，没有在该目录暂存、提交或重写历史。
本轮涉及的列表页和卡片也在已有未合并路径中；工作区文件可构建，不代表索引合并已经完成。

## 本轮改动

1. 列表页顶部与空列表中的“新建铁路问答”统一进入 `/home#rail-workspace`，复用工作台的场景、知识库及默认模型配置。
2. `/chats?isCreate=true` 也进入相同区域，以替换历史记录的方式避免返回时再次触发创建跳转。
3. 工作台识别创建区域的地址定位并聚焦问题输入框；保留重复点击保护，失败后允许重试。
4. 删除列表页专用的通用创建弹窗调用和 `use-create-chat.ts`。通用聊天服务仍由其他功能使用。
5. 卡片只按保存的 `domain` 和 `railway_scene` 分类。名称、未知场景与对象原型属性不能激活铁路分类。
6. Go 创建服务增加铁路场景、租户模型引用、知识库绑定和资料就绪校验。已有知识库权限、存在性和片段校验继续由共享创建流程处理。
7. 资料就绪查询复用文档列表的最新解析任务判断，并要求文件关联仍存在、文档有片段；只查询最多一个匹配文档 ID。
8. 更新用户手册第 10.3 节，说明统一入口、失败重试与“预填后由用户发送”的行为。

主要文件：

- `web/src/pages/next-chats/index.tsx`
- `web/src/pages/next-chats/chat-card.tsx`
- `web/src/pages/home/index.tsx`
- `web/src/pages/next-chats/index.test.tsx`
- `web/src/pages/next-chats/chat-card.test.tsx`
- `web/src/pages/home/use-railway-workbench.test.tsx`
- `internal/service/chat.go`
- `internal/service/railway_chat.go`
- `internal/service/railway_chat_creation_test.go`
- `internal/dao/document.go`
- `internal/dao/document_readiness_test.go`
- `docs/railmind-user-manual.zh-CN.md`

`railway_chat.go` 中进入本轮前已有的推理选项调整予以保留，不计为本轮成果。

## 验证记录

前端测试在 `web/` 下执行：

```powershell
npm run test -- --runInBand --coverage=false --runTestsByPath src/pages/next-chats/index.test.tsx src/pages/next-chats/chat-card.test.tsx src/pages/home/use-railway-workbench.test.tsx src/services/railway-service.test.ts src/pages/next-chats/chat/chat-box/single-chat-box.test.tsx
```

结果：5 个测试文件、35 项测试全部通过。修改前相关服务和工作台测试为 17 项通过。
覆盖入口、返回导航、查询参数跳转、防重复提交、未就绪禁用、失败保留输入并重试、空问题、保存配置对应的请求以及卡片分类。
这些测试使用模拟接口或依赖，不能代替真实后端落库与问答验收。

原开发工作区对补齐路由前的 6 个前端文件运行 `oxfmt --check` 和 `oxlint`，均通过；发布目录包含路由的 7 个文件均已检查通过。
`npm run build` 通过；仍有既有大包、PDF 依赖使用 eval 和 Tailwind 插件提示，本轮没有调整打包策略。
`npm run type-check` 未通过：仍有修改前已有的 46 条诊断，涉及动态表单、工作流、模型设置等路径；最终输出没有本轮修改文件的诊断。

后端尝试执行：

```bash
bash build.sh --test ./internal/service/... ./internal/dao/...
```

命令在进入构建脚本前失败：

```text
WSL ... execvpe(/bin/bash) failed: No such file or directory
```

本机未找到可用的 Go/gofmt，WSL 仅有 Docker 发行版且没有可用 `/bin/bash`，Docker 无法连接 Linux 引擎。
未绕过 `build.sh` 的原生依赖要求；未执行后端编译、Go 测试或二进制启动检查。

新增 Go 测试使用真实内存 SQLite，覆盖四个场景的创建后回读、无效配置不得保存、普通助手不受铁路校验影响，以及最新解析状态和文件删除的判断。
这些测试已写入代码，执行结果仍待确认。
本轮没有启动数据库或修改真实业务数据，也没有测量模型质量或性能提升。

## 真实环境验收

先恢复 Docker、项目要求的 Go 工具链、Linux shell 和原生依赖，处理相关路径的合并，再完成以下检查：

1. 执行上述包级 Go 测试；格式化本轮 Go 文件；构建后验证 API 模式的帮助命令可以启动。
2. 登录真实环境，从列表顶部和空列表按钮分别进入工作台，确认问题框聚焦、返回按钮回到列表。
3. 从 `/chats?isCreate=true` 进入，确认浏览器返回不会陷入跳转循环。
4. 分别选择四个场景及有完成文档的知识库创建，回读保存的领域、场景、知识库和模型，核对入口一致。
5. 尝试双击、创建失败后重试，确认没有重复助手，已填问题及设备背景仍在。
6. 在页面读取后删除知识库、删除文件或让唯一完成文档重新解析，确认服务端拒绝不再就绪的创建。
7. 核对问题和设备背景只预填一次，用户发送前不调用问答。
8. 修改助手名称，确认分类仍由保存的领域和场景决定；普通助手改成铁路名称后仍为普通类型。
9. 完成真实模型回答、引用回查与桌面/手机验收后，才将 R02 改为已验收。

前端预览地址：`http://localhost:9222/`。没有可用后端时，登录、资料和模型调用不可用。
后续优先恢复验证环境并完成 R02 验收，再处理 R03 的设置与实际行为一致性。
