# RAGFlow 项目本地启动说明书

当前本机已配置聊天生图和 Qwen3-TTS，使用项目根目录的 `.\tools\scripts\start-local-project.ps1` 启动、`.\tools\scripts\stop-local-project.ps1` 关闭，确保本地语音进程随项目退出。使用方法见 [chat-media-local.md](chat-media-local.md)。

## 0. 给本地 AI 助手的总说明

你现在位于 RAGFlow 项目仓库根目录。你的任务是帮助用户在本机启动项目，并在需要时启动前端开发环境。

请严格遵守以下原则：

1. 先检查环境，再执行安装或启动命令。
2. 优先使用 Docker Compose 启动完整项目。
3. 使用 Docker 启动时，不要默认在宿主机安装 Go、MySQL、Elasticsearch、MinIO、Kvrocks、NATS 或 ClickHouse。
4. 只有用户明确要求“源码编译 Go 后端”时，才执行源码编译流程。
5. 前端改造时，在 `web/` 目录安装 Node.js 依赖并启动 Vite。
6. 不要删除 Docker 数据卷，不要执行带 `-v` 的 `docker compose down`，除非用户明确要求清空项目数据。
7. 不要修改 `docker/.env` 中的密码、端口或数据库配置，除非确实遇到端口冲突或用户要求修改。
8. 项目启动后必须验证容器状态和页面健康状态，不能只看到命令执行完成就认为启动成功。
9. 如果项目已经在运行，先检查状态，不要重复启动或清空已有数据。
10. 如果出现错误，先查看相关服务日志，再根据日志处理，不要盲目反复重启。

推荐启动目标：

```text
浏览器访问：http://localhost/
```

当前项目使用 Go 后端 Docker 部署，`docker/.env` 中的配置为：

```text
API_PROXY_SCHEME=go
RAGFLOW_IMAGE=ragflow:go-local
SVR_WEB_HTTP_PORT=80
SVR_HTTP_PORT=9380
ADMIN_SVR_HTTP_PORT=9381
```

---

## 1. 项目启动方式选择

本项目有三种启动方式。请根据用户需求选择。

### 1.1 方式 A：完整 Docker 启动，推荐

适合：

- 第一次启动项目；
- 只想使用系统；
- 需要启动完整后端和依赖服务；
- 队友刚从 GitHub 克隆项目；
- 不想在本机配置 Go、数据库和搜索引擎。

需要：

- Git；
- Docker Desktop 或 Docker Engine；
- Docker Compose v2；
- 足够的磁盘和内存；
- 能够下载 Docker 镜像。

不需要在宿主机安装：

- Go；
- MySQL；
- Elasticsearch；
- MinIO；
- Kvrocks；
- NATS；
- ClickHouse；
- Python；
- ONNX Runtime；
- C++ 编译环境。

### 1.2 方式 B：Docker 后端 + Vite 前端开发，推荐前端改造使用

适合：

- 用户要修改 React 前端；
- 希望前端修改后浏览器实时刷新；
- 后端继续使用 Docker 中已经启动的 Go 服务；
- 前端开发人员不想每次修改都重新构建 Docker 镜像。

需要：

- Docker；
- Node.js `>=18.20.4`；
- npm；
- Git。

后端通过 Docker 启动，前端通过 Vite 在本机启动：

```text
浏览器访问：http://localhost:9222/
前端开发服务器：http://localhost:9222/
Docker 后端 API：127.0.0.1:9380
Docker 后端 Admin：127.0.0.1:9381
```

### 1.3 方式 C：本机源码编译 Go 后端，不推荐第一次使用

适合：

- 用户明确要调试 Go 后端；
- 用户需要修改后端并重新编译；
- 用户使用 Ubuntu/Linux 开发环境；
- 用户已经准备好 Native 库、模型和 C/C++ 编译环境。

该方式比 Docker 复杂，需要下载 Native 静态库、DeepDoc 模型、Tokenizer 资源，并正确配置 CGO。Windows 原生环境不建议直接采用该方式，Windows 用户优先使用 Docker Desktop。

---

## 2. 第一次启动前需要安装的东西

## 2.1 Git

用于克隆项目。

安装后检查：

```bash
git --version
```

