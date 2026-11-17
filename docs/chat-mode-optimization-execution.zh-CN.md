# 聊天模式多模态优化执行台账

更新：2026-11-17，Asia/Shanghai。提案：[V1.1](chat-mode-optimization-proposal.zh-CN.md)。
基线：`680f666873700c7ee881c35ad594092d424e9270`，分支 `codex/upgrade-v1.0.0`。
本阶段已按用户最新指令恢复原实施，冲刺目标为北京时间2026-11-18；不以日期替代R/W/T退出条件。E63～E65的暂停交接为历史记录。

## 当前缺口与接续动作（2026-11-17）

| 类别与缺口 | 下一步动作 | 通过证据 |
| --- | --- | --- |
| 已实现待真实验收：手机组合单分支失败/重试 | 网关结算已修复并通过E76；继续核对E68的524是否可确认停止，再补手机场景，保留严格断言 | E68桌面复用；手机需真实图片、语音分支及刷新/下载/旧结果不变 |
| 已完成本批验收：E63文本、跨两消息播放 | 复用E71/E72，不重复合成 | E71真实TTS精确输入及WAV；E72两条真实消息桌面/手机播放互斥 |
| 公共路径缺陷：网关超时被误判为停止 | 已修复并正式部署；真实Worker 524保护通过，其他网关状态复用定向测试，不扩大实测范围 | E70定向及DAO/service回归；E74正式版本核对；E76真实Worker |
| 控制能力已有实现、剩余场景待验 | 关联现有取消/恢复/权限/预算/资源清理/模型路由证据，仅补缺口 | 复用E10/E17/E20/E22/E24/E31/E53/E56/E69；R/W/T表未闭合部分保持未验收 |
| 已正式部署、剩余运行场景待验 | API/Worker持久配置及重启已验；继续图片、权限预算、取消恢复及回退演练 | E74部署、真实语音阶段重试、重启及版本哈希；不等于正式环境全验收 |
| 依赖核对：重排与旧unknown | 部署前后从实际后端调用重排并执行启用重排的KB检索；旧unknown只在确认上游停止后核对 | E45历史排序/检索有效；不得据年龄释放旧租约，正式部署后补实际证据 |

## 基线和证据口径

- 工作区开始时有 3,683 项 tracked 路径改动；本次只读核对有28个未合并路径、76条索引阶段记录，路径数与索引条目数分开统计。未 reset、清理或覆盖原有改动，不能把整个 diff 归属本次任务。
- Go 1.27.1、LLD 20.1.8、native 库在 `ragflow-v1-builder:/workspace`；后端验证经过 `build.sh`。
- 隔离 API `ragflow-chat-test-api:19380`、ingestor、NATS、MinIO、Kvrocks；MySQL/ES/ClickHouse 共用实例，但 schema、租户、数据集隔离。没有替换或重启生产 `docker-ragflow-cpu-1`。
- E2E schema `ragflow_chat_test_e2e_mwhls5c9`；并发集成每次另建 schema，E22 为 `ragflow_chat_test_entry_mwhr9d8t`。秘密只留在本机 `.run` 配置，不写入报告。
- 数据库为任务权威状态；NATS 唤醒。资源等待保持 `running`，释放执行租约并延迟调度；没有 `running → queued` 回退。
- `accepted` 表示服务器已持久受理；`ok` 仅表示确认成功完成；`aborted` 表示本地停止观察，不代替服务端取消。受理后断流 GET 权威任务快照，不重提生成。
- `route_policy` 管文字/视觉规划；图片、TTS、音乐分别明确只支持固定适配入口。无合格媒体候选时不支持切换；未知媒体价格拒绝严格货币预算。
- R 状态只用 NOT_STARTED / IN_PROGRESS / IMPLEMENTED_UNVERIFIED / VERIFIED / BLOCKED。T 的 PARTIAL 表示明确子场景通过，其余仍待验。没有用百分比、文件存在或旧日志代替退出条件。

旧版R/W/T汇总快照没有计入E25之后的证据，不能作为当前通过项计数。本次完成了E25真实浏览器检查和相关前端回归，但尚未逐项重算全部T项；旧状态表中已被后续证据覆盖的限制以最新证据索引为准，不得据此宣称G4/W09完成。

## 可复现证据

命令在 `D:/ragflow` 运行。日志为本机证据，未包含凭证。E2E 使用真实业务实现；转发器只注入明确 HTTP 503 或控制时序，成功路径转发真实服务。

