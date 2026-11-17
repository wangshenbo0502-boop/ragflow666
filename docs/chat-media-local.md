# Local chat media

Start from the repository root in PowerShell:

```powershell
.\tools\scripts\start-local-project.ps1
```

Open `http://localhost/`. In a saved chat, type `@` and choose a tool, then enter the content and send:

```text
@生图 一列高铁穿过青山，写实摄影
@语音 高铁和动车有什么区别？
@语音 用温柔的台湾女生口吻，开心地说一句晚安
@语音 唱一段 20 秒的中文甜美女声晚安歌
@生图 横版 2K 高铁旅行海报，标题“向山而行”
@生图 把上一张改成夕阳，列车和标题保持不变
```

Images and audio remain in the conversation after refresh. The speaker button on a text reply reads the reply using the configured default Qwen3-TTS model.

`@语音` sends the question to the selected chat model with the current knowledge bases and conversation history, then synthesizes the answer. The reply retains its text, citations, and a playable audio attachment. The command does not change the chat model.

Speech uses Qwen3-TTS 1.7B CustomVoice Q6_K with Serena. Before each song, the backend synthesizes a fixed Serena speech sample and sends it to ACE-Step as multipart `ref_audio`, alongside the requested lyrics and musical style. This conditions the singing model on Serena's actual timbre in addition to the female vocal description. If reference synthesis fails, song generation stops with an error instead of generating an unrelated voice. The engines are different, so their timbres cannot be guaranteed to match exactly; this does not reproduce a real person's voice or guarantee a Taiwanese accent. Reply playback uses the same Serena style and preserves sentence punctuation.

Explicit singing requests use the local native ACE-Step engine with generated lyrics and music instructions, producing a short WAV song. Song duration is limited to 10–45 seconds.

Image generation and editing exclusively use `gpt-image-2.5-sunburst`, with high quality and native 2K dimensions by default. There is no fallback to another image model. Explicit 4K requests use a supported size up to 3840 pixels on the long edge. The selected chat model assembles the creative instruction in a dedicated planning flow, independent of the chat's QA persona, retrieval, and agent routing. The image model receives both the plan and the latest original request to preserve counts, spatial relationships, exact text, exclusions, and edit boundaries.

Creative plans are saved with generated replies and reused during follow-up planning. Edits retain the previous dimensions unless a new size is requested. When an edit uses both the last generated image and new attachments, the previous image is reference 1 and attachments follow in upload order. New creations use only the supplied attachments. These instructions improve fidelity but cannot guarantee that every generated detail will be exact.

Stop the project and its local speech, music and reranker processes:

```powershell
.\tools\scripts\stop-local-project.ps1
```

The speech and music supervisor also exits when `docker-ragflow-cpu-1` stops. It does not register a Windows startup task or service. Music models load only during generation and unload between stages; the music server starts with no model weights on the GPU.

Startup reuses an existing speech or music process only when its executable,
configured arguments and listening port match this project. It starts a missing
engine independently, so a running Serena speech process does not prevent music
from starting. The supervisor holds `.run/qwen3tts/watch.lock` while running.
Stop checks each recorded executable and process start time before terminating
it. Startup waits for speech, music, reranker and API health checks.

The composer accepts multiple files, pasted screenshots, and dropped images. Uploading does not lock the text field. Failed uploads can be retried or removed, and sending waits until every remaining attachment is ready. Sending only attachments asks the selected model to analyze them. Image understanding requires a vision-capable model.

With `@生图`, attached PNG, JPEG, or WebP images are sent as references to the image editing endpoint along with the written request. Without attachments, the command uses text-to-image generation.

The startup script detects proxy Fake-IP DNS results for the configured local model hosts and writes a fresh public-address compose override under `.run/`. This keeps the Go network checks enabled.