Windows 用户可以安装 Git for Windows。安装完成后可以使用 PowerShell、Git Bash 或 Windows Terminal。

## 2.2 Docker

### Windows

安装 Docker Desktop，并启动 Docker Desktop。必须确认 Docker Desktop 已经完全启动，任务栏中的 Docker 图标处于运行状态。

检查：

```powershell
docker version
docker compose version
```

最低建议版本：

```text
Docker Engine >= 24.0.0
Docker Compose >= 2.26.1
```

当前环境已经验证 Docker Server `29.8.0` 可以使用。

### macOS

安装 Docker Desktop。Apple Silicon 设备使用 Docker Desktop 的 AMD64 模拟能力运行当前 Go Docker 镜像，首次构建和文档处理可能较慢。

### Linux

安装 Docker Engine 和 Docker Compose Plugin。默认文档引擎是 Elasticsearch，Linux 主机需要检查：

```bash
sysctl vm.max_map_count
```

如果结果小于 `262144`，执行：

```bash
sudo sysctl -w vm.max_map_count=262144
```

如需永久保存，可以将下面内容加入 `/etc/sysctl.conf`：

```text
vm.max_map_count=262144
```

## 2.3 Node.js，仅前端开发需要

如果只是使用 Docker 中的生产前端，不需要安装 Node.js。

如果要修改前端，在 `web/` 目录执行：

```bash
node --version
npm --version
```

建议版本：

```text
Node.js >= 18.20.4
npm >= 9
```

推荐使用 Node.js 20 LTS 或更高的兼容 LTS 版本。

## 2.4 Go，仅源码编译后端需要

Docker 启动方式不需要宿主机安装 Go。

只有选择本机源码编译时，才需要安装：

- Go；
- GCC 或 Clang；
- CMake；
- Ninja 或 Make；
- pkg-config；
- PCRE2 开发库；
- LLD；
- Python 3.10 或更高版本；
- uv；
- curl 或 wget。

Go 具体版本以仓库 `go.mod` 中的 `go` 声明为准。AI 不要自行猜测版本，如果用户要编译 Go 后端，先读取：

```bash
Get-Content go.mod -TotalCount 20
```

Linux 源码编译还可能需要：

```bash
sudo apt-get update
sudo apt-get install -y \
  build-essential \
  cmake \
  ninja-build \
  pkg-config \
  libpcre2-dev \
  lld \
  curl \
  wget
```

---

## 3. 克隆项目

用户在目标目录打开终端，执行：

```bash
git clone <项目 GitHub 地址>
cd ragflow
```

如果项目目录名称不是 `ragflow`，进入实际克隆目录：

```bash
cd <实际项目目录>
```

确认当前目录是仓库根目录。应该能看到：

```text
AGENTS.md
Dockerfile
build.sh
cmd/
docker/
internal/
web/
go.mod
```

AI 应先执行：

```bash
git status --short
Get-ChildItem -Force
```

Linux/macOS 使用：

```bash
git status --short
ls -la
```

如果当前目录不是仓库根目录，不要继续执行 Docker Compose 命令。

---

## 4. 方式 A：使用 Docker 启动完整项目

## 4.1 启动前检查

在仓库根目录执行：

```bash
docker version
docker compose version
```

确认 Docker 服务正在运行。