| 证据 | 命令 | 实际结果及范围 |
| --- | --- | --- |
| E01 | `docker exec -w /workspace ragflow-v1-builder bash -lc 'bash build.sh --test ./internal/service/... ./internal/dao/...'` | PASS；`.run/chat-latest-go.log`；service 11.257s、dao 1.326s 及子包。覆盖本轮可靠性生产修改，包括组合重试保持部分成功 |
| E02 | `npm --prefix web test -- --runInBand --runTestsByPath src/pages/next-chats/chat-stream/run-stream.test.ts src/services/chat-completion-stream.test.ts src/components/chat-media-audio.test.tsx src/services/chat-media-service.test.ts src/utils/chat-playback.test.ts src/services/chat-task-service.test.ts --coverage=false` | PASS，6 suites / 25 tests；`.run/chat-latest-jest.log`；受理未完成、断流校准、最终失败、播放乱序、流式大小边界 |
| E03 | `docker exec -w /workspace ragflow-v1-builder bash -lc 'bash build.sh --go'` | PASS；`.run/chat-reliability-build-latest.log`；新 CLI/server 构建；`--api --help`、`--ingestor --help`进入 main 输出 Usage，现有 CLI help 返回 1，不能称退出 0 |
| E04 | `node .run/run-chat-entry-integration.cjs > .run/chat-entry-concurrency.log 2>&1` | PASS，11 子场景，6.32s；内部 `bash build.sh --test-integration-go -run TestChatMediaEntryPointCleanupMySQLMinIO -count=1 -v ./internal/service/...`；真实 MySQL/MinIO/NATS |
| E05 | `node .run/chat-voice-browser.cjs > .run/chat-voice-browser-e2e.log 2>&1` | PASS；真实入库/检索、语音任务、引用、503、阶段重试、刷新、浏览器播放/暂停/下载、删除 404 和 MinIO 物理清理；桌面/390px 截图已检查 |
| E06 | `node .run/run-chat-voice-e2e.cjs combined > .run/chat-combined-e2e.log 2>&1` | PASS，138.92s；真实两支失败→文字引用刷新→audio-only→仍 partial→image-only 成功，真实 image 1/TTS 1，音频资源 ID 不变 |
| E07 | `node .run/run-chat-voice-e2e.cjs music > .run/chat-music-wait-e2e.log 2>&1` | PASS，19.56s；真实 MySQL/MinIO/TTS/music，连续 3 次资源等待只调用 TTS 1 次；恢复 music 成功，总 calls 2，WAV 10000ms/1920044 bytes。服务层恢复验证，尚非完整 Worker 唱歌 E2E |
| E08 | `docker exec -w /workspace ragflow-v1-builder bash -lc 'bash build.sh --test -run TestChatCombinedRetryKeepsUnfinishedBranchRetryable -count=1 ./internal/service/...'` | PASS；`.run/chat-combined-retry-unit.log`；E01 之后新增的专门单测，E06 同时覆盖真实路径 |
| E09 | `node .run/run-chat-entry-integration.cjs > .run/chat-snapshot-concurrency.log 2>&1` | PASS，12 子场景，7.549s；真实 MySQL/MinIO/NATS，增加两个实际 Worker scan 循环的优先级/等待提升/共享容量竞争；修复 MySQL RR 快照导致的容量超售 |
| E10 | `node .run/run-chat-route-integration.cjs > .run/chat-health-extended-real.log 2>&1` | PASS，5.273s；真实 DeepSeek 两模型故障备用、fixed 不切换、跨实例共享冷却、12 个竞争探测仅 1 个获准；阈值 2/冷却 17s、400/执行取消不计故障、成功探测清零；原配置不变 |
| E11 | `node .run/run-chat-voice-e2e.cjs singing > .run/chat-singing-worker-e2e.log 2>&1` | PASS，16.22s；完整 API→NATS→Worker 唱歌，参考 TTS 首次 503，刷新歌词及引用、audio-only 重试；真实 TTS 1/music 1，10000ms/1920044 bytes |
| E12 | `node .run/run-chat-voice-e2e.cjs combined > .run/chat-combined-current-e2e.log 2>&1` | PASS，49.43s；当前调度/健康配置下两支失败→文字引用刷新→audio-only partial→image-only 成功；真实 image 1/TTS 1，已成功音频和原终态不变 |
| E13 | `node .run/run-chat-voice-e2e.cjs music > .run/chat-music-wait-current-e2e.log 2>&1` | PASS，13.51s；连续三次资源等待复用同一参考，真实 TTS 1/music 1；服务层恢复测试 |
| E14 | `node .run/chat-voice-browser.cjs > .run/chat-current-voice-browser-migrated.log 2>&1` | PASS，38.24s；正式隔离迁移后真实知识检索、保存引用、TTS503、阶段重试、桌面/手机刷新播放下载、删除404及MinIO清理；207404 bytes/4.32s |
| E15 | `docker exec -w /workspace ragflow-v1-builder bash -lc 'gofmt -w internal/service/chat_task_reliability_test.go && bash build.sh --test ./internal/dao/... ./internal/service/... && bash build.sh --go'` | PASS；`.run/chat-pagination-go-build.log`，dao 1.517s/service 11.656s 及子包；含授权筛选先于分页的生产修复。API/ingestor help 已进入 main，见 `chat-pagination-api-help.log`/`chat-pagination-ingestor-help.log`，现有 help 退出 1 |
| E16 | `node .run/run-chat-task-center.cjs > .run/chat-task-center-browser-fixed.log 2>&1` | PASS；16 条真实任务，分页每页10且无重叠、前后页、状态/类型筛选、操作遵循后端、关闭列表并跳回原轮次；pageerrors 0，390px 无溢出。`chat-task-center-desktop.png`/`chat-task-center-mobile.png` 已查看 |
| E17 | `node .run/run-chat-worker-fault-e2e.cjs > .run/chat-worker-fault-e2e-current.log 2>&1` | PASS，53.576s；e2e 层真实隔离 ingestor SIGKILL/重启/自然租约过期，文字引用保留，unknown 隔离无重放；取消及删除后放行真实已生成音频，无迟到发布/会话复活，删除任务列表计数0。三个场景各真实 TTS 1 次；确认上游完成后 ReconcileStopped 释放容量 |
| E18 | `npm --prefix web test -- --runInBand --runTestsByPath src/utils/__tests__/request-auth.test.ts src/pages/next-chats/chat-stream/run-stream.test.ts src/services/chat-completion-stream.test.ts src/components/chat-media-audio.test.tsx src/services/chat-media-service.test.ts src/utils/chat-playback.test.ts src/services/chat-task-service.test.ts --coverage=false` | PASS，7 suites/27 tests，3.82s；`.run/chat-audio-jest-current.log`；最新音频多余 abort 删除后复跑，覆盖播放乱序、旧请求隔离和受理协议；异常认证头不能清除新会话；音频组件 oxfmt/oxlint 通过 |
| E19 | `docker exec -w /workspace ragflow-v1-builder bash -lc 'gofmt -w internal/service/chat_task.go internal/service/chat_task_idempotency_e2e_test.go && bash build.sh --test ./internal/dao/... ./internal/service/... && bash build.sh --go'` | PASS；`.run/chat-idempotency-go-build.log`，dao1.318s/service11.534s及子包；修复幂等哈希包含服务端重新分配的created_at/id。LLD20.1.8，API/ingestor help均输出Usage（现有退出码1），仅重启隔离API/ingestor |
| E20 | `node .run/run-chat-voice-e2e.cjs idempotency > .run/chat-idempotency-current-e2e.log 2>&1` | PASS，19.705s；显式/自动轮次ID两入口，各4并发提交、终态重放、2异内容冲突、4并发audio重试、完成后重放；每组真实TTS拒绝1/生成1，数据库仅原任务及重试2行，文字引用/唯一音频保留，原终态不变 |
| E21 | `node .run/chat-voice-browser.cjs > .run/chat-voice-browser-idempotency-fixed.log 2>&1` | PASS，14.086s；E19及最新音频组件后完整真实语音闭环，253484bytes/5.28s，真实TTS1/拒绝1；浏览器刷新/播放/暂停/下载/手机390px无溢出，删除404及物理清理；桌面/手机截图已查看 |
| E22 | `node .run/run-chat-entry-integration.cjs > .run/chat-pending-admission-current.log 2>&1` | PASS，7.03s；重验引用竞争/慢清理/恢复/双Worker，新增真实MySQL REPEATABLE-READ用户/租户受理上限：并发2笔、上限1，恰好受理1/拒绝1。维护锁已串行化受理，未修改配额生产实现 |
| E23 | `node .run/run-chat-voice-e2e.cjs snapshot > .run/chat-snapshot-revocation-current-e2e.log 2>&1` | PASS，21.66s（包21.699s）；`TestChatTaskRealSnapshotAndRevocation`：真实资源等待后改模型/知识库/prompt/temperature仍按冻结输入生成带引用语音，实际TTS1；停用会话后not_found，供应商身份变化后upstream_unavailable，两者calls/attempts/TTS/assets均0。成功任务`1efe20b4c77b40789ebf0e613d042d66` |
| E24 | `node .run/run-chat-voice-e2e.cjs redelivery > .run/chat-completed-redelivery-e2e.log 2>&1` | PASS，5.50s（包5.552s）；`TestChatTaskRealCompletedRedelivery`：真实TTS响应在途发布3次重复消息，成功后再发布5次；实际Worker消费者AckFloor确认到stream seq63；终态revision/events/outputs/attempts不变，TTS1/asset1/answer1，calls保持3。任务`9d151872d4f74ad98d9c7e3aea1f4837` |
| E25 | `node .run/run-chat-image-versions.cjs > .run/chat-image-parent-navigation-real-browser-e2e.log 2>&1` | PASS；复用E2E隔离schema中的真实旧图编辑任务，不新增生成调用。桌面1440px/手机390px均从编辑图跳至其实际父消息、将父图选为编辑目标、下载4,400,905字节并与已保存原图SHA256一致；父子尺寸2048×1152，浏览器错误0、页面横向溢出0。实现：`web/src/components/chat-media-image.tsx`、`web/src/pages/next-chats/chat/chat-box/single-chat-box.tsx`；截图`chat-image-parent-desktop.png`/`chat-image-parent-mobile.png` |
| E26 | `npm test -- --runInBand --runTestsByPath src/components/chat-media-image.test.tsx src/components/chat-media-audio.test.tsx src/hooks/use-speech.test.tsx src/services/chat-media-service.test.ts src/utils/chat-playback.test.ts --coverage=false` | PASS，5 suites/15 tests；`.run/chat-image-navigation-final-jest.log`。含父图查看与编辑目标分离、不存在父图时不展示导航，以及既有播放竞态/读取上限回归 |
| E27 | `npm run build`、`npx oxlint ...`、`npx oxfmt --check ...`（均在`web/`） | PASS；Vite生产构建完成，相关变更文件oxlint和oxfmt通过。构建输出保留既有Tailwind插件、pdfjs eval和大chunk警告，不将警告称作失败 |
| E28 | `docker exec ragflow-v1-builder bash -lc 'cd /workspace && bash build.sh --test ./internal/service/...'`；`node .run/run-chat-voice-e2e.cjs snapshot` | 单测 PASS，service及子包、native unit tests通过。实现并测试新错误码`provider_identity_changed`；真实E2E未验收：隔离用户配额已占满2/2，迟到音频子场景另因TTS等待120s无响应失败，不能据此声称分类集成通过 |
| E29 | `node` 调用隔离构建容器：`bash build.sh --test-e2e -run '^TestChatTaskRealSnapshotAndRevocation/provider_changed$' -count=1 -v ./internal/service/...` | 未验收，测试在 admission 前因隔离用户现有 holders=2、capacity=2 退出；没有释放未知租约、没有修改断言。日志：`.run/chat-provider-identity-focused-e2e.log` |
| E30 | `npm run type-check -- --pretty false`（`web/`） | 未通过，最新仍为32项诊断；均在admin、agent、agents、dataflow-result、dataset、editor、memory、next-searches模块，本次聊天多模态涉及文件无诊断。日志：`.run/chat-typecheck-latest.log`；全仓基线后续仍需逐项归因，但不扩展修复无关模块 |
| E31 | `node .run/run-chat-entry-integration.cjs > .run/chat-cleanup-reliability-current.log 2>&1` | PASS；真实隔离 MySQL/MinIO/NATS。删除凭据拒绝后资源保持 deleting、清理账本进入带退避的 retry，新引用被拒；恢复对象存储后对象删除、账本完成且无悬空引用。并重验引用/清理竞争、双 Worker 配额、持续到达调度、答案版本竞争等子场景；完整日志 `.run/chat-cleanup-reliability-current.log` |
| E32 | `node .run/chat-isolated-diagnose.cjs` 核对真实隔离数据后，临时提高隔离用户容量并运行 `node .run/run-chat-voice-e2e.cjs snapshot`，随后恢复原容量 | 未验收，最新日志 `.run/chat-provider-identity-recheck-e2e.log`。容量恢复为2，未修改/释放既存租约；模型 `planning` 真实请求持续 `upstream_unavailable`，五个快照子场景均未进入资源等待检查点，迟到TTS场景也未取得响应。不能证明专用身份错误码 |
| E33 | `docker exec -w /workspace ragflow-v1-builder bash -lc 'bash build.sh --test ./internal/dao/... ./internal/service/...'` | PASS；最新包级 Go 单测及子包、native unit tests；日志 `.run/chat-dao-service-final-current.log` |
| E34 | `provider_changed` 定向真实 E2E（隔离用户容量临时 2→3，结束后恢复并核对租约）；`npm test -- --runInBand --runTestsByPath src/components/chat-media-image.test.tsx src/components/chat-media-audio.test.tsx src/hooks/use-speech.test.tsx src/services/chat-media-service.test.ts src/utils/chat-playback.test.ts --coverage=false`；对应 `npx oxlint`/`npx oxfmt --check` | 身份变更 E2E 未验收：模型健康探针 HTTP 200，但任务 90 秒仍在 planning 失败、calls=0，未到资源等待检查点；日志 `.run/chat-provider-identity-final-e2e.log`。finally 已恢复容量 2，核对两个既存租约均保留。前端 PASS：5 suites/15 tests，lint 与格式检查均通过 |
| E35 | `docker exec -w /workspace ragflow-v1-builder bash -lc 'bash build.sh --go'`，核对 API/ingestor help 后仅重启 `ragflow-chat-test-api`、`ragflow-chat-test-ingestor`；`node .run/run-chat-combined-browser-with-capacity.cjs > .run/chat-combined-real-browser-e2e-current.log 2>&1` | 当前源码构建成功，两个模式均输出 Usage（既有 help 退出码 1）；隔离容器启动时间更新为 2026-11-16 07:52 UTC。浏览器闭环未验收：第一分支任务在 planning 以 `upstream_unavailable`、calls=0 失败，未达到预期 `partial_succeeded`。临时扩容前用户资源2/2、设备1/1；脚本只各加1容量，保留租约，finally 恢复原容量并核对原租约未变。日志 `.run/chat-combined-real-browser-e2e-current.log` |
| E36 | `docker exec -w /workspace ragflow-v1-builder bash -lc 'bash build.sh --test ./internal/dao/... ./internal/service/...'` | PASS；当前工作区源码、dao/service 全部目标包及 native unit tests；日志 `.run/chat-dao-service-latest.log`；dao 1.715s、service 12.276s及各子包通过 |
| E37 | `docker exec -w /workspace ragflow-v1-builder bash -lc 'gofmt -w internal/service/chat_route_test.go && bash build.sh --test -run "TestChatRouteHealthGateDoesNotMasqueradeAsProviderFailure\|TestChatTaskErrorClassification" -count=1 ./internal/service/...'`；随后 `docker exec -w /workspace ragflow-v1-builder bash -lc 'bash build.sh --test ./internal/service/...'` | PASS；当前路由错误分类改动。健康探测未放行候选时返回 `route_no_eligible_candidate`，隔离 DAO 测试断言无模型回调、无计费调用；定向测试及 service 全包/native tests 通过（service 12.677s）。尚未复跑真实组合 E2E，不能证明原因分类已穿透 Worker/API，也不能标记 R17/R19/T38 VERIFIED。 |
| E38 | `docker exec -w /workspace ragflow-chat-test-ingestor bash -lc 'gofmt -w internal/service/chat_task.go internal/service/chat_task_diagnostics_test.go && bash build.sh --test -run "TestChatTaskDiagnosticCause\|TestChatTaskDiagnosticsPersistedAttempts" ./internal/service/...'`；`node --check web/e2e/chat-combined-lifecycle.cjs`；读取隔离 Worker 最近2小时日志 | PASS；Go 定向诊断分类及任务详情冻结路由摘要测试通过，service 子包/native tests通过；浏览器脚本语法通过。失败摘要现在读取经鉴权任务详情的白名单 routing_snapshot（租户/模型持久化ID/路由策略），不再误读被 JSON 隐藏的 task.input；原有终态断言保留。Worker 最近2小时无任务失败日志。既有任务 `b8614854bb1241d999a2b2ab46ecb868` 为 `failed/planning/upstream_unavailable/not_started/calls=0`、无 attempts，事件仅受理/阶段/终态；历史错误不足以确认首次失败函数。尚未改动候选筛选、参数或容量逻辑，未发新生成请求，不得标记根因已修复或真实闭环通过。 |
| E39 | 只读隔离 MySQL 核对任务 `b8614854bb1241d999a2b2ab46ecb868` 的 task/attempt/event、资源/租约和当前健康记录；跟随真实任务 `66b595a1211345f3bf8f24df70a10b8e` 至终态并读取任务事件、隔离 Worker/API 日志 | 历史 planning 失败为 `failed/planning/upstream_unavailable/not_started/calls=0`、无 attempts，事件无原始错误，首次失败函数/条件仍不可确认。新任务最终为 `failed/language_queued/budget_exhausted/not_started/calls=0`，无 attempts；此前两既有 unknown 上游租约占满隔离用户 `2/2` 容量，未释放租约、未扩容。该任务未进入路由，不能作为 planning 根因复验。当前健康行只是事后快照；Worker/API 版本 `680f6668`，无可归因的 Worker 失败日志。详见 E41 对该终态分类缺陷的修复。 |
| E40 | `node --check web/e2e/chat-combined-lifecycle.cjs`；检查等待器调用点及终态断言 | PASS（语法）；首个组合任务等待 `partial_succeeded`、阶段重试等待 `succeeded`，若提前进入其他终态先输出安全诊断再失败；原有后续断言保留。未运行真实生成流程，故仅验证脚本行为入口，非组合 E2E 通过证据。 |
| E41 | `docker exec -w /workspace ragflow-v1-builder bash -lc 'gofmt -w internal/dao/chat_task.go internal/dao/chat_task_recovery_test.go internal/service/chat_task_error.go internal/service/chat_task_error_test.go internal/service/chat_task_diagnostics.go internal/service/chat_task_diagnostics_test.go && bash build.sh --test -run "TestChatTaskDeferDistinguishesResourceWaitAndExecutionDeadline\|TestChatTaskErrorClassification\|TestChatTaskDiagnosticCause" -count=1 ./internal/dao/... ./internal/service/...'`；`docker exec -w /workspace ragflow-v1-builder bash -lc 'bash build.sh --test ./internal/dao/... ./internal/service/...'` | PASS；定向 DAO/service 测试和 dao/service 全包回归、native unit tests 均通过。`Defer` 的资源等待上限现在返回独立错误，映射为 `resource_unavailable` / `resource_wait_timeout`；总期限单独映射 `deadline_exceeded`；调用/费用预算仍为 `budget_exhausted`。没有改变资源等待保持 `running`、释放租约并延迟调度的契约。仅单测验证，尚无真实 Worker 资源等待到期 E2E。 |
| E42 | 只读查询隔离 schema 的 `user_tenant`、`user`、`chat_task_resource`、`chat_task_resource_lease` | 仅发现原验收用户一个有效租户成员，没有第二个可复用的独立用户身份；用户资源容量/租约为 `2/2`，租户级为 `2/4`。未读取或输出凭据、未创建成员、未改容量或租约。当前无合法替代身份可用于最小真实 planning 验证。 |
| E43 | `docker exec -w /workspace ragflow-v1-builder bash -lc 'gofmt -w internal/service/chat_task_snapshot_e2e_test.go && bash build.sh --test-e2e -run "^$" -count=1 ./internal/service/...'` | PASS，e2e 标签 service 包编译通过，未运行生成请求。`waitChatDatabaseTask` 现在在目标检查点之前遇终态即失败，并输出 task 状态/错误、最近5个 attempts、按序最近8个安全事件及冻结租户/模型持久化ID/route_policy；不输出输入正文、密钥或供应商响应。尚未用真实失败任务验证该诊断输出；此项只修复定位工具，不代表 planning 根因已修复。 |
| E44 | 只读复查隔离库最近任务、失败任务冻结输入白名单、模型状态/配置键、资源租约和健康行；静态跟踪 `generateMediaReply → AsyncChatSolo → ChatModel.ChatWithMessages → chatRouteState.invoke → ReserveCall` | 当前仍无新任务可提交：隔离用户资源 `2/2`，两条租约分别对应 `failed/unknown` 与 `partial_succeeded/unknown`；租户资源 `2/4`。健康行 `cooldown_until=0`、`probe_until=0`、`generation=0`、`failures=0`，仅是当前快照。最近 planning 失败冻结 `tenant_model_id=102e9861e4e24a73abb7cff80df6c52e`、模型 `deepseek-flash`、provider `DeepSeek`、`route_policy=fixed`、`max_tokens=1024`，模型和实例均 active；历史事件无 attempts/cause。调用链确认 preferred 模型解析失败会在路由前返回；健康探测拒绝会产生 `route_no_eligible_candidate`；回调内 driver/`validateMaxOutput` 失败可发生在 `ReserveCall` 前，故 `calls=0` 尚不能区分这些条件。未发新请求、未改模型/健康/租约/容量；planning 根因仍未知。 |
| E45 | 原本机入口启动 llama.cpp；`docker exec -i docker-ragflow-cpu-1` 内 `curl` 真实访问 `http://host.docker.internal:8082/v1/rerank`，再访问容器内 `http://127.0.0.1:9380/api/v1/searchbots/retrieval`；`& ./tools/scripts/start-local-reranker.ps1` 连续两次；三个启停脚本 PowerShell 语法解析及只读进程/容器核对 | PASS（恢复及两项真实调用）；2026-11-16 19:35～19:42，Asia/Shanghai。直连排序 `[1,2,0]`，有效原始分数 `[7.205165863,-4.245608807,-11.030210495]`；知识库实际重排16个候选、返回5条结果，API `code=0`，同一请求窗口的 llama 日志恰有16次推理完成。新入口接管并重复复用 PID20740，校验认证模型及监听归属。主服务和隔离API/ingestor均未重启。详细边界及本机证据见下方；停止/重新拉起分支未实测，不能称完整启停演练通过。 |
| E46 | 正式服务 `/chats/capabilities`、生产 ingestor 归属/在途摄取核对；`node .run/repair-chat-media.cjs worker`，随后 `voice`、`image`、`verify`、`voice user-model` | PASS（本机正式语音/生图恢复）；实际原因是普通 Compose 的本地环境文件遗漏 `RAGFLOW_CHAT_WORKER_ENABLED`，生产库没有注册媒体 Worker，能力接口明确拒绝。补齐 `docker/.env.local`，确认无在途摄取后只优雅替换原 ingestor，使用原容器/原Go二进制启用 Worker。真实语音、生图均 succeeded、calls=2、两阶段各一次；桌面1440及手机390均刷新回读，语音播放/暂停/下载字节一致，图片解码2048×2048，无横向溢出。原聊天模型 gpt-6.1-sol 另建验收会话亦 succeeded/calls=2。主容器ID/启动时间/重启计数未变；音乐18881仍未恢复，隔离规划阻塞未据此判定解决。详见下方。 |
| E47 | `node .run/organize-chat-containers.cjs`；Docker inspect、隔离库非终态任务数、分组前后容器指纹及实际API健康检查 | PASS（隔离容器整理）；11个独立测试容器归入 `ragflow-chat-test` Compose 项目，5个基础服务运行，6个日志/发布/回退副本按 `acceptance` profile 保持停止。沿用 MinIO/Kvrocks 原卷、原数据库/网络/环境/镜像；NATS停止后复制329个文件至持久卷，启动前逐文件SHA256一致。生产7个容器及Ollama的ID/启动时间/重启数不变，未删除数据卷。首次因API尚未就绪而失败并自动恢复原11容器；补充真实依赖就绪等待后通过。未把首次尝试当成功。 |
| E48 | 修正本机媒体supervisor复用及独立启动；三个启停脚本PowerShell语法解析；`node .run/repair-chat-media.cjs singing`、`node .run/repair-chat-media.cjs verify singing` | PASS（本机音乐恢复及真实Worker/浏览器）；supervisor35308复用原Serena语音18604、启动音乐5908，端口18880/18881健康；真实唱歌任务succeeded/music/calls3，language/audio/music各成功一次，10秒WAV1920044字节。1440/390两视口刷新、实际播放暂停、下载哈希一致且无溢出/pageerror。未停止/重启生产；完整启停仍未演练。 |
| E49 | 只读核对 `.run/chat-isolated-planning-state.json` 对应的隔离用户、成员、聊天、会话、任务及租约；经隔离 API 尝试创建会话 | BLOCKED（未触及模型规划）：临时普通成员可登录，但社区权限策略将聊天视为租户私有资源，创建会话返回 HTTP 200 / 业务 code 404；隔离库确认该聊天无会话、无任务。未发模型请求或重跑 planning。原用户两条 `unknown` 租约及设备租约 ID/epoch 完全未变；没有改容量、健康状态或服务配置。已产生的隔离用户、普通成员和无会话聊天记录保留。此权限拒绝不能归因为模型/Worker 故障，也不能作为 `calls=0` 根因证据。 |
| E50 | `node .run/repair-chat-media.cjs voice`、`image`、`verify`；桌面1440px/手机390px刷新、播放/下载/图片解码核验 | PASS（正式环境真实语音/生图复验）：语音任务 `1e2be1210bfa4b18a644c357485a9789` 与生图任务 `9505dd0709c8472bb4af5c1d025917e4` 均 succeeded、各 `calls=2`；WAV播放/暂停/下载SHA256一致，PNG解码为2048×2048，页面无横向溢出。任务和attempt证据 `.run/chat-media-repair-voice.json`、`.run/chat-media-repair-image.json`；隔离验收转发器调用数为0，故不把转发器当生产故障根因。未重启或替换生产服务。 |
| E51 | 只读查询隔离schema任务/attempt/event、资源/租约、模型健康及精确持久化模型实例；检查隔离 ingestor 日志与当前容器环境 | 诊断未完成、根因仍未知：规划失败 `b8614854bb1241d999a2b2ab46ecb868` 的历史事件无原始错误、attempts为0；冻结身份是 `deepseek-flash` / `102e9861e4e24a73abb7cff80df6c52e`，该模型当前active且精确实例指向 `https://api.deepseek.com/v1`；上下文配置 `max_tokens=128000`，`max_output` 未配置。当前配置和历史成功记录不能证明失败时请求结果。现有两条 unknown 租约仍占用户容量 `2/2`，未释放、未扩容、未提交新Worker任务；也未改健康记录。仅仅没有容器日志不能证明请求未发出。下一步需等待既有租约被权威确认停止/释放，或使用合法且已有独立容量的同权限验收身份，再取得一次带安全错误证据的最小真实Worker规划结果。 |
| E52 | `docker exec -w /workspace ragflow-v1-builder bash -lc 'ld.lld --version && gofmt -w internal/service/chat_task_fault_e2e_test.go internal/service/chat_task_idempotency_e2e_test.go internal/service/chat_task_redelivery_e2e_test.go internal/service/chat_task_rollout_e2e_test.go internal/service/chat_task_snapshot_e2e_test.go && bash build.sh --test-e2e -run "^$" ./internal/service/...'` | PASS，退出0，LLD20.1.8；service及子包的e2e标签编译通过，未运行真实生成任务。等待真实音频与取消检查点时先读任务状态，提前进入不可达终态即输出安全诊断并失败，等待支持context取消；6个`waitRealAudioHeld`调用均传任务ID。不输出原始outputs，不放宽终态断言。仅验证等待器编译，不代表planning根因或业务E2E通过。命令结果见本轮工具执行记录。 |
| E53 | `node .run/run-chat-entry-integration.cjs > .run/chat-entry-reconcile-current.log 2>&1`；内部经`bash build.sh --test-integration-go -run TestChatMediaEntryPointCleanupMySQLMinIO -count=1 -v ./internal/service/...` | PASS，退出0，service18.809s；2026-11-16，真实隔离MySQL/MinIO/NATS，schema保留`ragflow_chat_test_entry_mwjcevdr`。E31后的公共任务代码已有修改，因此复用现成脚本补跑一次；引用竞争、清理事务故障恢复、分发/ACK故障、取消竞争、答案版本竞争、事件积压/权限及统计全部通过。未发模型生成请求、未改既存unknown租约或容量、未重启服务。准确边界见下方。 |
| E54 | `docker compose ls --all --format json`、`docker ps -a`及builder/Ollama定向inspect；核对最新类型检查日志及诊断文件修改时间 | 只读复核：测试组仍为`ragflow-chat-test`，5个基础服务运行、6个验收副本Created；正式`docker`组7个服务运行。builder为构建环境、Ollama为模型服务，其他Compose项目独立保留，未删除容器或卷。类型检查仍按E30的32项/24文件记录：21项未使用符号、11项其他类型诊断；相关诊断文件未在日志之后修改，本轮未改前端，未原样重跑。报错语句在HEAD存在不能单独证明完整诊断为旧基线，共享类型依赖归因仍未完成。 |
| E55 | 按`chat_task_config.go`、`chat_route.go`、`chat_media_migration.go`、DAO维护/核对入口和`cmd/ragflow_server.go`补齐`docs/chat-media-local.md`；`docker exec -w /workspace ragflow-v1-builder bin/ragflow_server --migrate --help` | 配置及操作入口已文档化：全部Worker参数的默认/范围/关系、租户路由与固定媒体限制、planning安全诊断、迁移分页/冻结/恢复和unknown核对前提。现存二进制实际输出维护Usage，既有help退出1，与main显式退出一致；未构建新二进制。明确`dry-run`先执行schema迁移、freeze拒unknown、核对命令不验证证据内容、ingestor共享30秒停机期限等实际边界。仅文档及静态/帮助入口核对，不代表执行了迁移、租约释放、停机或回退演练。Docker实态仍与E54一致。 |
| E56 | `node .run/run-chat-image-versions.cjs access > .run/chat-media-access-real-browser-e2e.log 2>&1`；`web/e2e/chat-media-access.cjs`经oxfmt/oxlint及Node语法检查 | PASS，退出0；复用真实组合任务`c454b5b9cd74403ca9f8051a8bdb7aac`的图片与音频，无新生成请求。1440×1000和390×844均完成：正常读取200且`private, no-store`；聊天撤权后普通HTTP缓存读取、已缓存音频续播、图片/语音下载均404且无下载；恢复后两资源SHA256不变；同一浏览器切换至无有效成员关系的跨租户账号后，缓存读取/续播和新鲜API读取均404。所有任务calls、既有resource/task/epoch租约快照不变；测试聊天及测试成员权限finally恢复并核对。无浏览器异常，截图已检查。未修改业务实现、生产服务或容量，配置上限真实超限仍待验。 |
| E57 | `node .run/run-chat-image-versions.cjs access > .run/chat-media-playback-access-real-browser-e2e.log 2>&1`；定向oxfmt/oxlint/Node语法检查 | PASS，退出0；同一脚本补充后重新执行桌面/手机真实路径：媒体播放器播放时点击“朗读内容”，GET既有WAV且原播放器暂停；再点媒体播放时朗读暂停，两个方向均检查全页面恰好一个audio在播放。通过真实站点链接离开聊天后，观察原生URL API调用，至少3个已创建音频blob URL全部显式revoke且audio组件已卸载。无新生成/TTS请求，E56权限、哈希、calls和租约不变断言也再次通过。只覆盖同一回答的两种入口，未替代两条不同消息及AST全边界验收。 |
| E58 | 正式Worker/本机语音归属及历史attempt核对；原Go维护入口`--chat-task-reconcile`；`node .run/repair-chat-media.cjs voice`、`node .run/repair-chat-media.cjs verify` | PASS（当前语音恢复及浏览器复验）；2026-11-17，确认旧本机TTS执行已无法继续后，通过现有核对入口释放对应三条租约，原任务文字/输入/输出/调用数不变。新语音任务`7cdcca96e4364202a822d0a2ab1f5a8d` succeeded/audio/calls2，两阶段各一次；1440/390两视口刷新播放暂停、WAV下载哈希一致。图片复用E50成功任务`9505dd0709c8472bb4af5c1d025917e4`，真实PNG读取/解码成功，无新增生图调用。四张截图已查看，无pageerror和横向溢出；图片手机元信息会换行，不声称所有布局问题均解决。详细边界见下方。 |
| E59 | builder中`bash build.sh --test -run "TestChatMediaConnectionFailureResourceSettlement\|TestChatMediaRequestRejectsRedirectAndSanitizesErrors" -count=1 ./internal/service/...`，随后`bash build.sh --test ./internal/service/...` | PASS，退出0；定向service0.101s，包级service12.317s及子包、native unit tests通过。Go媒体HTTP路径仅在明确`net.OpError.Op=dial`时认定上游停止；真实本机socket测试证明拒绝连接释放租约、请求到达后的断流及不完整响应仍保留unknown和三条租约。源码防护尚未部署到正式进程，不能将E58当成新二进制故障场景验收。 |
| E60 | `docker ps -a`、正式容器定向inspect及持久Worker配置核对 | 只读复核；测试11容器仍在单一`ragflow-chat-test`项目，API/NATS/MinIO/Kvrocks四个运行，ingestor为Exited255，六个验收副本Created。正式`docker`组7个运行；builder和Ollama用途独立，其他项目保留。正式容器2026-11-17 04:15:18 UTC已在本批恢复前启动、restartCount1，本批未重建或重启它。当前ingestor显式启用Worker，但容器创建环境仍缺该开关；持久文件已为true，尚未通过Compose重建应用，直接重启现有容器仍可能丢失Worker。不得继续沿用E54的“五个测试基础服务运行”作为当前状态。 |
| E61 | 在builder中`source ./build.sh`，指定独立`RAGFLOW_SERVER_BINARY=/workspace/.run/ragflow_server-media-20261117`和`RAGFLOW_CLI_BINARY=/workspace/.run/ragflow-cli-media-20261117`后执行原`main --go`；新server的`--api --help`、`--ingestor --help` | PASS（构建及启动检查）；LLD20.1.8，构建退出0，两个模式均进入main并输出完整Usage，沿用help退出1的既有行为。server SHA256 `0e2b23783d7cbfca621093dd1e99831d75f2923b445c0c8d47fe1994e94a93bb`；生产挂载的`bin/ragflow_server`仍为`3b87cded7c1b558221dfe4373ebd1507574a349d1d658b13407b8057eceb202b`。未改build.sh、未覆盖生产二进制或启动新服务；E59防护尚未部署。结果见本轮构建及help工具执行记录。 |
| E62 | 复用`.run/chat-typecheck-latest.log`，读取32项报错语句及其直接类型声明，核对`web/tsconfig*.json`相对HEAD无差异 | 当前错误分类及直接来源已核对，详见下方；21项TS6133是局部未使用符号，11项其他诊断可定位至agent变量、日志表格和dataflow解析编辑器的类型契约。未发现来自聊天媒体类型的直接证据；没有清理无关模块、降低strict/noUnused或重跑未变化的全仓检查。不能以该分析证明全部错误的历史来源，也不声明全仓type-check通过。 |
| E63 | builder中`bash build.sh --test -run TestChatSpeechTextOmitsNonProse -count=1 ./internal/service/...`，随后`bash build.sh --test ./internal/service/...`及`bash build.sh --test -run TestChatAudioSpeechFailureOmitsProviderError -count=1 ./internal/handler/...` | PASS，最终均退出0；先加8个用例，旧实现确定失败4项：自动链接标签缺失、Markdown转义未还原、实体未解码、编码标签文字未解码，原失败保留`.run/chat-speech-ast-before.log`。复用现有Goldmark文本writer处理转义/实体，补AutoLink标签，去掉AST后再次按标签剥离，保留编码后的可见标签文字及转义实体。16个AST用例全部通过，service定向0.070s、包级12.256s及子包、handler定向2.314s，native unit tests亦通过。日志`.run/chat-speech-ast-after.log`、`.run/chat-speech-service-regression.log`、`.run/chat-speech-handler-regression.log`。 |
| E64 | `npm --prefix web test -- --runInBand --runTestsByPath src/hooks/use-speech.test.tsx src/utils/chat-playback.test.ts --coverage=false`；web内定向`npx oxfmt src/hooks/use-speech.test.tsx`、`npx oxlint src/hooks/use-speech.test.tsx`、`npx oxfmt --check src/hooks/use-speech.test.tsx` | PASS，2 suites/5 tests，13.617s，日志`.run/chat-speech-playback-unit.log`；格式和lint退出0。新增两个不同消息的实际useSpeech实例单测：第二条播放使第一条暂停且状态归零，卸载第一条不干扰第二条，暂停第二条状态归零，全程零TTS请求。音频读取和HTMLAudioElement为单测替身，不是两条真实消息的浏览器验收；本批未修改前端业务源码、类型配置或依赖。 |
| E65 | builder内`source ./build.sh`，设置`RAGFLOW_SERVER_BINARY=/workspace/.run/ragflow_server-speech-review-20261117`及`RAGFLOW_CLI_BINARY=/workspace/.run/ragflow-cli-speech-review-20261117`，执行原`main --go`；新server的`--api --help`、`--ingestor --help`；生产二进制哈希及容器定向inspect | PASS（构建及启动检查），LLD20.1.8，构建退出0；两种模式完整输出Usage且进入main，help沿用既有退出1。日志`.run/chat-speech-review-build.log`、`.run/chat-speech-review-api-help.log`、`.run/chat-speech-review-ingestor-help.log`。新server SHA256 `fd91b9f569cb41311a9fcd7f54bf1b169e37b343294f3d70ebafea63c8b23595`；正式`bin/ragflow_server`仍为`3b87cded7c1b558221dfe4373ebd1507574a349d1d658b13407b8057eceb202b`。正式容器启动时间仍为2026-11-17 04:15:18.376681922 UTC、restartCount1；未覆盖或重启生产。 |