Local prerequisites: Docker Desktop, the built Go binary in `bin/`, the built frontend in `web/dist/`, the speech executable and model files under `.run/qwen3tts/`, and `.cache/compose.local-startup.yml`. Private media configuration lives in the ignored `.run/chat-media.env`. Keep its image API key out of version control.

Speech logs: `.run/qwen3tts/server.stderr.log` and `.run/qwen3tts/watch.stderr.log`.
Supervisor actions: `.run/qwen3tts/watch.stdout.log`.
Music logs: `.run/music/server.stderr.log`.

The chat Worker emits `chat task operational statistics` at Info level after each
bounded cleanup sweep (at most once per minute). Counts describe the rows still
retained in the database, including all task states, unknown upstreams, media
without effective references, reclaimable media, eligible cleanup journals,
retry journals, and the oldest pending journal's age in milliseconds. Active
tasks and unresolved upstreams retain their media even when a task is terminal.
Objects within `RAGFLOW_CHAT_CLEANUP_GRACE` are excluded from the reclaimable
count; valid message and image-parent references are excluded from backlog.

`RAGFLOW_CHAT_CLEANUP_ALERT_THRESHOLD` accepts 1–1000 and defaults to 1000.
The Worker emits `chat media cleanup backlog` at Warn level when reclaimable
media reach this threshold or eligible removal retries remain. Failed inventory
queries emit a warning rather than a misleading zero. Statistics run in the
cleanup goroutine with a five-second query deadline, separate from dispatch and
heartbeats. No new monitoring service is required.

Authorized duplicate submissions and stage retries emit `chat task replayed`,
with task, turn, and session identifiers, after current input permissions pass.
Count these structured log entries for replay traffic; they are not extra model
calls or mutations to a completed task. Per-task diagnostics include inclusive
planning, retrieval, and save spans; nested spans must not be added together as
total latency. Phases with no measured sample remain explicitly unmeasured.

## Docker service groups

The formal local deployment uses the existing `docker` Compose project.
The isolated acceptance environment uses `ragflow-chat-test`; its local manifest
is `.run/chat-test.compose.yaml`. That file contains private environment values.
Use these commands from the repository root to inspect or start the test group:

```powershell
docker compose -f .run/chat-test.compose.yaml --profile acceptance ps -a
docker compose -f .run/chat-test.compose.yaml up -d
```

The default test services are API, ingestor, NATS, MinIO and Kvrocks. Six
log/rollout/rollback replicas belong to the `acceptance` profile and stay stopped
outside their dedicated tests. Start only the replicas required by the selected
test. The builder supplies Go/native build dependencies, and Ollama serves
models; neither is a duplicate chat API. Other Compose projects have separate
owners and data. Grouping test services does not merge their database schema or
volumes with the formal deployment.

## Worker startup and configuration

The Go ingestor owns the chat Worker. The API alone cannot consume media tasks.
Supply `RAGFLOW_CHAT_WORKER_ENABLED=true` to the ingestor and give API and
ingestor the same task policy, database, JetStream namespace, tenant media
settings and model references. The regular Compose service reads
`docker/.env` and `docker/.env.local`; the local project startup also supplies
the private media configuration described above. Editing an environment file
does not update an already running process.

Before applying a configuration change, identify the owning deployment and
check active ingestion and chat work. Use its existing supervisor or Compose
lifecycle during a suitable maintenance window. A standalone Go ingestor starts
with `bin/ragflow_server --ingestor --config /path/to/service_conf.yaml`.
Do not launch it beside an existing owned ingestor just to apply new settings.
It requires the configured ingestion dependencies as well as NATS JetStream,
database and storage access. An enabled Worker that cannot initialize its queue,
device resource or heartbeat makes ingestor startup fail.

`internal/service/chat_task_config.go` owns the following settings. Every suffix
below has the prefix `RAGFLOW_CHAT_`. Unset or empty values use the defaults.
Invalid values return an error, including when the Worker is disabled.