确认 Compose 配置可以解析：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml config --services
```

正常情况下应该包含：

```text
kvrocks
minio
mysql
nats
ragflow-cpu
clickhouse
es01
```

检查配置中的镜像：

```bash
Select-String -Path docker/.env -Pattern "RAGFLOW_IMAGE|API_PROXY_SCHEME|SVR_WEB_HTTP_PORT|SVR_HTTP_PORT|ADMIN_SVR_HTTP_PORT"
```

Linux/macOS：

```bash
grep -E "RAGFLOW_IMAGE|API_PROXY_SCHEME|SVR_WEB_HTTP_PORT|SVR_HTTP_PORT|ADMIN_SVR_HTTP_PORT" docker/.env
```

应重点确认：

```text
API_PROXY_SCHEME=go
```

## 4.2 准备 RAGFlow 镜像

当前 `docker/.env` 默认使用：

```text
RAGFLOW_IMAGE=ragflow:go-local
```

这表示 Compose 期望本机已经存在名为 `ragflow:go-local` 的镜像。

先检查：

```bash
docker image inspect ragflow:go-local
```

如果镜像存在，可以直接启动。

如果镜像不存在，必须在仓库根目录构建：

```bash
docker build --platform linux/amd64 -f Dockerfile -t ragflow:go-local .
```

说明：

- 构建过程可能需要较长时间；
- 首次构建需要下载基础镜像和构建依赖；
- Docker Desktop 需要分配足够的 CPU、内存和磁盘；
- `.git` 目录必须保留，因为 Dockerfile 可能使用 Git 信息生成版本号；
- Windows 和 macOS 使用 Docker Desktop 时仍然可以执行该命令；
- Apple Silicon 设备建议保留 `--platform linux/amd64`。

如果项目维护者提供了可直接下载的官方镜像，也可以把 `docker/.env` 中的 `RAGFLOW_IMAGE` 改成指定镜像。但 AI 不要自行猜测镜像标签，必须使用项目维护者明确提供的版本。

## 4.3 启动完整服务

从仓库根目录执行：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml --profile cpu up -d
```

如果需要确保 CPU Profile 被启用，可以执行：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml --profile cpu up -d
```

当前 Compose 配置会启动：

- Go API；
- Go Admin；
- Go Ingestor；
- Go Syncer；
- Nginx；
- MySQL；
- Elasticsearch；
- MinIO；
- Kvrocks；
- NATS；
- ClickHouse。

Go 容器入口会先执行数据库迁移，然后启动后端服务。

## 4.4 检查容器状态

执行：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml ps
```

正常情况下，所有服务应处于 `Up` 状态，数据库和搜索服务应显示 `healthy`。

重点检查：

```text
ragflow-cpu
mysql
es01
minio
kvrocks
nats
clickhouse
```

如果某个服务显示 `Exited`、`Restarting` 或 `unhealthy`，不要继续判断项目已启动成功，先查看日志。

## 4.5 检查网页

浏览器打开：

```text
http://localhost/
```

PowerShell 检查：

```powershell
try {
  $r = Invoke-WebRequest -Uri http://localhost/ -UseBasicParsing -TimeoutSec 20
  "HTTP $([int]$r.StatusCode)"
} catch {
  $_.Exception.Message
}
```

Linux/macOS 检查：

```bash
curl -I --max-time 20 http://localhost/
```

正常结果应该是：

```text
HTTP 200
```

## 4.6 检查 API 健康状态

推荐检查：

```text
http://localhost/api/v1/system/healthz
```

PowerShell：

```powershell
Invoke-WebRequest -Uri http://localhost/api/v1/system/healthz -UseBasicParsing
```

Linux/macOS：

```bash
curl -f http://localhost/api/v1/system/healthz
```

如果 `SVR_WEB_HTTP_PORT` 被修改，例如改成 `8080`，访问地址要改成：

```text
http://localhost:8080/
http://localhost:8080/api/v1/system/healthz
```

## 4.7 登录和初始化

Compose 文件当前包含：

```text
--enable-adminserver
--init-superuser
```

因此容器启动时会启用 Admin 服务并尝试初始化默认超级用户。

首次启动后：

1. 打开 `http://localhost/`；
2. 进入登录页面；
3. 使用项目当前配置或启动日志中显示的初始化账号；
4. 登录后及时修改默认密码；
5. 不要把默认密码用于公网部署；
6. 不要把 `docker/.env` 提交到公开仓库中的敏感修改版本。

如果登录失败，先查看：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml logs --tail 200 ragflow-cpu
```

---

## 5. 方式 B：Docker 后端 + Vite 前端开发

这是前端改造最推荐的方式。

## 5.1 先启动 Docker 后端

如果后端还没有启动，按照上一节执行：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml --profile cpu up -d
```

确认：

```text
http://localhost/api/v1/system/healthz
```

返回正常后，再启动前端开发服务器。

## 5.2 安装前端依赖

进入前端目录：

```bash
cd web
```

检查 Node.js：

```bash
node --version
npm --version
```

安装依赖：

```bash
npm install
```

项目已经包含 `web/package-lock.json`。如果要严格按照锁定版本安装，可以使用：

```bash
npm ci
```

第一次安装推荐：

