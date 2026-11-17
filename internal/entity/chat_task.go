package entity

// ChatTask is also the durable dispatch record. No browser token or provider
// credential belongs in Input; the worker resolves credentials at call time.
type ChatTask struct {
	ID              string  `gorm:"primaryKey;size:32" json:"id"`
	TenantID        string  `gorm:"size:32;not null;uniqueIndex:idx_chat_task_request,priority:1;index" json:"tenant_id"`
	UserID          string  `gorm:"size:32;not null;uniqueIndex:idx_chat_task_request,priority:2;index" json:"user_id"`
	IdempotencyKey  string  `gorm:"size:128;not null;uniqueIndex:idx_chat_task_request,priority:3" json:"-"`
	InputHash       string  `gorm:"size:64;not null" json:"-"`
	ChatID          string  `gorm:"size:32;not null;index" json:"chat_id"`
	SessionID       string  `gorm:"size:32;not null;index" json:"session_id"`
	TurnID          string  `gorm:"size:255;not null;index" json:"turn_id"`
	TurnSequence    int64   `json:"turn_sequence"`
	Kind            string  `gorm:"size:32;not null" json:"kind"`
	SchedulingClass string  `gorm:"size:16;not null;default:normal" json:"-"`
	State           string  `gorm:"size:32;not null;index" json:"state"`
	Stage           string  `gorm:"size:32;not null" json:"stage"`
	Revision        int64   `gorm:"not null" json:"revision"`
	EventSeq        int64   `gorm:"not null" json:"event_seq"`
	Input           string  `gorm:"type:longtext;not null" json:"-"`
	Outputs         JSONMap `gorm:"type:longtext" json:"outputs"`
	RetryOf         string  `gorm:"size:32;index" json:"retry_of,omitempty"`
	TargetRevision  int64   `json:"target_revision,omitempty"`
	ErrorCode       string  `gorm:"size:64" json:"error_code,omitempty"`
	ErrorMessage    string  `gorm:"size:512" json:"error_message,omitempty"`
	UpstreamStatus  string  `gorm:"size:32" json:"upstream_status"`
	LeaseOwner      string  `gorm:"size:64" json:"-"`
	LeaseEpoch      int64   `json:"-"`
	LeaseUntil      int64   `gorm:"index" json:"-"`
	NextRunAt       int64   `gorm:"index" json:"next_run_at"`
	ResourceWaitAt  int64   `json:"resource_wait_at,omitempty"`
	DispatchAfter   int64   `gorm:"index" json:"-"`
	QueueDeadline   int64   `json:"queue_deadline"`
	Deadline        int64   `json:"deadline"`
	MaxCalls        int     `json:"max_calls"`
	MaxStageCalls   int     `json:"max_stage_calls"`
	MaxSwitches     int     `json:"max_switches"`
	Calls           int     `json:"calls"`
	CheckpointCalls int     `json:"-"`
	CheckpointReady bool    `json:"-"`
	Switches        int     `json:"switches"`
	StrictCost      bool    `json:"strict_cost"`
	CostLimit       int64   `json:"cost_limit_micros"`
	CostReserved    int64   `json:"cost_reserved_micros"`
	CostActual      int64   `json:"cost_actual_micros"`
	CostUnknown     bool    `json:"cost_unknown"`
	CreatedAt       int64   `gorm:"index;autoCreateTime:false" json:"created_at"`
	UpdatedAt       int64   `gorm:"autoUpdateTime:false" json:"updated_at"`
	FinishedAt      int64   `json:"finished_at,omitempty"`
}

func (ChatTask) TableName() string { return "chat_task" }

type ChatTaskEvent struct {
	TaskID       string  `gorm:"primaryKey;size:32" json:"task_id"`
	Seq          int64   `gorm:"primaryKey;autoIncrement:false" json:"seq"`
	TurnID       string  `gorm:"size:255;not null" json:"turn_id"`
	TaskRevision int64   `json:"task_revision"`
	Type         string  `gorm:"size:32;not null" json:"type"`
	OccurredAt   int64   `json:"occurred_at"`
	Data         JSONMap `gorm:"type:longtext" json:"data"`
}

func (ChatTaskEvent) TableName() string { return "chat_task_event" }

type ChatTaskAttempt struct {
	ID            string  `gorm:"primaryKey;size:32" json:"id"`
	TaskID        string  `gorm:"size:32;not null;index" json:"task_id"`
	Stage         string  `gorm:"size:32;not null" json:"stage"`
	Number        int     `json:"number"`
	LeaseEpoch    int64   `json:"-"`
	Model         string  `gorm:"size:255" json:"model"`
	Reason        string  `gorm:"size:64" json:"reason"`
	State         string  `gorm:"size:32" json:"state"`
	UpstreamID    string  `gorm:"size:255" json:"upstream_id,omitempty"`
	StagingKey    string  `gorm:"size:255" json:"-"`
	EstimatedCost int64   `json:"estimated_cost_micros"`
	ActualCost    int64   `json:"actual_cost_micros"`
	CostKnown     bool    `json:"cost_known"`
	Usage         JSONMap `gorm:"type:longtext" json:"usage,omitempty"`
	ErrorCode     string  `gorm:"size:64" json:"error_code,omitempty"`
	StartedAt     int64   `json:"started_at"`
	FinishedAt    int64   `json:"finished_at,omitempty"`
}