| Suffix | Default | Accepted value |
| --- | --- | --- |
| `WORKER_ENABLED` | `false` | Go `strconv.ParseBool` syntax, normally `true` or `false` |
| `WORKERS` | `2` | Integer 1..1000, consumers per ingestor |
| `USER_PENDING` | `10` | Integer 1..1000 |
| `TENANT_PENDING` | `100` | Integer 1..1000 |
| `USER_CONCURRENT` | `2` | Integer 1..1000 |
| `TENANT_CONCURRENT` | `4` | Integer 1..1000 |
| `DEVICE_CAPACITY` | `1` | Integer 1..1000 |
| `MAX_CALLS` | `12` | Integer 1..1000, whole task |
| `MAX_STAGE_CALLS` | `4` | Integer 1..1000, each stage |
| `MAX_SWITCHES` | `2` | Integer 0..1000 |
| `MAX_DELIVER` | `20` | Integer 1..1000, JetStream deliveries |
| `CLEANUP_BATCH` | `100` | Integer 1..1000 |
| `CLEANUP_ALERT_THRESHOLD` | `1000` | Integer 1..1000 |
| `MODEL_FAILURE_THRESHOLD` | `1` | Integer 1..1000 |
| `NAMESPACE` | `RAGFLOW_CHAT` | 1..64 ASCII letters, digits, `_` or `-` |
| `CONSUMER` | `RAGFLOW_CHAT_WORKER` | Same name rule |
| `DEVICE` | `chat-media-device` | Same name rule; shared callers use the same resource ID |

All durations accept Go duration strings in the range `1s`..`24h`.

| Suffix | Default | Meaning |
| --- | --- | --- |
| `LEASE` | `30s` | Executor lease and Worker heartbeat validity |
| `RENEW` | `5s` | Execution renewal interval |
| `SCAN` | `2s` | Recovery and dispatch scan interval |
| `ACK_WAIT` | `30s` | JetStream acknowledgement wait |
| `QUEUE_TIMEOUT` | `15m` | Initial queue deadline |
| `TIMEOUT` | `30m` | Whole task/route deadline |
| `STAGE_TIMEOUT` | `10m` | Model call stage limit and health probe lease |
| `SHUTDOWN_TIMEOUT` | `30s` | Chat Worker drain limit, also bounded by its caller's deadline |
| `RESOURCE_WAIT` | `5m` | Resource wait limit |
| `CLEANUP_GRACE` | `1h` | Unreferenced media cleanup grace |
| `PRIORITY_WAIT` | `2m` | Scheduling offset for noninteractive work |
| `MODEL_FAILURE_WINDOW` | `1m` | Shared model failure counting window |
| `MODEL_COOLDOWN` | `5s` | Shared model cooldown |

Startup requires `RENEW * 2 < LEASE`, `RENEW * 2 < ACK_WAIT`,
`QUEUE_TIMEOUT < TIMEOUT`, and `STAGE_TIMEOUT <= TIMEOUT`. API and ingestor must
agree on the namespace and consumer; changing these names is a queue migration.
The database remains authoritative and the recovery scan republishes wakeups.
`WORKERS` is per process, while user, tenant and device leases are persisted and
shared. Raising a configured limit does not prove an unresolved upstream stopped.
This scheduler only accounts for callers that participate in its resource leases.

On shutdown the chat Worker stops intake, drains existing execution, then aborts
at the deadline and removes its heartbeat. The ingestor currently gives ingestion
and chat shutdown a shared 30-second context, stopping ingestion first. Increasing
`SHUTDOWN_TIMEOUT` alone cannot extend that outer deadline. Allow the owning
supervisor enough time for graceful shutdown and reconciliation; a forced exit
or HTTP cancellation does not prove a remote generation stopped.