```bash
npm ci
```

如果 `npm ci` 因为 lock 文件、Node 版本或本地环境问题失败，再使用：

```bash
npm install
```

不要删除 `package-lock.json`，不要随意升级全部依赖。

## 5.3 启动前端开发服务器

在 `web/` 目录执行：

```bash
npm run dev
```

Vite 默认监听：

```text
http://localhost:9222/
```

项目的 `vite.config.ts` 已经将请求代理到：

```text
/api/v1/admin -> http://127.0.0.1:9381
/api          -> http://127.0.0.1:9380
/v1           -> http://127.0.0.1:9380
```

因此浏览器访问前端开发地址：

```text
http://localhost:9222/
```

不要直接把前端 API 地址改成容器名称，例如 `http://ragflow-cpu:9380`。浏览器无法解析 Docker 内部服务名，应该使用 Vite 代理。

## 5.4 指定前端端口

如果 `9222` 被占用，可以指定其他端口：

PowerShell：

```powershell
$env:PORT=9223
npm run dev
```

Linux/macOS：

```bash
PORT=9223 npm run dev
```

访问：

```text
http://localhost:9223/
```

## 5.5 前端验证

在 `web/` 目录执行：

```bash
npm run type-check
npm run lint
npm run build
```

如果只修改页面样式或文案，至少执行：

```bash
npm run type-check
npm run lint
```

如果修改路由、请求、状态管理或打包配置，建议再执行：

```bash
npm run build
```

---

## 6. 方式 C：本机源码编译 Go 后端

除非用户明确要求，否则 AI 不要自动选择这条路径。

## 6.1 适用环境

官方源码启动说明主要针对：

- Ubuntu 24.04；
- x86_64；
- Linux；
- Docker 已安装；
- 可以下载 Native 构建依赖；
- 可以使用 CGO。

Windows 原生 PowerShell 不适合作为 Go Native 后端的主要编译环境。Windows 用户如需源码编译，建议使用：

- WSL2 Ubuntu；
- Linux 虚拟机；
- 或 Docker 构建。

## 6.2 下载 Go Native 依赖和模型

仓库提供：

```text
ragflow_deps/download_go_deps.py
```

该脚本会准备 Go 后端需要的资源，包括：

- office_oxide；
- pdfium；
- pdf_oxide；
- ONNX Runtime；
- Go DeepDoc 模型；
- OCR 资源；
- Tokenizer 资源；
- `cl100k_base.tiktoken`。

脚本要求 Python `>=3.10`，推荐使用 `uv` 执行。

在仓库根目录执行：

```bash
uv run python3 ragflow_deps/download_go_deps.py
```

如果本机没有 `uv`，先安装 `uv`，或者按照项目文档使用独立 Python 虚拟环境。AI 不要把 Python 依赖安装到系统 Python 中。

下载过程需要网络，并且可能占用较多磁盘空间。网络受限时，可以配置项目支持的 Hugging Face 镜像，但不要修改代码中的下载逻辑。

## 6.3 构建 Go 后端

首次完整构建：

```bash
bash build.sh --all
```

如果 Native 库已经构建完成，只重新构建 Go：

```bash
bash build.sh --go
```

不要默认执行原始 `go build` 或 `go test`，因为项目需要 `build.sh` 配置 CGO、Native 静态库、Tokenizer 资源和链接参数。

## 6.4 启动本地依赖服务

源码运行 Go 服务时，仍然建议使用 Docker 启动数据库、搜索、对象存储、缓存和消息队列：

```bash
docker compose --env-file docker/.env -f docker/docker-compose-base.yml up -d --wait es01 mysql minio nats kvrocks clickhouse
```

然后确认：

```bash
docker compose --env-file docker/.env -f docker/docker-compose-base.yml ps
```

源码运行时，`conf/service_conf.yaml` 需要使用宿主机可访问的地址和端口。不要把 Docker 内部服务名直接写给宿主机运行的 Go 进程。

常见宿主机地址：

```text
MySQL：localhost:3307 或当前 docker/.env 配置的映射端口
Elasticsearch：localhost:1200
MinIO：localhost:9000
Kvrocks：localhost:6379
NATS：localhost:4222
ClickHouse：localhost:9900
```