| E66 | `node .run/chat-planning-recovery.cjs resume-setup`；隔离 Compose 新增 planning API/ingestor；`node .run/chat-planning-recovery.cjs mismatch`；`bash build.sh --test ./internal/dao/... ./internal/service/...` | PASS。Docker Desktop 初始未运行，启动后恢复现有隔离基础服务。新验收 schema `ragflow_chat_test_planning_20261117` 复用原获授权测试身份、模型及已经索引的测试数据，使用独立 NATS 任务命名空间。只在新库中复现数据库容量 3、Worker 配置 2：任务 `17b7edf2afeb495593388231c2cea895` 在 `planning` 终止，`calls=0`、`upstream=not_started`、无 attempts，任务及终态事件均明确 `resource_config_mismatch`。DAO 拒绝改写原容量，错误码及诊断分类有回归覆盖。该复现解释此前只改库容量时的失败机制，不能还原没有原因记录的每个历史任务。原隔离库两条 unknown 及对应五条租约未更动。 |
| E67 | `GOFLAGS=-buildvcs=false` 下通过 `build.sh` 构建独立 server；API/ingestor `--help` 与两运行进程 `/proc/1/exe` 哈希核对；恢复新库用户容量为 2，Compose 重启 planning ingestor；`node .run/chat-planning-recovery.cjs smoke` | PASS。独立二进制 SHA256 `5cfaacdc1bc170a6e0485704a4b4afb41b70ab318a39900dc3d61b36dcd8c67b`，API 和 ingestor 实际运行该版本；Worker 持久开关为 true，重启后注册有效心跳。任务 `0903092135d94ad5804a03e17b7c2ec8` 从同一固定规划模型进入真实 Worker，2 次 language、1 次真实 TTS 均成功，知识库答案及 1 条引用与 1 个音频资源保存。日志 `.run/chat-planning-real-smoke-20261117.log`。正式二进制仍为旧哈希。空新库首次同时启动时出现系统设置重复种子，ingestor 完成初始化后单独启动 API 成功。 |