Media configuration is scoped by `RAGFLOW_MEDIA_TENANT_ID`.
`RAGFLOW_IMAGE_BASE_URL` plus `RAGFLOW_IMAGE_API_KEY` enable the image adapter,
`RAGFLOW_TTS_BASE_URL` configures speech, and `RAGFLOW_MUSIC_BASE_URL` adds music.
Keep the key in the existing private environment source. The authenticated
`GET /api/v1/chats/capabilities` reports current Worker availability, configured
adapters, routes and attachment limits. It does not probe model readiness:
acceptance still requires a real Worker task and usable stored output.
Attachment limits come from `internal/service/file/chat_attachment.go`;
they are not configurable through invented environment variables.

## Model route configuration

`RAGFLOW_CHAT_ROUTE_CONFIG` is JSON keyed by tenant ID. Each tenant has at most
16 ordered candidates, referencing existing persisted model IDs:

```json
{
  "<tenant-id>": [
    {"id": "<preferred-model-id>", "max_cost_micros": 100000},
    {"id": "<backup-model-id>", "max_cost_micros": 150000}
  ]
}
```

The costs here are illustrative operator-provided per-call reservation amounts,
not a price discovery result or a supplier bill. An omitted `max_cost_micros`
means unknown cost; an explicit zero is known zero. Values must be integers
0..1000000000000. Model IDs must be nonempty, unique within each tenant's list,
and at most 255 characters. No candidate credentials or provider URLs belong in
this setting. Invalid JSON or entries cause route/capability resolution to fail.

The request's `route_policy` defaults to `fixed`. `fallback` tries allowed
alternatives after retryable 429/502/503/504 failures; `auto` can additionally
choose an authorized vision model before a call. A partial streamed response,
cancellation or deadline does not permit switching. Optional `allowed_models`
narrows the configured candidates and cannot grant access. With no candidate
configuration there is no automatic backup; the selected model remains preferred.

All models must resolve to persisted identities under current authorization.
Candidates must retain required vision/tools capability, context/output capacity
and model class. `cost_limit_micros` is a strict total reservation limit:
unknown-cost candidates are ineligible. Include the preferred model's cost in the
configuration when using a strict limit. Calls, stage calls, switches and time
limits still apply without a currency limit; parallel branches share task budgets.
The shared health gate uses tenant/model identity and a bounded probe lease.
Do not clear health rows to force a failed acceptance test through the gate.

These policies cover chat/vision planning. The current image, Serena speech and
music adapters each have one qualified fixed model. Their `media_route_policy`
supports `fixed` only and strict currency limits are rejected because their
prices are unknown. A chat fallback does not establish media fallback support.

## Diagnosing a failed task

Use the task owner's authenticated endpoints:

```text
GET /api/v1/chats/tasks/<task-id>
GET /api/v1/chats/tasks/<task-id>/events?after_seq=0
```

Read state, stage, error code, upstream status, call counts, attempts,
`diagnostics`, `routing_snapshot` and ordered events before resubmitting.
The details also expose permitted retry stages and disabled reasons. Read the
Worker logs around `chat task claimed`, `chat task execution failed` and
`chat model attempt`, correlating the task and model identifiers. Follow the
owning deployment's log files as well as container output. Preserve only safe
error codes, identifiers, timings and stack locations in shared reports;
task outputs and raw provider errors may contain user content.

For a planning failure, trace planning entry, persisted model/instance resolution,
candidate capability and authorization checks, the shared health/probe gate,
driver selection and output-parameter validation, then
`BeginModelCall`/`ReserveCall` and the actual HTTP request. Check the effective
model ID, `max_tokens`/`MaxOutput`, deadlines, budgets and resource holders.
Zero recorded calls can mean failure before reservation. The route's
`callStarted` flag is set before entering the driver callback and is not proof
of an HTTP request. A current healthy probe cannot establish why an older task
failed without attempts or a retained cause.

For resource waits inspect `chat_task_resource`, `chat_task_resource_lease`
and their task/attempt identities in the selected schema. Keep `unknown` leases
until an authoritative upstream status or matched service completion/stoppage
record proves the associated work stopped. A missing upstream ID, elapsed lease,
closed client connection or terminal chat task alone is insufficient. Waiters
must fail promptly with safe diagnostics when a task reaches a terminal state
that cannot satisfy the expected checkpoint.