实际端口以 `docker/.env` 和 `docker compose ps` 为准。

## 6.5 数据库迁移

在本机源码启动服务前先执行：

```bash
./bin/ragflow_server --migrate
```

数据库迁移成功退出后，再启动各个 Go 服务。

## 6.6 启动 Go 服务

需要分别启动：

```bash
./bin/ragflow_server --admin
```

```bash
./bin/ragflow_server --api
```

```bash
./bin/ragflow_server --ingestor
```

```bash
./bin/ragflow_server --syncer
```

每个服务最好使用单独的终端窗口。

源码运行时还需要单独启动前端：

```bash
cd web
npm ci
API_PROXY_SCHEME=go npm run dev
```

PowerShell：

```powershell
cd web
npm ci
$env:API_PROXY_SCHEME="go"
npm run dev
```

不过当前 Vite 配置已经默认将请求代理到 Go 后端，因此前端开发优先使用 Docker 后端方式即可。

---

## 7. 常用操作

## 7.1 查看服务状态

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml ps
```

## 7.2 查看主服务日志

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml logs --tail 200 ragflow-cpu
```

持续跟踪：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml logs -f ragflow-cpu
```

## 7.3 查看某个依赖日志

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml logs --tail 200 es01
docker compose --env-file docker/.env -f docker/docker-compose.yml logs --tail 200 mysql
docker compose --env-file docker/.env -f docker/docker-compose.yml logs --tail 200 minio
docker compose --env-file docker/.env -f docker/docker-compose.yml logs --tail 200 kvrocks
docker compose --env-file docker/.env -f docker/docker-compose.yml logs --tail 200 nats
```

## 7.4 重启主服务

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml restart ragflow-cpu
```

## 7.5 停止服务但保留数据

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml stop
```

## 7.6 停止并删除容器，但保留命名数据卷

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml down
```

这不会删除命名卷中的数据库和上传文件数据。

## 7.7 彻底清空本地数据

只有用户明确确认“清空所有项目数据”时才允许执行：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml down -v
```

该操作可能删除：

- MySQL 数据；
- Elasticsearch 索引；
- MinIO 文件；
- Kvrocks 数据；
- NATS 数据；
- ClickHouse 数据。

执行前必须再次向用户确认，不能自动执行。

---

## 8. 端口冲突处理

默认端口：

| 变量 | 默认端口 | 用途 |
|---|---:|---|
| `SVR_WEB_HTTP_PORT` | `80` | 浏览器访问页面 |
| `SVR_WEB_HTTPS_PORT` | `443` | HTTPS |
| `SVR_HTTP_PORT` | `9380` | Go API |
| `ADMIN_SVR_HTTP_PORT` | `9381` | Go Admin |
| `ES_PORT` | `1200` | Elasticsearch |
| `EXPOSE_MYSQL_PORT` | `3307` | MySQL |
| `MINIO_PORT` | `9000` | MinIO API |
| `MINIO_CONSOLE_PORT` | `9001` | MinIO 控制台 |
| `KVROCKS_PORT` | `6379` | Kvrocks |
| `EXPOSE_NATS_PORT` | `4222` | NATS |
| `PORT` | `9222` | Vite 前端开发服务器 |

检查端口：

PowerShell：

```powershell
Get-NetTCPConnection -State Listen |
  Sort-Object LocalPort |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

Linux/macOS：

```bash
ss -ltnp
```

如果 `80` 被占用，可以修改 `docker/.env`：

```dotenv
SVR_WEB_HTTP_PORT=8080
```

然后重新创建容器：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml --profile cpu up -d
```

访问：

```text
http://localhost:8080/
```

修改端口后，必须使用新的端口进行健康检查。不要只修改 `SVR_HTTP_PORT` 就当作浏览器入口端口；浏览器通常访问 `SVR_WEB_HTTP_PORT`。

---

## 9. 常见问题处理

## 9.1 `Cannot connect to the Docker daemon`

原因：Docker Desktop 没有启动，或者 Linux Docker 服务没有运行。

处理：

1. 启动 Docker Desktop；
2. 等待 Docker 完全启动；
3. 重新执行：

```bash
docker version
```

## 9.2 `pull access denied` 或找不到 `ragflow:go-local`