| E68 | `node .run/chat-isolated-vite.mjs planning`；`node .run/run-chat-combined-browser.cjs planning`；组合脚本定向 oxfmt/oxlint | PARTIAL。新版隔离环境桌面场景完成图片故障注入、保留语音与引用、任务中心只重试图片、旧终态和成功资源未变、刷新后播放及下载哈希匹配，截图在 `.run/chat-planning-screenshots/chat-combined-desktop.png`。手机场景同样完成规划和文字提交，但实请求生图约 126 秒后从上游收到 HTTP 524，随后语音命中预定故障，导致两支均失败，原单分支断言如实失败。日志 `.run/chat-planning-combined-browser-20261117.log`。T38仍为PARTIAL。 |
| E69 | `node .run/run-chat-voice-e2e.cjs planning-provider`，经 `build.sh --test-e2e` 只运行 `TestChatTaskRealSnapshotAndRevocation/provider_changed` | PASS，子场景 5.23s。真实隔离 Worker 在已受理且因容量等待时更改供应商身份，放行后稳定返回 `provider_identity_changed`，零模型 attempts、零 TTS 请求、无媒体发布，冻结输入未改。日志 `.run/chat-planning-provider-e2e-20261117.log`。 |
| E70 | builder内`bash build.sh --test -run TestChatGatewayFailureResourceSettlement -count=1 ./internal/service/...`；`bash build.sh --test ./internal/dao/... ./internal/service/...` | PASS，定向service0.409s，回归DAO2.497s/service19.159s及子包/native。14个子场景覆盖媒体HTTP与语言APIStatusError的408/502/504/520/524：attempt和上游保持unknown、租约保留、重试选项关闭、再次Begin拒绝；429/503明确拒绝仍释放占用。日志`.run/chat-gateway-settlement-unit.log`、`.run/chat-gateway-service-regression.log`。独立构建及API/ingestor/Admin帮助启动通过，LLD20；SHA256 `95bb9a35cd712e70cc204e27d0ac67708cda6e8f7e4bd9a30f92946daf95dd27`，已部署新隔离环境及E74正式环境。真实Worker网关未知场景仍待验。E68手机旧任务曾误记524为stopped，本轮未篡改、未据时间认定停止、未重试原生成。 |
| E71 | `node .run/run-chat-voice-e2e.cjs speech-text`，通过`build.sh --test-e2e`运行`TestChatSpeechTextRealSynthesis` | PASS，3.43s。真实Go媒体适配器→隔离转发→原Qwen引擎，观测实际TTS input精确等于文本处理结果：编码标签保留为可见文本、Markdown转义和实体正确解码、自动链接保留地址。实际WAV395564bytes/8240ms，上游200并完成，无模拟合成。日志`.run/chat-speech-text-real-20261117.log`。仅证明共享媒体合成路径，不扩大到默认朗读的独立租户模型配置。 |
| E72 | `node .run/chat-planning-recovery.cjs playback` | PASS。复用任务`0903092135d94ad5804a03e17b7c2ec8`，新增真实Worker语音`635e32c9834748469ffdb042b3b2f2bb`；两条真实回答在1440×1000及390×844完成第一条→第二条→第一条播放切换，每次仅一条播放，最后全部暂停，观察期零生成POST、零页面异常及无横向溢出。日志`.run/chat-two-message-playback-real.log`；两视口截图`.run/chat-two-message-desktop.png`、`.run/chat-two-message-mobile.png`已人工查看。手机截图仅显示当前滚动区，互斥结论来自两播放器运行断言。 |
| E73 | `node .run/repair-chat-media.cjs rerank` | PASS，正式部署前及重启后均从`docker-ragflow-cpu-1`真实调用`host.docker.internal:8082/v1/rerank`；北京答案index1得分7.205，另两项负分。系统`/api/v1/searchbots/retrieval`显式启用原重排模型，返回5条知识片段，调用期间重排进程日志新增16次实际候选推理。证据`.run/reranker-current-real-20261117.json`（最后一次UTC11:27:59）。初次验证脚本误期待HTTP访问日志，而服务只输出slot推理日志，故该检查失败；核对真实日志格式后按原E45的16候选推理口径通过。未关闭重排或修改模型。 |
| E74 | `.run/repair-chat-media.cjs`的`deploy-preflight`、`deploy-config-check`、`deployment-verify`、`retry-deployed-voice`、`restart-deployed`；仅`compose up -d --no-deps ragflow-cpu` | PARTIAL：正式上线及重启子项PASS，正式全验收未完成。预检聊天活动/unknown/资源租约/活动摄取均0，私有备份数据库5306136bytes、配置及旧二进制；配置差异仅Worker开关true及版本化Go二进制挂载，入口/命令/镜像及其他挂载未变。API/ingestor/Admin/Syncer实际进程哈希均为E70构建；创建环境Worker开关持久，心跳有效。初次正式语音`b38a69811bee4c37b5fe169752f01b8d`文字成功但TTS连接失败：宿主守护脚本在Compose重建短暂停止时退出并关闭媒体。修复`watch-local-qwen.ps1`，连续不可用60s才按项目退出清理；语法检查及实际应用重启通过，四个媒体引擎/转发进程身份保持，语音/音乐health正常。只补音频任务`e6d9c9cfb2a146dfb963d9eefc7b0eca`成功，单次音频attempt，旧任务不变。重启后四模式哈希及E73重排复核通过。证据`.run/chat-production-preflight-20261117/summary.json`、`config-check.json`、`.run/chat-production-deployed-restarted-20261117.json`、`.run/chat-production-restart-20261117.json`、`.run/chat-production-voice-retry-20261117.json`。旧版本备份保留，尚未实际回退演练；重启后的新生成、正式图片及权限预算/取消恢复矩阵待验。 |

### E63～E65 阶段审查交接

- 本小批次代码改动集中在`internal/service/chat_media.go`的`ChatSpeechText`及`internal/service/chat_media_test.go`，前端仅补`web/src/hooks/use-speech.test.tsx`的跨消息互斥测试。生成语音、默认朗读入口和歌词继续使用同一个Go文本策略，没有新建后端路径。AST用例覆盖原8项及新增的嵌套引用/代码、引用式链接、自动链接、软硬换行、转义/实体、转义实体、编码标签、纯非正文输入。
- 已实现并测试：E63文本边界修复、E64不同消息互斥单测、E65独立构建与启动入口。新源码尚未部署；未用单测替身代替真实集成，未将E58的旧部署真实语音证明当成E63修复后真实合成验收。E57仍只证明同一回答两入口的真实浏览器互斥。
- 仍待真实验收：不同消息之间的桌面/手机播放互斥、新文本策略传入真实合成的内容核对。现有夹具没有两条已提交音频回答可直接复用；未伪造消息/媒体资产或为本批重新生成。R22/T45保持未完成，E59连接失败结算防护亦未部署。
- 本批未改变供应商、权限、预算、健康表、unknown租约或服务配置。隔离planning、完整启停/回退、Worker重启持久性及其余R/W/T限制保留；全仓类型检查仍按E62归因，不声明通过。本小批次收尾后按用户要求暂停，等审查反馈再继续，不标记整体目标完成。

### E62 类型检查的直接归因

最新检查日志仍为2026-11-16 06:50:22 UTC的32项诊断；本批没有修改前端业务源码、编译配置或依赖。本次读取错误附近调用及直接声明，区分当前类型冲突和历史基线证明：

| 数量 | 当前直接原因 | 声明与调用位置 |
| --- | --- | --- |
| 21 | TS6133，局部参数、变量或导入未使用 | editor、admin、agent、dataflow-result、dataset、memory、next-searches中的日志所列位置；不依赖聊天媒体响应字段是否变化 |
| 1 | `types?: string[]`传给要求`JsonSchemaDataType[]`的下拉框 | `agent/form/components/query-variable.tsx:68`与`select-with-secondary-menu.tsx:58`；变量筛选hook也接受string数组，不是聊天模型能力字段 |
| 4 | `getType`可能返回undefined，但下游要求string | `list-operations-form/index.tsx:105`及`variable-assigner-form/dynamic-variables.tsx:147,174,292`；来源`agent/hooks/use-get-begin-query.tsx`的`getItem()?.type`/结构化类型查找，消费者为`getArrayElementType`、`QueryVariable.types`及`buildLogicalOptions` |
| 2 | `params.inputs`为any，reduce的累积参数及解构key缺少上下文类型 | `agent/utils.ts:812`的UserFillUp分支；同处虽然给初始值断言Record，any接收者仍使回调参数缺少类型 |
| 1 | 表格动态索引产生string/number/boolean/消息数组/undefined联合，renderer只收string | `agents/agent-log-page.tsx:376`及其本地columns；索引来源`interfaces/database/agent.ts`的`IAgentLogResponse` |
| 3 | 数组/文本结果类型未收窄、数组value传给文本容器、空结果分支缺少params | `dataflow-result/components/parse-editer/index.tsx:36,53`及`dataflow-result/parser.tsx:117`；直接契约为同目录`interface.ts`的`FormatPreserveEditorProps`/`IJsonContainerProps`/`IObjContainerProps` |