func (ChatTaskAttempt) TableName() string { return "chat_task_attempt" }

// ChatMediaAsset is authoritative for generated media and version relationships.
type ChatMediaAsset struct {
	ID             string `gorm:"primaryKey;size:32" json:"id"`
	SourceKey      string `gorm:"size:255;not null;uniqueIndex:idx_chat_media_source" json:"-"`
	TenantID       string `gorm:"size:32;not null;index" json:"-"`
	SessionID      string `gorm:"size:32;not null;index" json:"session_id"`
	TurnID         string `gorm:"size:255;not null;index" json:"turn_id"`
	TaskID         string `gorm:"size:32;index" json:"task_id"`
	AttemptID      string `gorm:"size:32" json:"attempt_id"`
	ParentID       string `gorm:"size:32;index" json:"parent_id,omitempty"`
	Kind           string `gorm:"size:32" json:"kind"`
	Bucket         string `gorm:"size:128" json:"-"`
	ObjectKey      string `gorm:"size:255" json:"-"`
	MIMEType       string `gorm:"size:64" json:"mime_type"`
	Bytes          int64  `json:"bytes"`
	Width          int    `json:"width,omitempty"`
	Height         int    `json:"height,omitempty"`
	DurationMs     int64  `json:"duration_ms,omitempty"`
	OutputRevision int64  `json:"output_revision"`
	State          string `gorm:"size:32;index" json:"state"`
	CreatedAt      int64  `json:"created_at"`
}

func (ChatMediaAsset) TableName() string { return "chat_media_asset" }

// References include message ownership, edit parents and frozen task inputs.
type ChatMediaReference struct {
	AssetID   string `gorm:"primaryKey;size:32" json:"asset_id"`
	OwnerKind string `gorm:"primaryKey;size:32" json:"owner_kind"`
	OwnerID   string `gorm:"primaryKey;size:255" json:"owner_id"`
	Position  int    `json:"position"`
}

func (ChatMediaReference) TableName() string { return "chat_media_reference" }

// Cleanup survives session deletion; storage deletion and bookkeeping are retried.
type ChatMediaCleanup struct {
	ID         string `gorm:"primaryKey;size:32" json:"id"`
	AssetID    string `gorm:"size:32;index" json:"asset_id"`
	Bucket     string `gorm:"size:128" json:"-"`
	ObjectKey  string `gorm:"size:255;uniqueIndex:idx_chat_cleanup_object,priority:2" json:"-"`
	StoreScope string `gorm:"size:128;uniqueIndex:idx_chat_cleanup_object,priority:1" json:"-"`
	State      string `gorm:"size:32;index" json:"state"`
	Attempts   int    `json:"attempts"`
	NextRunAt  int64  `gorm:"index" json:"next_run_at"`
	LastError  string `gorm:"size:64" json:"last_error,omitempty"`
	CreatedAt  int64  `json:"created_at"`
}

func (ChatMediaCleanup) TableName() string { return "chat_media_cleanup" }

type ChatTaskResource struct {
	ID       string `gorm:"primaryKey;size:128" json:"id"`
	Capacity int    `json:"capacity"`
}

func (ChatTaskResource) TableName() string { return "chat_task_resource" }

// An unknown upstream keeps its slot even after the local executor lease expires.
type ChatTaskResourceLease struct {
	ResourceID string `gorm:"primaryKey;size:128" json:"resource_id"`
	TaskID     string `gorm:"primaryKey;size:32;index" json:"task_id"`
	LeaseEpoch int64  `json:"lease_epoch"`
	CreatedAt  int64  `json:"created_at"`
}

func (ChatTaskResourceLease) TableName() string { return "chat_task_resource_lease" }

type ChatModelHealth struct {
	ID            string `gorm:"primaryKey;size:255" json:"id"`
	Generation    int64  `json:"generation"`
	Failures      int    `json:"failures"`
	WindowStart   int64  `json:"window_start"`
	CooldownUntil int64  `json:"cooldown_until"`
	ProbeUntil    int64  `json:"probe_until"`
	LastError     string `gorm:"size:64" json:"last_error"`
}

func (ChatModelHealth) TableName() string { return "chat_model_health" }

type ChatTaskWorker struct {
	ID         string `gorm:"primaryKey;size:64" json:"id"`
	LeaseUntil int64  `gorm:"index" json:"lease_until"`
}

func (ChatTaskWorker) TableName() string { return "chat_task_worker" }