原因：`docker/.env` 使用了本地镜像名，但本机还没有构建该镜像。

处理：

```bash
docker build --platform linux/amd64 -f Dockerfile -t ragflow:go-local .
```

然后重新启动：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml --profile cpu up -d
```

## 9.3 80、443 或 9380 端口被占用

检查占用进程，修改 `docker/.env` 中对应端口，再重新执行 Compose 启动命令。

不要随意结束未知进程。先向用户说明哪个程序占用了端口。

## 9.4 Elasticsearch 不健康

Linux 检查：

```bash
sysctl vm.max_map_count
```

设置：

```bash
sudo sysctl -w vm.max_map_count=262144
```

还需要检查 Docker Desktop 分配的内存是否足够，以及 Elasticsearch 日志：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml logs --tail 200 es01
```

## 9.5 容器是 `Up`，但网页打不开

按顺序检查：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml ps
docker compose --env-file docker/.env -f docker/docker-compose.yml logs --tail 200 ragflow-cpu
```

再检查：

```bash
curl -I http://localhost/
curl -f http://localhost/api/v1/system/healthz
```

常见原因：

- Nginx 尚未启动；
- Go API 仍在数据库迁移；
- 某依赖服务未健康；
- 端口被其他程序占用；
- Docker Desktop 资源不足；
- 浏览器访问了错误端口。

## 9.6 登录页面能打开，但无法登录

检查主服务日志：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml logs --tail 300 ragflow-cpu
```

确认：

- MySQL 是否健康；
- 数据库迁移是否成功；
- Admin 服务是否启用；
- 初始用户是否创建；
- 浏览器是否缓存了旧页面；
- 访问地址是否使用了当前 Web 端口。

## 9.7 文件上传后一直解析

检查：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml logs --tail 300 ragflow-cpu
docker compose --env-file docker/.env -f docker/docker-compose.yml ps
```

重点确认：

- Go Ingestor 是否启动；
- NATS 是否健康；
- Elasticsearch 是否健康；
- MinIO 是否健康；
- Docker 内存是否足够；
- 文件是否过大；
- PDF 是否为扫描件；
- DeepDoc 资源是否完整。

## 9.8 `npm install` 或 `npm ci` 失败

先检查：

```bash
node --version
npm --version
```

建议使用 Node.js `>=18.20.4`。

如果是网络问题：

- 检查 npm registry；
- 检查代理；
- 重试安装；
- 不要删除锁文件；
- 不要随意升级依赖。

如果是权限问题，不要使用管理员权限反复安装，先修复 Node/npm 的安装环境。

## 9.9 Vite 页面打开但 API 请求失败

确认 Docker 后端已启动：

```text
http://localhost/api/v1/system/healthz
```

确认前端使用：

```text
http://localhost:9222/
```

不要直接使用 `file://` 打开前端源码，也不要让浏览器直接请求 Docker 内部服务名称。

## 9.10 AI 试图安装大量 Python 依赖

如果用户只是想用 Docker 启动项目，停止该行为。

当前 Docker Go 部署不要求宿主机安装 Python。Python 仅在以下情况使用：

- 源码构建 Go Native 依赖；
- 维护历史 Python 代码；
- 执行明确要求的 Python 工具。

## 9.11 AI 试图直接运行 `go run` 或 `go test`

先停止并确认用户是否明确要求源码编译。

该项目需要 Native 库、CGO、Tokenizer 和 DeepDoc 资源，官方项目规则要求通过 `build.sh` 运行 Go 构建和测试，而不是直接运行裸 `go build`、`go test`。

---

## 10. 给 AI 的标准执行流程

当用户说“帮我启动项目”时，AI 应按下面顺序执行。

### 第一步：确认目录

```text
确认当前目录存在 Dockerfile、docker/docker-compose.yml、docker/.env、web/package.json。
```

### 第二步：检查 Docker

```bash
docker version
docker compose version
```

如果 Docker 不可用，告诉用户启动 Docker Desktop 或安装 Docker。

### 第三步：检查现有容器

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml ps
```

如果服务已经全部运行，直接进行健康检查，不要重复构建和重启。

### 第四步：检查镜像

```bash
docker image inspect ragflow:go-local
```

如果不存在，执行：

```bash
docker build --platform linux/amd64 -f Dockerfile -t ragflow:go-local .
```

### 第五步：启动

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml --profile cpu up -d
```