上述是当前源码可验证的直接来源，不是整仓干净基线的对照实验。尤其agent共享类型可能另有在途改动，不能仅凭报错行在HEAD存在就把所有诊断判成历史问题；W00仍保留最终基线归因限制。没有为清零这些诊断扩展修改agent、共享UI或编译约束。

### E58 当前媒体恢复的证据与边界

- 本批先核对而非覆盖E45～E57。9380、8082和本机18880/18881已恢复监听；正式媒体Worker通过原容器内ingestor恢复。固定音色及图片模型未更换，没有把测试转发器当正式上游。
- 正式旧任务`2f23b67ed63a4673892ad66cb408fa91`为`partial_succeeded/audio/upstream_result_unknown/calls2`，TTS attempt `b5dc3fab53e041a594e7420326ba94e0`于2026-11-17 04:29:25.823～04:29:25.865 UTC结束，目标为本机18880。唯一`speech.exe` PID11404于04:33:32.300 UTC全新启动；可执行路径、监听PID、supervisor记录和“Started speech”日志一致，先前进程不再存在。此服务为进程内本机引擎，不是外部异步队列；确认旧执行无法继续后才运行现有维护命令。证据`.run/chat-media-tts-stopped-20261117.json`仅含安全字段。
- 维护命令使用当前已部署的Go二进制、明确task ID和证据标识；输出`.run/chat-media-tts-reconcile-20261117.log`。核对后该任务state/stage/error/calls及input/output哈希不变，upstream改为stopped，epoch1→2、revision10→11，目标租约归零，attempt为failed/operator_confirmed_stopped，追加seq11的`upstream_reconciled`事件。结果`.run/chat-media-tts-reconciled-20261117.json`。未通过原始SQL删除租约；未触碰隔离库两条外部unknown任务。
- 新任务实际使用原聊天模型及Serena，规划5.312秒、TTS1.095秒，各一次成功。资源`43638deb012e48f2aacc951312329ce0`，2160ms、WAV103724字节，SHA256 `dba20258fb0f765e653cbb9cb4ded99d0ed69997c4a992be0b6a8f07106fcc19`；本机speech日志确认实际POST200及2.16秒音频。任务及attempts见`.run/chat-media-repair-voice.json`。
- `.run/chat-media-repair-browser.json`于05:02:52 UTC记录四项真实页面检查；1440×1000及390×844均刷新回读，语音播放进度前进、暂停、下载原字节。图片复用E50资源，PNG6867577字节、2048×2048，SHA256 `0971f0dfb52f7668d0c2233d0a32e7258706cff8d9c5a13cc92fa29ffe4d2ea6`。没有为浏览器重复生成；没有新增本批生图生成验收的说法。
- 当前恢复不等于重启持久性已验收。`docker/.env.local`及`.cache/compose.local-startup.yml`已启用Worker，但现有容器Config.Env未应用；Docker直接restart不会重新读取它们，且宿主语音/音乐依赖原项目启动入口。未为修复界面分组擅自重建正式服务。完整项目启停、planning、身份变更及组合流程仍未通过。
- 本批收尾只读复核：8082、18880、18881的`/health`及9380的`/api/v1/system/healthz`均HTTP200；正式容器ID/启动时间/重启次数仍与E60一致。E58～E62证据行唯一、文档代码块闭合；两个文档及两个Go文件`git diff --no-index --check -- /dev/null <file>`无空白错误，因新增文件差异退出1并有LF/CRLF提示，不误记为退出0。此检查不替代真实生成及检索证据。

### E56 浏览器缓存与权限边界

- 新增真实浏览器脚本`web/e2e/chat-media-access.cjs`，复用既有私有启动器的`access`入口和现有隔离环境；只临时停用本测试聊天及另一个测试身份在资源租户中的普通成员关系，恢复使用条件更新并断言恰好一行。测试账号在自己的租户中仍为有效owner。没有删除账号、任务、资源或租约。
- 原图SHA256为`68a5ea7faae8fc81f20c5b4dd8fc930d82936bd50449ca5dc089de0dafd367f9`，音频为`00ca30ca8fe1615ed09c13289656c509a3cd2cf0167ea3861601d61110121ace`；两视口恢复权限后的读取均与原值一致。日志`.run/chat-media-access-real-browser-e2e.log`在权限恢复成功后才输出`pass:true`；截图`.run/chat-media-access-desktop.png`和`.run/chat-media-access-mobile.png`展示被拒绝后的下载反馈。
- 此处验证的是后续读取、播放及下载均重新鉴权，已经交付浏览器的图像字节不会被追溯收回。普通HTTP缓存请求和应用中的音频blob都不能使后续访问成功；不把此项扩写为全部格式、配置上限或所有跨租户操作的验收。
- 前两次分别在权限修改之前因脚本选中同轮次的用户消息、计数查询误用`calls_used`而退出；核对真实响应和实体后改为助手角色与实际`calls`列。不是产品故障或模型失败，未降低断言；最终真实流程退出0。本轮无Go或业务前端变更，复用既有包级证据，未重复生成或全仓构建。

E55文档检查：Node只读核对源码配置名与手册表格，30项完整且唯一；代码块闭合，R28/W10/T48及E55编号数量/唯一性通过，退出0。三个文档仍为工作区既有untracked文件，使用`git diff --no-index --check -- /dev/null <file>`逐个检查，无空白错误输出；no-index因新增文件差异退出1，并有Git的LF/CRLF提示，不将其记录为退出0。没有业务代码/依赖变更，复用E52/E53而未重复模型生成或全包测试。

### E53 当前公共路径的补验边界

- 清理：真实MinIO对象在unknown任务下保留；测试自有、未发上游请求的夹具明确置为stopped后，用隔离MySQL触发器拒绝清理完成记账。物理删除已成功、事务回滚后保留deleting/removing fence，新引用被拒；恢复后重试完成，重复清理不变。暂存孤儿为状态构造，不是Put后实际SIGKILL验收。
- 分发：未发布受理及领取租约自然过期由真实scan恢复；NATS发布成功后SQL记账故障导致重新唤醒，两次终态唤醒均ACK且不执行；关闭真实连接使ACK失败，broker重投同一序号，状态/calls/attempts/events不变。没有覆盖全部生成后提交前的实际进程崩溃。
- 竞争：完成先提交1次、取消先提交1次、并发20次，均只有一个终态事件，已保存文字/引用/答案版本不变；同正文不同引用/媒体的答案版本竞争只有一个写入成功。此为后端真实数据库竞争，不替代双标签页浏览器操作。
- 事件：208条分3页按序读完；未来游标及持久化事件缺口重置到权威快照，负游标拒绝，跨租户和会话撤权访问拒绝。未覆盖前端长列表删除同步或浏览器媒体缓存撤权。

### E48 本机音乐恢复

- 旧启动逻辑不能正确接管已存在的speech进程并补起缺失音乐引擎。本批调整 `watch-local-qwen.ps1`：逐引擎核对可执行路径、Serena/语言/设备/模型参数及端口归属，独立复用或启动；锁文件避免重复supervisor。记录PID/启动时间，项目容器停止后只结束匹配归属的进程；`start-local-project.ps1`用该锁判断supervisor是否运行，并检查music健康。启动日志确认复用speech18604、只新增music5908；两端口实际监听127.0.0.1，未改Serena音色。
- 首次提交在创建会话时返回404：E46默认验收聊天已删除。未恢复或覆盖该聊天，脚本改用独立singing状态文件，新建验收聊天 `dfa79408d5ea455c9004e0e4f8aca0ba`，保留原语音/图片证据。没有重复提交已受理任务。
- 真实任务 `a007c4d2378644afa4733a1fc5805c01`，最终 `succeeded/music/stopped/calls=3`；规划模型 `102e9861e4e24a73abb7cff80df6c52e`、Serena参考TTS、ACE-Step各一次且均成功，上游job `7c7c047ea7ee0974`。服务器日志确认VAE解码480000帧/48kHz/10秒并完成job；资源 `85f86a2b208b4d298cd25bc6d8271132`，duration_ms=10000。任务/attempts/安全诊断证据 `.run/chat-media-repair-singing.json`。
- `.run/chat-media-repair-singing-browser.json`：1440×1000、390×844均刷新后播放进度前进、暂停、下载字节SHA256一致；音频1920044字节，SHA256 `de2b00e0568ac4ac6c38fd6cf55acac942e000fff52b1005b559c7f7aa688678`，无页面错误/横向溢出。复用同一生成资源，未为浏览器重复生成；截图 `chat-media-repair-singing-1440.png` / `chat-media-repair-singing-390.png`。
- 本批无Go/前端业务代码或依赖变更，未重复无关全量测试。启停脚本语法通过，运行仅验复用/补起分支；完整停止/重新启动分支仍未验。自动化未判断唱歌音色/歌词的人工质量，隔离planning及身份/组合验收未被此正式环境成功替代。

### E46 正式媒体 Worker 恢复

- 2026-11-16，Asia/Shanghai：重排8082及语音18880健康正常；正式 ingestor 未带媒体 Worker 开关，`chat_task_worker`为0，能力接口返回“当前工作空间没有可用的媒体 Worker”。这与历史隔离库 planning/calls=0 属不同故障。
- 本地持久配置 `docker/.env.local` 增加 `RAGFLOW_CHAT_WORKER_ENABLED=true`。当前容器未重建：确认 `task`/`document` 无在途摄取、Worker无有效注册，按PID及父entrypoint核对归属，依次TERM原 supervisor75/ingestor479并等待退出，再用同一容器内原entrypoint仅启动 ingestor，显式启用 Worker。API/admin/syncer未停止，原二进制未替换。恢复记录 `.run/chat-media-worker-recovery.json`。
- 新验收聊天 `aa78445dd80a4ae495f00cf68955a7fc`：语音任务 `476b50d365a445279bae3bdb70a600a7` succeeded/audio/calls2，规划和TTS各一次；资源 `4f9c6dd29dd449be93a3711a2ef93839`，WAV96044字节/2000ms。图像任务 `fb72945d68b14e759a4045948b06dc91` succeeded/image/calls2，规划和图像各一次，资源 `3d96889fac364d30a2185f29b5592ab7`，PNG6640695字节/2048×2048。任务详情及attempts分别见 `.run/chat-media-repair-voice.json` / `chat-media-repair-image.json`。
- `.run/chat-media-repair-browser.json`：真实正式页面/鉴权资源，在1440×1000及390×844各刷新一次；语音实际播放进度前进、暂停、下载SHA256一致，图像实际解码尺寸一致，页面无横向溢出、无pageerror。语音SHA256 `20e35372ad3119971e277dda7cf62109a5284c2320e61f3b0eb82816b99aecc0`，图像SHA256 `e388738d6d571a42e6b5c55eae65cddfc120ffff19c061647046d3205e8b0a97`。未为播放/下载重复生成。
- 先前最近聊天 `98246c223f184c3799c639b4e817f2ed` 已被标记删除，GET正确返回404，未恢复或改动它。仅复用其模型ID `994d9335e04011f19ecb5a415238eec1`（gpt-6.1-sol）另建新验收聊天；任务 `4d090bcbabcf442d9aa98f633e03b494` succeeded/audio/calls2，Serena音色未改，WAV2080ms，证据 `.run/chat-media-repair-voice-user-model.json`。没有将另一模型的通过冒充该模型通过。
- 本批未改Go/前端实现，未运行无关联的全量构建或历史生成矩阵。固定音乐端口18881仍连接拒绝；能力接口可用不等于音乐上游已就绪，本批不声明音乐恢复。

### E47 Docker 本机测试环境整理

- 多出的容器来自既有日志/发布/回退验收，原本没有Compose项目标签；6个临时副本均在运行，但其restart policy实际为`no`，不能归因于自动重启策略。整理前隔离库非终态任务数0，builder只有空闲tail进程。
- 本机唯一测试Compose清单 `.run/chat-test.compose.yaml`（包含本机私密环境值，不提交/展示内容）。常规启用：`docker compose -f .run/chat-test.compose.yaml up -d`；查看：`docker compose -f .run/chat-test.compose.yaml --profile acceptance ps -a`。六个验收副本保留原名字/入口/模型路由配置并归入`acceptance` profile，默认不启动，原验收脚本仍可按原容器名使用。
- 首次就绪检查过早触发fetch失败，自动恢复全部原容器，生产未变；没有原样重复，加入有界真实API/依赖就绪轮询后再执行并通过。成功备份 `.run/chat-container-backup-2026-11-16T12-46-24-036Z` 保存原inspect、标准输出/错误日志及停止后的NATS数据。配置快照含凭据，仅保留本机，不复制入报告。
- 原MinIO、Kvrocks匿名卷作为external卷直接复用；原NATS数据仅在容器可写层，停止后复制到新external持久卷，329个文件逐一校验SHA256一致再启动，副本容器只在新组健康且生产指纹一致后移除，没有使用`rm -v`或`down -v`。保留失败尝试的备份和卷，不做批量清理。正式MySQL和隔离schema未迁移，unknown租约未改。
- `.run/chat-container-consolidation.json`保存最终分组/启停及保护证据。保留正式现有Compose组、共享Ollama、构建容器及归属未确认的停止容器；未为界面分组重建生产服务。后续验收若新建临时副本应复用该清单，避免再次散落。

### E45 重排恢复与审核交接

本批按用户最新要求只处理重排，完成后暂停，等待其 AI 检查；未继续 planning、组合任务或供应商身份场景，也不因此更改 R/W/T 的总体状态。