After a root cause is repaired, first run one minimal real Worker task, then
the affected identity and combined workflows. Do not repeat the same failed
generation test twice without investigating or confirming changed conditions.

## Historical media migration

Use the existing `--migrate` mode in the environment that owns the target
database and object store, with its existing secrets and exact configuration.
The examples below are Linux shell commands; substitute the configuration path
before execution. These commands initialize database migrations first, including
when `--chat-media-action dry-run` is selected. Only media association writes are
disabled by that action; it is not a read-only schema inspection.

Take a consistent database backup and preserve the corresponding object bytes,
configuration and old binary before the maintenance window. Run a dry-run and
review its counts and issues:

```sh
bin/ragflow_server --migrate --config /path/to/service_conf.yaml --chat-media-action dry-run --chat-media-batch 100
```

For each page retain the JSON report and pass its `cursor` to the next command
using `--chat-media-cursor <session-id>`, until `done` is true. The batch counts
sessions, ordered by ID; the cursor is not a mutable message position. Reports
include `messages`, `recognized`, `already_linked`, `linked`, `missing_objects`,
`manual_review`, `failures` and `issues`. In dry-run, `linked` means associations
that would be added. Counters are per page, not cumulative; archive all pages.
Nonzero issue counts require review even if the command exits successfully.

Freeze media writes before executing the conversion:

```sh
bin/ragflow_server --migrate --config /path/to/service_conf.yaml --chat-media-action freeze
bin/ragflow_server --migrate --config /path/to/service_conf.yaml --chat-media-action execute --chat-media-batch 100
```

Freeze refuses any running/cancel-requested task or running/unknown upstream,
including unknown work belonging to a terminal task. Do not bypass that refusal.
It serializes with admission and claiming across hosts; it does not cancel work.
Start the execute pass from the beginning, then advance using its own saved
cursor. Reuse an execute cursor only to resume that execute pass.

Reconcile every recognized link with its association or reported issue, inspect
missing/corrupt/ambiguous cases and verify stored outputs and current access.
Re-running from the beginning must not duplicate assets/references. Affected
messages gain structured media metadata and an answer revision; normal reads
use these associations. The tool never repairs ownership by guessing from a
message position. Retain backups and resolve failures before resuming writes:

```sh
bin/ragflow_server --migrate --config /path/to/service_conf.yaml --chat-media-action thaw
```

There is no inverse migration action. A rollback needs a verified compatible
binary/schema pair and the matching database/object backup in an isolated
rehearsal first. Do not point an older binary at a newer schema and call that a
rollback, or restore a shared production database to undo only a test schema.
The execution ledger records which migration and rollout scenarios actually
passed; these instructions alone do not establish a completed rehearsal.

## Reconciling a stopped upstream

This is an operator write action, separate from media migration. First retain
authoritative evidence for every unresolved attempt of the terminal task,
matching model/job identity and completion or stoppage. Keep the actual record
in the private incident archive and use a nonsecret reference of 8..256
characters. After that prerequisite is met, the owning environment can run:

```sh
bin/ragflow_server --migrate --config /path/to/service_conf.yaml --chat-task-reconcile <32-character-task-id> --chat-task-reconcile-evidence <incident-reference>
```

The command does not query or stop the upstream service; evidence length is not
evidence verification. It requires a terminal task, releases that task's leases,
marks unresolved attempts `operator_confirmed_stopped`, increments the fencing
epoch and revision, and records `upstream_reconciled` with the evidence digest.
It preserves the terminal outcome and saved outputs. Already stopped/not-started
tasks are unchanged. Verify those invariants and remaining resource holders
after execution; it does not submit a retry. Never use this action solely to
make room for an acceptance test.