### 第六步：等待服务

等待数据库、搜索引擎和主服务初始化。不要在刚执行启动命令后立即判断失败。

检查：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml ps
```

### 第七步：健康检查

```bash
curl -f http://localhost/api/v1/system/healthz
```

Windows PowerShell：

```powershell
Invoke-WebRequest -Uri http://localhost/api/v1/system/healthz -UseBasicParsing
```

### 第八步：告知用户访问地址

```text
项目地址：http://localhost/
```

如果用户要改前端，再执行：

```bash
cd web
npm ci
npm run dev
```

并告知：

```text
前端开发地址：http://localhost:9222/
```

---

## 11. 给 AI 的前端开发执行流程

当用户说“帮我修改前端”时：

1. 先确认 Docker 后端已启动；
2. 读取 `web/AGENTS.md`；
3. 检查 Node.js 版本；
4. 进入 `web/`；
5. 执行 `npm ci` 或确认 `node_modules` 已存在；
6. 启动 `npm run dev`；
7. 修改前先查看已有页面、组件、Service、Hook 和路由；
8. 不要直接修改 `web/src/components/ui/` 中的共享组件，除非用户明确允许；
9. 复用项目已有的颜色 Token、请求层、图标和 UI 组件；
10. 修改完成后执行：

```bash
npm run type-check
npm run lint
```

如果涉及路由、依赖、构建或大量页面，再执行：

```bash
npm run build
```

前端请求路径必须通过 Vite 代理访问 Go 后端，不要在业务组件中写死 Docker 容器名。

---

## 12. 项目文件修改注意事项

AI 在帮助队友开发时必须遵守：

1. 修改前先查看 `AGENTS.md`；
2. 修改 `web/` 前先查看 `web/AGENTS.md`；
3. 不要覆盖队友已有的未提交修改；
4. 先执行 `git status --short`；
5. 不要使用 `git reset --hard`；
6. 不要使用 `git checkout --` 覆盖文件；
7. 不要删除 Docker 数据卷；
8. 不要修改无关文件；
9. 新增功能优先使用 Go 后端已有 API；
10. 前端改造优先放在 `web/src/pages/railway/` 等独立业务目录；
11. 修改完成后运行最小相关检查；
12. 启动进程需要持续运行时，告诉用户进程和访问地址，不要误杀其他项目进程。

---

## 13. 最短启动命令清单

### 13.1 直接使用已构建镜像

在仓库根目录：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml --profile cpu up -d
```

浏览器：

```text
http://localhost/
```

### 13.2 本地没有 RAGFlow 镜像

在仓库根目录：

```bash
docker build --platform linux/amd64 -f Dockerfile -t ragflow:go-local .
docker compose --env-file docker/.env -f docker/docker-compose.yml --profile cpu up -d
```

### 13.3 前端开发

在仓库根目录：

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml --profile cpu up -d
cd web
npm ci
npm run dev
```

浏览器：

```text
http://localhost:9222/
```

### 13.4 停止项目

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml stop
```

### 13.5 重启项目

```bash
docker compose --env-file docker/.env -f docker/docker-compose.yml restart
```

---

## 14. 启动成功标准

只有同时满足以下条件，AI 才能向用户报告“项目启动成功”：

1. Docker 命令可用；
2. Compose 配置解析成功；
3. `ragflow-cpu` 容器处于 `Up`；
4. MySQL、Elasticsearch、MinIO、Kvrocks、NATS 和 ClickHouse 正常运行；
5. 浏览器访问 Web 入口返回 HTTP 200；
6. `/api/v1/system/healthz` 返回成功；
7. 没有持续出现主服务重启；
8. 如果启动了前端开发服务器，Vite 端口可以访问；
9. 用户能够看到登录页面；
10. 日志中没有未处理的数据库迁移错误、端口错误或依赖连接错误。

最终汇报格式建议：

```text
项目已启动。

Docker 服务状态：正常
Web 地址：http://localhost/
API 健康检查：正常
前端开发服务器：未启动/已启动
前端开发地址：http://localhost:9222/
```