- 故障现场：9380正常，8082无监听、无 llama 进程，也不存在对应重排容器。原有 `.cache/llama-windows/llama-server.exe`、`bge-reranker-v2-m3-FP16.gguf` 和密钥均仍在。11月14日旧日志记录过成功加载和推理，但没有可确认的退出原因，不能将历史进程停止归因于本轮模型路由改动。
- 已确认的启动缺口：`tools/scripts/start-local-project.ps1` 之前只拉起 Docker 和语音/音乐，遗漏独立的重排服务。2026-11-16 19:35用原入口启动成功，PID20740，监听 `0.0.0.0:8082`。无需改端口映射，后端通过 Docker Desktop 的 `host.docker.internal:8082` 访问宿主进程。
- 配置核对：现有 VLLM / `local-bge-reranker` / `bge-reranker-v2-m3` 模型和实例均 active，持久化模型ID为 `54b3e07f096e4b008cd789a563fd06ec`，实例地址 `http://host.docker.internal:8082/v1`；本地密钥与已保存实例密钥一致。未重建供应商、改密钥、改模型清单、关闭重排或设置失败降级。
- 真实容器直连：2026-11-16 19:38:09，从实际 Go API 所在的 `docker-ragflow-cpu-1` 发请求。问题“中国的首都是哪里？”，三个输入依次为香蕉、中国首都北京、法国首都巴黎，`top_n=3`；结果顺序 `[1,2,0]`，所有分数有限。认证只经标准输入在内存中传递，不写日志。请求及响应：`.run/reranker-recovery-direct.json`。
- 真实检索：19:38:52～19:38:59，从同一后端容器调用实际 Go `/api/v1/searchbots/retrieval`；使用已存在知识库 `66ff4d9d5ff748af8e83080bd7482f04`，问题“铁路安全管理条例中铁路安全管理的基本方针是什么？”。请求明确传入上述 `rerank_id`、`rerank_candidates_count=16`、`size=5`、`top_k=128`，沿用搜索应用阈值0.1、向量权重0.5。API成功，非空结果5条，最高综合分0.6866730764；本次请求前后截取的 llama 日志包含16条 `stop processing: n_tokens=...`，task6～21均完成，证明真实候选推理。未将无候选或纯检索当作重排成功。完整安全请求、结果ID/分数和该时间窗日志：`.run/reranker-recovery-retrieval.json`。
- 保存的搜索应用 `0836214c6cc4440eaeb45dc5d51e964c` 在本批之前没有启用重排，本批未修改它；验收通过的是请求显式启用重排的真实知识检索，不能声称所有普通搜索或聊天已默认启用。证据中的 `savedSearchConfigUnchanged=true` 按解析后的 JSON 结构比较。
- 持久修复：将原缓存启动实现收敛到可审核的 `tools/scripts/start-local-reranker.ps1`，删除旧缓存脚本，复用原模型、运行时、密钥和推理参数。新入口使用独占文件锁防重复操作，以PID、可执行路径及UTC启动时间记录归属；接管既有进程时额外检查模型、密钥文件、别名及监听参数。启动须通过健康检查、认证模型列表和监听PID检查才成功；不替换未知8082进程。项目启动调用该入口并纳入重排健康检查，项目停止调用其 `-Stop`，仅停止归属核对通过的进程。
- 实测边界：三个脚本语法解析通过；连续两次执行新重排入口都复用PID20740，没有重复进程；只读复核模型仍就绪、8082仍监听。运行记录在 `.run/reranker-recovery-lifecycle.json`。尝试停止/重新拉起验证时，自动审批在执行前拒绝了整条命令，返回 `blocked by policy`，未给更具体原因；未重试停止操作、未绕过审批。故新脚本的停止及无进程时重新拉起分支仅已实现/静态检查，未真实验收，完整项目启停也未执行。
- 服务保护：生产 `docker-ragflow-cpu-1` 的启动时间始终为 `2026-11-15T03:16:48.058545174Z`，重启次数0；隔离 API/ingestor 分别保持 `2026-11-16T10:23:21.510291067Z` / `2026-11-16T10:23:22.707332463Z`、重启次数0。未执行项目整体启停、未替换Go二进制、未修改数据库配置/资源租约/健康表。本批没有Go或前端改动，无需重跑既有Go构建及媒体生成矩阵。

E05 早于组合 `stage_incomplete` 修复：它证明当时语音路径；组合修复以 E01/E06/E08 及 E12 为证。E21 是 E19 幂等修复和最新音频组件之后重新取得的完整语音闭环证据。E23/E24 只新增 e2e 测试及隔离启动包装器，未修改生产实现；不能据此声称重跑了全部组合或路由矩阵。后续相关实现修改后必须增加适用证据。

E25复用E22已真实生成并持久化的旧图编辑会话；检查任务、历史答案资源、父子ID、实际图像下载字节及客户端交互，不伪造媒体资产，也不再次调用生图服务。E26首次测试运行的导入转换失败在最终日志前的终端记录中；调整测试代码后最终15项通过，未删测试或降低断言。

原有失败保留记录：较早 `chat-go-test.log` 两个图片测试失败，随后修复并在 E01 通过；音乐等待首次因测试地址漏 `/v1` 返回 404，修正后通过。任务中心真实浏览器暴露分页先于授权过滤的缺陷（8/10），E15/E16 修复验证，未降低分页断言。正式迁移前新增 scheduling_class 缺列导致500，隔离 `--migrate` 后 E14 通过（`chat-scheduling-health-migrate.log`）。强杀测试最初错误期待同步TTS为 running；实际 ReserveCall 在没有上游任务ID时标记 unknown，测试按契约修正，保留旧失败日志。全仓 type-check 尚未通过；最新结果单独记录，不宣称全部与本任务无关。

新增失败及决策：`.run/chat-idempotency-initial-e2e.log` / `chat-idempotency-reproduced-e2e.log`真实复现相同请求误冲突。请求哈希现排除服务端收件时间及轮次ID；显式作用域幂等键决定身份，默认键仍含session/turn；正文、附件顺序、模式、模型和安全选项仍参与冲突校验，E20证明异内容拒绝。`.run/chat-pending-quota-reproduced.log`是测试屏障错误地要求两事务同时越过维护锁，导致1205/超时，不能当作产品配额缺陷；修正屏障后E22通过，未降低上限断言。E30 是最终相关前端改动后的最新全量 `tsc --noEmit`：仍有32项，分布于admin、agent、agents、dataflow-result、dataset、editor、memory、next-searches模块；E34定向验证涉及的聊天多模态文件无诊断。是否受共享类型改动影响仍需归因，不能宣称全仓类型检查通过。

E35 首次复跑时任务因隔离用户资源和媒体设备均满额，在 `language_queued` 以 `budget_exhausted` 结束；未释放租约。随后只临时提高隔离 schema 中该用户及设备各1容量并重跑，原有 lease 的 resource/task/epoch 完整一致且容量已恢复，但任务仍于 planning 阶段 `upstream_unavailable`、calls=0 失败。故当前真实规划模型/服务是组合 E2E 与供应商身份 E2E 的阻塞，不是组合分支验收通过；不得通过删除未知租约、清空模型健康状态或改断言绕过。

E23 首次失败记录保留在 `.run/chat-snapshot-revocation-e2e.log` 和 `.run/chat-snapshot-revocation-capacity-e2e.log`：前者错误假设隔离用户没有既存租约，后者把模型名称与持久化模型UUID比较。测试改为仅占用剩余容量、仅删除本测试租约，并逐attempt核对原TenantLLMID；未改生产实现或放宽模型身份检查。既存unknown任务`c2ffd2cc650544588816350ae0e90526`未因测试被释放。E23真实边界为`running/*_queued`且calls0、无执行租约，尚未覆盖音色配置变动、模型专属撤权及外发策略。最新实现与单测已将供应商身份变化分类为`provider_identity_changed`；E29 定向复验因隔离用户容量已满而未进入场景，故该专用错误码仍缺最终真实E2E证据。

## 本轮十项审查处置

| 问题 | 当前实现与相关文件 | 最新适用证据 | 剩余限制 |
| --- | --- | --- | --- |
| 1 引用/清理竞争 | `internal/dao/chat_media.go` 统一排序资源行锁和锁内状态检查；`internal/service/chat_task.go` submit/retry、`chat_media_migration.go` 遵守锁协议；deleting/deleted 拒绝引用，删除事务外且 fencing | E22；submit/retry/migration 各 reference_first / cleanup_first / race：引用赢则 committed/refs1/真对象存在；清理赢则拒引用/deleted/refs0/真对象消失，无 deadlock/悬空引用 | 已测 MySQL，PostgreSQL 未运行；不是无限压力证明 |
| 2 恢复/等待 | `internal/dao/chat_task.go` 区分未调用、stopped 完整且 calls 匹配的 checkpoint、unknown；Defer 保持 running；Claim 区分首次 queue_timeout / 总 deadline_exceeded，有输出保留 partial | E17/E22/E23/E24；stopped恢复、旧epoch拒绝、实际SIGKILL后unknown隔离、资源等待继续执行、执行中及完成后重投不重放 | 尚未覆盖 publish/claim/generate/ACK 全部实际故障边界 |
| 3 音色检查点 | `internal/service/chat_media_music.go` 同任务 `voice_reference` 资源和检查点持久化、鉴权复用 | E11、E13、E15；服务层三次等待 TTS1，完整 Worker 唱歌失败/重试 TTS1/music1 | 唱歌音色人工质量未验 |
| 4 首次文字引用 | `chat_media_combined.go` 首次 commitText 一并保存 reference/prompt/usage/elapsed_ms/版本 | E01、E06/E12及`.run/chat-task-statistics-final-combined-e2e.log`：三种首分支成功/失败矩阵，刷新后仅重试失败阶段，真实调用次数及旧资源ID/终态不变 | 组合路径专门的桌面/移动浏览器验收仍未取得 |
| 5 图片父关系/版本查看 | `chat_task.go` 候选ParentID与实际UsePreviousImage分开；编辑图父版本按钮定位实际历史消息；父图选择编辑仍使用所选ID | E01；真实旧图编辑、多参考SHA256顺序/尺寸见`.run/chat-image-selected-parent-fixed-e2e.log`；桌面/手机导航、编辑目标、下载哈希见E25 | 自动化不评价图像语义质量；导航以Chromium为证 |
| 6 播放/读取 | `web/src/components/chat-media-audio.tsx` 播放意图/请求身份/取消隔离；`web/src/services/chat-media-service.ts` 32MiB 有界流读，超限取消 | E18；A先点后返回、旧失败不影响新请求；E21真播放/暂停/下载及手机刷新；E56两视口跨租户/撤权后缓存读取、续播及下载拒绝 | 配置上限真实超限仍待验；不追溯收回已交付浏览器的字节 |
| 7 WAV | `internal/service/chat_audio.go` 统一校验 fmt/data、块/帧边界、格式和合理时长；生成/复用/迁移均填 duration_ms | E01、E04、E05、E07；迁移拒坏 WAV，真实 TTS/音乐可解码 | 仅支持明确白名单格式；不宣称支持所有 WAV 编码 |
| 8 慢清理 | `chat_task_worker.go` 独立单 goroutine、每轮 45s 期限、批量有界，不占 dispatcher | E01、E04；真 MinIO 删除延迟 3s 超过心跳 lease 1s，仍心跳/分发 | 尚无长期存储故障指标/告警验收 |
| 9 错误/重试/路由 | `chat_task_error.go` 稳定分类；`chat_task.go` 服务端 retry_stages/原因；前端只用后端阶段；`chat_route.go` 逐能力候选/权限/策略/费用未知；组合补 `stage_incomplete` 保持未完成分支可重试 | E10/E12/E18/E23/E28；真实双模型备用与共享健康、会话停用和身份变更阻断已验；`provider_identity_changed`实现及单测通过 | E29真实E2E被隔离用户容量阻塞；模型专属撤权/外发/费用对账待做；文字切换不能代替媒体切换验收 |
| 10 协议/真实闭环 | `run-stream.ts`、测试、服务端错误类型贯穿路径；accepted/ok/aborted 明确定义；错误正文不再控制执行，EOF 无 Final 不判成功 | E18/E20/E21；最新幂等实现及音频组件后真实语音闭环 | 全部 T01～T48 未达退出条件，type-check 仍失败 |

## R01～R28

下表按整项需求判断；局部真实 PASS 不自动使整个 R VERIFIED。

| R | 状态 | W | 已有入口/证据 | 未达退出条件 |
| --- | --- | --- | --- | --- |
| R01 | IMPLEMENTED_UNVERIFIED | W01,W04 | run-stream、completion-stream；E01/E02 | 真实断流/全部事件故障 T25 |
| R02 | IMPLEMENTED_UNVERIFIED | W01 | upload hook 顺序/移除/切页单测；真实多附件读取与引用顺序见`.run/chat-attachments-current-real-e2e.log` | 真图片附件发送编号及乱序上传浏览器路径 T02/T26 |
| R03 | IN_PROGRESS | W01,W06 | chat_attachment、file 服务统一处理；E01 | API/UI 逐项缺失/越权/模型能力边界 |
| R04 | IN_PROGRESS | W07 | 历史文本及最终多模态预算；E77真实跨轮旧附件读取；E78必需材料超限零调用拒绝 | T23/T28图片多轮、长历史及其余完整退出条件 |
| R05 | IN_PROGRESS | W03,W04 | E11/E12/E14 文字歌词引用保存及阶段重试，E13 reference复用 | T29 双标签页及新版回答竞争 |
| R06 | IN_PROGRESS | W04 | 模式入口及能力；E05/E06 真实提交 | 全部命令、模式切换和输入回归 |
| R07 | IN_PROGRESS | W02,W03 | E21真Worker持久闭环；E23资源等待后冻结模型/KB/prompt/设置、停用及供应商身份变化阻断 | T31音色配置变动、模型专属撤权仍待验 |
| R08 | IMPLEMENTED_UNVERIFIED | W04 | E15/E16真实任务中心分页/筛选/详情/跳回；E80/E81桌面/手机任务中心执行中及资源排队取消 | 错误/部分成功其余操作矩阵及完整退出条件 |
| R09 | IMPLEMENTED_UNVERIFIED | W04 | E02快照校准、E05刷新；E53后端208条积压分页、未来/缺口游标重置 | T33浏览器重连及长列表删除同步 |
| R10 | VERIFIED | W02,W03,W05 | T12/T34=E20真实并发同键/异内容/阶段重试、E22旧epoch拒绝；T13=E24实际Worker确认执行中及完成后3+5重复消息，外部生成及结果各1 | 已验MySQL/NATS/真实TTS；不承诺外部模型端到端恰好一次，PostgreSQL未运行 |
| R11 | IN_PROGRESS | W03,W04 | E04 旧 epoch/取消迟到拒绝；E06 旧终态不变 | T29/T35 实际取消时序及双标签页 |
| R12 | IN_PROGRESS | W03,W05 | E22 stopped恢复，E17实际kill/unknown隔离，E24实际Worker确认完成后重复消息 | T36 publish/claim/generate/ACK其余边界 |
| R13 | IN_PROGRESS | W05 | SchedulingClass服务端分类、可配PriorityWait；E22双Worker/共享资源及用户/租户受理配额，E13资源等待；E41区分资源等待超时错误 | 持续短任务到达的长时防饥饿回归；真实Worker等待超时终态验证 |
| R14 | IN_PROGRESS | W03,W05,W07 | E11完整Worker唱歌，E12真组合重试，E13参考复用 | T38初次一支成功一支失败独立场景；E35当前二进制复跑被隔离规划模型 `upstream_unavailable` 阻塞 |
| R15 | IN_PROGRESS | W05,W06 | E01期限/统一预算；E07等待不重放TTS；E41区分资源等待上限、总期限与调用/费用预算 | 普通工具副作用恢复审计；真实到期请求计数及T39 |
| R16 | IN_PROGRESS | W06 | 逐能力授权候选/固定媒体边界 E01 | 适配器/前端所有能力契约 T40 |
| R17 | IN_PROGRESS | W06 | E10真双模型fallback/fixed与配置不变；auto单测，媒体明确unsupported；E37健康门禁无候选时返回独立分类且不调用模型（单测） | 真流中断不切换/全候选失败/auto视觉；健康门禁分类的真实任务 E2E |
| R18 | VERIFIED | W06 | E10真实模型及MySQL共享健康：可配窗口/阈值/冷却，400/取消不计故障，12竞争仅1探测，成功恢复 | 窗口逻辑单测由E15覆盖；不代表其他路由需求已验 |
| R19 | IN_PROGRESS | W06 | 模型身份重鉴权、未知费用拒绝、真实固定TTS/music；E23会话停用/身份变更在调用前阻断；`provider_identity_changed`实现和单测通过；E37区分健康门禁无候选与上游失败 | 专用身份错误码真实E2E仍未通过：E34未到资源等待检查点，E35当前隔离规划调用仍 `upstream_unavailable`；E37后尚未复跑；模型专属撤权/外发/费用对账、音色人工质量 |
| R20 | IN_PROGRESS | W02,W07 | 结构化资源及实际父关系 E01；旧图指定续改/两参考图顺序/实际尺寸见`.run/chat-image-selected-parent-fixed-e2e.log`；父版本导航、编辑目标、原字节下载 E25 | 自动化不覆盖提示词遵循及生成视觉质量 |
| R21 | IN_PROGRESS | W02,W08 | E53真实引用竞争、暂存孤儿发现、unknown保护、物理删除后记账失败及重试恢复；E05删除和物理清理 | T44 Put后实际进程崩溃；状态构造不替代故障进程验收 |
| R22 | IN_PROGRESS | W07 | E02/E05/E57播放与复用；E63/E64文本及互斥单测；E71真实TTS输入、E72跨消息两视口互斥；E74正式部署 | T45默认朗读独立模型路径、人工音色及其余完整退出条件 |
| R23 | IN_PROGRESS | W03-W08 | attempts 用量/耗时/原因；E06 失败/部分/成功 | 全指标、清理告警、脱敏日志 T46 |
| R24 | IN_PROGRESS | W01,W07 | WAV、图解码、流式边界 E01/E02/E04/E07；E56桌面/手机缓存撤权及跨租户读取拒绝 | T27全附件安全、T47配置上限真实超限 |
| R25 | IN_PROGRESS | W03,W08 | E03 新 binary help；E05/E06 真隔离 ingestor | 重启/优雅停与 T36/T48 |
| R26 | IN_PROGRESS | W09 | E01～E24局部回归及真实模型/浏览器/故障场景 | 全 T、两轮固定样例/性能/人工质量 |
| R27 | IN_PROGRESS | W08 | E04 实数据 dry-run/execute/repeat/位置变化/坏音频 | 历史完整样例对账和回退演练 T43/T48 |
| R28 | IN_PROGRESS | W00-W09 | 本台账、阶段报告、真实证据索引；E55配置/路由/迁移/unknown运行手册 | 所有 R 最终证据及适用运维演练 |

## W00～W09

| W | 状态 | 已有交付/验证 | 剩余退出条件 |
| --- | --- | --- | --- |
| W00 | IN_PROGRESS | 基线/契约/隔离环境及证据映射 | 全仓类型失败归因、剩余配置核对 |
| W01 | IN_PROGRESS | 流协议/附件处理；E01/E02 | R02/R03/R24 完整输入验收 |
| W02 | IN_PROGRESS | 真实MySQL资源事务/引用E22、同键/异内容及重试E20、执行中/完成后重投E24 | 剩余数据不变量及答案修订竞争 |
| W03 | IN_PROGRESS | E11完整Worker唱歌，E12组合，E21语音，E17取消及kill，E23配置冻结/权限重验 | 其余进程恢复边界 |
| W04 | IN_PROGRESS | E16任务中心分页/筛选/跳回；E14刷新/重试；E18协议 | 游标过期/积压/双标签页 |
| W05 | IN_PROGRESS | E09双Worker/优先级/共享配额/慢清理；E13等待；E17真kill；E31持续到达调度实测复验 | 全故障矩阵及长时间、多Worker持续流量公平性 |
| W06 | IN_PROGRESS | E10真实备用链和共享健康已验，逐能力约束；E37健康门禁分类单测通过 | auto视觉、权限/预算实测；真实任务 E2E 错误分类穿透 |
| W07 | IN_PROGRESS | WAV/播放竞态/组合输出 E01/E02/E06/E07；旧图真实编辑及桌面/手机父版本浏览 E25/E26 | 历史预算与音色质量独立验收 |
| W08 | IN_PROGRESS | 真迁移样例/MinIO清理/新容器 E03/E04/E05；E55参数/路由/迁移/核对说明 | 指标告警、启停/回退及完整历史样例演练 |
| W09 | IN_PROGRESS | 已列证据均可追溯 | 所有 R VERIFIED、全部 T 有完整适用证据 |

## T01～T48

| T | 状态 | 当前具体子场景/证据 | 剩余 |
| --- | --- | --- | --- |
| T01 | PARTIAL | E05 真知识检索/引用 | 普通文字流独立回归 |
| T02 | PARTIAL | `.run/chat-attachments-current-real-e2e.log`：真实多附件读取顺序、引用刷新；缺失对象/伪造归属被拒 | 真单图/多图视觉输入及只附件 |
| T03 | PARTIAL | 上传 hook 重试保持编号 | 浏览器发送与模型实际接收 |
| T04 | PARTIAL | `.run/chat-attachments-current-real-e2e.log`：真缺失对象在零模型调用时失败，伪造归属拒绝 | 真缺失对象的页面反馈 |
| T05 | PARTIAL | E01单测、`.run/chat-route-boundaries-current-real-e2e.log`：能力策略和无合格媒体候选的明确拒绝 | 真视觉自动选择；当前媒体适配器没有合格备用候选 |
| T06 | PARTIAL | E02 正常/业务失败/断流/取消及受理语义 | 真实网络故障 |
| T07 | PASS | E05 文字引用→TTS503→只补语音→播放下载 | 音频人工质量独立评估 |
| T08 | PASS | E01独立图不误建父关系；真实较早底图编辑见`.run/chat-image-selected-parent-fixed-e2e.log`；E25验证父版本导航/尺寸/下载 | 图像生成语义和视觉质量需人工评估 |
| T09 | PASS | 真实base+两附件编辑，核对上游multipart SHA256顺序/最终尺寸见`.run/chat-image-selected-parent-fixed-e2e.log`；E25验证历史资源查看和下载 | 仅覆盖当前固定图像适配器支持格式 |
| T10 | PARTIAL | E11歌词先保存/参考503完整Worker重试，E13三次等待不重复TTS | 唱歌音色人工质量 |
| T11 | PASS | E05 浏览器刷新恢复、播放下载 | 事件积压另计 T33 |
| T12 | PASS | E20显式/自动轮次ID并发提交及终态重放，数据库2行=原任务+阶段重试 | 队列重复投递另由T13/E24覆盖 |
| T13 | PASS | E24真实Worker处理执行中3次/成功后5次重复消息，AckFloor到seq63；TTS1、资源1、回答1，revision/events/outputs/attempts不变 | 进程故障与ACK边界另计T36 |
| T14 | PASS | E17真实SIGKILL/重启/自然租约过期，unknown隔离无重放 | 其他故障边界见T36 |
| T15 | PARTIAL | E10真模型故障备用，E15预算单测 | 任务级实际调用/费用统一核对 |
| T16 | PARTIAL | E01 部分输出禁止切换单测 | 真流中断 |
| T17 | PARTIAL | E01 预算/终态单测 | 真全候选失败 |
| T18 | PARTIAL | E01 候选过滤/严格未知费用拒绝 | 真外发范围组合 |
| T19 | PARTIAL | E07 真设备占用/让出 | 混合排队/多Worker |
| T20 | PARTIAL | E53真实MySQL完成先1次/取消先1次/并发20次；E80/E81桌面/手机任务中心排队及执行取消，迟到音频不改变版本/输出 | 其他用户入口及完整时序退出条件 |
| T21 | PASS | E17真实上游音频已生成但响应在途时删除，迟到无发布/复活，E14删除404 | 缓存权限另计T47 |
| T22 | PASS | E04 引用竞争，E05 真物理清理；E31真实MinIO拒删、MySQL保留deleting fence及退避、拒绝新引用、恢复后完成清理且无悬空引用 | PostgreSQL未运行；非无限压力证明 |
| T23 | PARTIAL | E01历史上下文单测；E77真实第二轮无新附件，重读两份历史随机内容并保留顺序/引用/刷新 | 长历史及其余多模态预算边界 |
| T24 | PARTIAL | E01 权限单测，E05 删除鉴权 | 真跨租户所有操作/事件 |
| T25 | PARTIAL | E02 EOF/JSON/受理断流校准 | 损坏/重复/乱序/缺口全部 |
| T26 | PARTIAL | 上传 hook 顺序/删除/切页单测 | 真页面上传乱序 |
| T27 | PARTIAL | E01 文件/像素/WAV校验，E02超限流取消 | 真越权/注入/逐项反馈 |
| T28 | PARTIAL | 最终上下文预算实现/单测；E78真实上传必需材料超出测试自有2048-token上下文，明确失败且零模型调用 | 图片多轮、系统约束/最新要求保留及其余完整退出条件 |
| T29 | PARTIAL | E05 阶段重试、E01答案条件写回；E04真实MySQL `answer_version_competing_tabs`；E23同正文新引用下迟到语音写回被拒 | 更广的双标签页操作路径及旧任务其它媒体迟到写回 |
| T30 | PARTIAL | E05 voice、E06 image_voice 真实入口 | 命令/按钮全映射/未配服务 |
| T31 | PARTIAL | E23冻结输入；E69新版隔离环境`provider_identity_changed`调用前阻断；E79真实排队后模型/实例停用均零调用拒绝 | 模型专属权限撤销、外发策略及其余子场景；停用不等于全部权限撤销 |
| T32 | PARTIAL | E16真多页/筛选/详情/跳回/后端操作契约，E17删除后total0 | 完整操作矩阵 |
| T33 | PARTIAL | E53真实208条事件分3页、未来/缺口游标重置、负游标及跨租户/撤权拒绝；E02 GET权威校准 | 浏览器重连及长列表删除同步 |
| T34 | PASS | E20真实同键并发/异内容冲突/并发重试及TTS计数；E22旧epoch回写拒绝 | PostgreSQL未运行 |
| T35 | PARTIAL | E17真实上游迟到、unknown占用保留及确认释放；E53后端竞态；E80/E81桌面/手机任务中心执行中/资源排队取消及真实API调用 | 其余入口/队列阶段及完整时序矩阵，正式环境另验 |
| T36 | PARTIAL | E53未发布受理扫描、claim自然过期、发布成功后记账失败重唤醒、真实ACK连接失败重投；E17在途实际kill，E24完成后真实消费ACK | 生成后提交前等其余实际进程故障边界；SQL故障不等同全部宕机验收 |
| T37 | PARTIAL | E09双Worker争GPU/优先级/等待提升，E13三次等待TTS1；E31持续到达调度复验通过 | 长时间、多Worker持续流量公平性 |
| T38 | PARTIAL | E06两支失败后的阶段重试；E68新版桌面场景初次图片失败、只重试图片，保留音频ID及旧终态，刷新播放和下载通过 | E68手机场景已通过规划，生图上游 HTTP 524，仍需补齐手机单分支验收 |
| T39 | PARTIAL | E01统一预算、E07等待不重放；E41单测区分资源等待超时/总期限/调用费用预算 | SDK/并行分支/真实资源等待到期及到期真请求计数 |
| T40 | PARTIAL | E01候选/非法计划/凭据身份/媒体unsupported | 真auto视觉和原尺寸编辑 |
| T41 | PASS | E10真实模型故障/400/取消/共享冷却与恢复，12探测仅1，配置阈值2/冷却17s；E15单测；E37无可用探测资格时不调用模型且分类独立（单测） | 多副本共享DB句柄验证，不宣称所有模型供应商已验 |
| T42 | PARTIAL | E01严格未知价格拒绝/预算事务 | 真费用对账/并发剩余额度 |
| T43 | PARTIAL | E04四历史链接，2合法/1坏/1缺失，位置变动，重复0新增 | 更完整历史样例/回退 |
| T44 | PARTIAL | E53 submit/retry/migrate引用竞争、unknown暂存保护、真实删除拒绝退避恢复、物理删除成功而SQL记账失败后的重试及幂等；E05物理删除 | Put后实际进程崩溃；当前孤儿为状态构造 |
| T45 | PARTIAL | E02 A慢B快/旧catch隔离；E05播放暂停下载；E57桌面/手机朗读复用既有WAV且零合成、两入口互斥、组件卸载时音频URL全部显式释放；E63/E64单测；E71真实TTS精确输入核对；E72不同真实消息两视口播放互斥 | 默认朗读独立租户模型路径、音色人工质量及其余完整退出条件不由本批代替 |
| T46 | PARTIAL | E05/E06 真成功/失败/部分及attempt | 真切换、全指标/脱敏核查 |
| T47 | PARTIAL | E02 no-store/有界流，E05删除后404；E56真图片/音频两视口缓存撤权、续播/下载拒绝及跨租户新鲜/缓存读取404，恢复哈希不变 | 配置上限真实超限；缓存权限子场景已通过 |
| T48 | PARTIAL | E03新二进制启动，E04迁移样例，E05真Worker | 关闭/重启/迁移回退完整演练 |

## E75：正式重启后新语音闭环

`node .run/repair-chat-media.cjs voice user-model`：PASS。正式重启后的新任务`c9d22429937a4ba7be03493257ddf7a0`成功，language/audio各一次真实attempt、calls=2，生成2240ms WAV并持久发布。证据`.run/chat-media-repair-voice-user-model.json`。本项补齐E74“重启后新生成”的语音子项，不替代正式图片、知识引用及其他控制验收。阶段完成时间仍依赖剩余R/W/T与外部生图服务；北京时间11月18日不作为强制通过依据。

## E76：真实Worker网关未知结果保护

- `node .run/run-chat-voice-e2e.cjs gateway`经builder内`bash build.sh --test-e2e -run '^TestChatWorkerRealGatewayUnknown$' -count=1 -v ./internal/service/...`：PASS，6.99s。复用既有隔离API、Worker、MySQL、NATS、MinIO与真实规划/TTS服务；转发器收到完整有效WAV后只向Worker返回524，不模拟被测业务实现。
- 任务`dab3da8cc3d24e6aacd9387a72061d67`最终`partial_succeeded/upstream_result_unknown/calls=3`；音频attempt仅一次并保持unknown、资源租约仍在、无媒体发布，文字包含两项知识答案及引用。直接请求重试被拒，原任务完整快照不变，真实TTS只转发一次。
- 转发器计数证明本次实际合成已完成、响应已释放且无挂起，再经既有`ReconcileStopped`入口核对本任务；租约归零，文字/引用、调用数及终态不变。该明确证据只适用于本测试，不用于释放旧524或旧unknown。
- 修改仅为既有故障E2E及私有转发/启动器；转发器语法、Go格式通过，已按PID/启动时间/脚本路径核对归属后重启空闲测试转发进程，正式应用容器ID/启动时间/重启数未变。首次归属检查因PowerShell日期自动解析后再次字符串解析丢失精度而拒绝，未执行停止；修正为直接DateTime比较后通过。日志`.run/chat-gateway-worker-real-20261117.log`。未修改生产Go代码，无需重新部署或重复全量回归。

## E77/E78：历史附件追问与必需材料预算

- E77：`node .run/run-chat-voice-e2e.cjs planning-history`，通过`build.sh --test-e2e`运行既有`TestChatAttachmentHistoryRealLifecycle`，PASS 9.22s。真实上传两份各含新随机码的文件，第一轮回答不含随机码；第二轮不附新文件，真实模型仍按原上传顺序读出两码、保留知识引用。核对冻结历史描述符及刷新读取一致。任务`2f63e455e5564aa6887beaf1f1c77e73`、`f63f32482bf14ad1a91f89187050c429`。TTS两次按场景预先503拒绝、真实合成计数零，不把该故障注入当语音成功。日志`.run/chat-attachment-history-planning-real-20261117.log`。
- E78：`node .run/run-chat-voice-e2e.cjs planning-context`，同入口运行既有`TestChatAttachmentContextLimitRealLifecycle`，PASS 2.24s。仅测试自有模型克隆配置2048-token上限，真实上传必需材料后，任务`7990295d7e30425f8fc22f8dc9fde08d`为`failed/context_budget_exceeded/calls=0`，无attempt、无答案发布、无TTS请求；没有扩大真实模型容量或修改共享模型。测试退出前恢复测试聊天模型并移除自有克隆配置，原共享模型不变。日志`.run/chat-attachment-context-planning-real-20261117.log`。
- 本批复用既有测试/隔离环境，只在私有启动器增加定向选择，不改业务源码，不重新部署。覆盖T23/T28的具体子项，不替代长历史、图片多轮及系统约束保留等全部退出条件。

## E79：排队后模型与实例停用

`node .run/run-chat-voice-e2e.cjs planning-disabled`，通过`build.sh --test-e2e`只运行既有`TestChatTaskRealSnapshotAndRevocation/model_disabled|instance_disabled`，PASS 11.57s（5.50s/6.06s）。复用新隔离真实API/Worker及数据库；仅用测试自有模型/实例克隆，在真实受理且资源等待后停用，再释放本测试占位。两场景均`failed/unsupported_capability/calls=0`、attempt为0，无TTS请求/媒体发布，冻结输入不变。测试自有占位及克隆按原清理路径恢复，未改共享供应商、模型或旧unknown。日志`.run/chat-model-disabled-planning-real-20261117.log`。此为停用控制，不等同模型专属ACL撤销或全部外发策略验收。

E76～E79收尾只读核对：新隔离库资源租约0；旧两条任务仍unknown、对应租约仍5。TTS控制无挂起/待注入，正式容器ID和启动时间保持E74重启后记录、RestartCount=0。Go格式、私有脚本语法及所改文档`git diff --check`通过（仅LF/CRLF提示）；未执行无关联全仓构建/回归。

## E80/E81：真实任务中心取消时序

- 扩展既有`chat_task_fault_e2e_test.go`，新增`web/e2e/chat-task-cancel.cjs`；复用私有故障启动器、新隔离API19383/浏览器19223和真实Worker。浏览器只从任务中心点击取消，等待真实POST成功及“已取消”界面；桌面1440×1000、手机390×844均无页面异常/水平溢出。未改业务源码、未重建正式服务。
- E80：`node .run/run-chat-worker-fault-e2e.cjs planning-cancel-browser`经`build.sh --test-e2e`运行既有迟到音频测试的新浏览器子项，PASS 30.99s。桌面任务`9c11d154af4a4981ab32120e44a06403`、手机`d179a79e8bc843469ac19fb347637194`，各真实TTS一次；在完整有效WAV已生成、响应仍被原转发器持有时点击取消。终态cancelled，上游unknown时仍有租约；放行迟到响应后版本/输出不变、无媒体发布。计数确认本次合成完成且无挂起后，仅通过既有ReconcileStopped核对本测试任务。日志`.run/chat-task-cancel-browser-real-20261117.log`。
- E81：`node .run/run-chat-worker-fault-e2e.cjs planning-queued-cancel-browser`，PASS 11.02s。仅占用剩余用户资源的测试自有租约，不改容量；等待真实任务`running/*_queued/calls=0`且无执行者租约后点击取消。桌面`f9e86bb12b82485ba3217f7116c36974`、手机`1ba2ba5e8560471ebe844ee0600d35a6`均cancelled/calls=0/attempts=0/media=0/leases=0，无TTS新增调用，无取消/重试权限。释放的仅本测试自有占位。日志`.run/chat-task-queued-cancel-browser-fixed-real-20261117.log`。首次编译因误将API的can_cancel/can_retry当成DAO字段失败，未发模型请求；修正为真实详情API检查后通过，原失败日志保留。
- 收尾：新隔离库资源租约0；旧两条任务仍为failed/partial_succeeded，其上游未知占用合计5未动。TTS转发3/完成3/释放3，无挂起或待注入；正式容器ID、启动时间及RestartCount=0保持E74记录。Go格式、Node语法及浏览器脚本格式检查通过；oxlint仅现有E2E风格的console输出警告。手机截图人工检查正常，最新同名截图为排队取消场景。
- 本批只覆盖任务中心资源排队和实际音频在途的取消，不升级整项R08/T20/T35为PASS；正式环境、其他入口、其余时序及恢复仍需对应证据。另发现既有`.run/chat-task-drain-rollback-real-fixed-e2e.log`含隔离环境实际SIGTERM/旧新版本生成通过证据，但发生在旧构建，不据此认定当前正式版本回退验收完成。

## 最近完成与下一步

最新为E70～E81。正式部署与重启后新语音、重排及E63真实文本/跨消息播放已通过；E76补齐真实Worker网关524保护，E77/E78补齐历史附件与必需材料超限，E79补齐排队后模型/实例停用，E80/E81补齐任务中心桌面/手机执行中及资源排队取消。手机组合524的上游结果仍无法确认，原任务不重试；正式图片、权限预算/取消恢复矩阵、实际回退及R/W/T其余缺口继续。隔离API19383/浏览器19223仍可复用，旧unknown保留。下列暂停及旧阻塞描述均为历史记录，以本段和逐项最新证据为准。

本批最新：E63修复并验证AST朗读文本边界，E64补齐不同消息互斥单测，E65独立构建及API/ingestor启动检查通过。按用户最新要求，阶段说明已更新，本小批次收尾后暂停供其他AI审查；不继续推进剩余优化。新源码未部署，不同真实消息浏览器互斥及新文本策略真实合成核对仍未完成，R22/T45没有升级为通过。

前批E58～E62：新正式语音真实生成和桌面/手机播放下载通过，图片复用E50真实资源。E59连接失败结算防护单测/构建通过但未部署。E60测试组4运行、1退出、6Created；正式Worker持久文件与容器创建环境不一致，重启恢复未验。E62完成32项类型诊断直接来源归因，历史基线证明仍有边界。其余已有证据按适用范围复用，隔离planning及整体R/W/T未通过。

最近完成：十项可靠性修复及真实语音闭环；完整Worker唱歌；组合重试；双Worker优先级/配额；真实双模型备用及共享健康；任务中心分页授权修复及浏览器；实际SIGKILL/取消/删除迟到音频；音频类型错误和认证头防护；并发受理/重试幂等修复与实测；资源等待配置冻结/会话停用/身份变化三场景；真实NATS执行中3次及完成后5次重复投递。

最近新增：E41修复并验证资源等待超时被误分类为 `budget_exhausted`，区分 `resource_wait_timeout`、总期限和调用/费用预算；DAO/service全包回归通过。E43补全 snapshot E2E 的安全诊断并在不可达终态时即时失败，e2e 标签 service 包编译通过，未发生成请求。E44重新核对隔离库与调用链：两个既存 unknown 租约仍占用户资源 `2/2`，健康门禁当前无冷却/探测占用；最近 planning 失败的模型身份、固定策略和 `max_tokens=1024` 均已确认，但旧任务没有 cause/attempts，不能据此锁定失败条件。未释放租约、未扩容、未发送新请求。planning 根因、T38和供应商身份专用E2E仍未验收。

下一步：planning 根因仍未知。E49 的普通成员无法操作租户私有聊天，失败发生在 API 权限入口，未到模型解析/候选筛选/健康门禁/Worker；不再创建账号或重跑同一路径。后续仅复用既有且具备相同模型权限的隔离身份/聊天夹具，再提交一次最小真实规划任务。继续保留未经确认停止的两条 `unknown` 租约、不增扩容量。历史 `calls=0` 仍可能来自模型解析/候选/健康门禁，或回调内 driver/参数校验及 `ReserveCall` 前失败，不能据此判断根因。E46正式环境成功不替代隔离环境验收；只有真实规划检查点通过后，才串行复验 `provider_identity_changed` 和最新组合浏览器流程。其余答案版本/权限竞争、故障边界、迁移回退及32项全仓类型错误归因仍待验；固定媒体适配器无合格候选，视觉/TTS/音乐自动切换保持明确不支持。O01～O05不属于必做范围。

R10、R18已有对应退出条件证据；R20关键用户路径已有新证据，但整项仍按总退出条件判断。G4/W09未通过。约85%仅为历史工作量粗估，不是R/W/T通过率，也不据此承诺剩余工期。剩余验收涉及跨项集成、基线归因和运维回退；没有声称全仓类型检查或所有R/W/T通过。
