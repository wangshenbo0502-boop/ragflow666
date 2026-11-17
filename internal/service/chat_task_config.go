package service

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"time"
)

type ChatTaskConfig struct {
	Enabled                                            bool
	Workers, UserPending, TenantPending                int
	UserConcurrent, TenantConcurrent, DeviceCapacity   int
	MaxCalls, MaxStageCalls, MaxSwitches, MaxDeliver   int
	Namespace, Consumer, Device                        string
	Lease, Renew, Scan, AckWait, QueueTimeout, Timeout time.Duration
	StageTimeout, ShutdownTimeout, ResourceWait        time.Duration
	CleanupGrace                                       time.Duration
	CleanupBatch                                       int
	CleanupAlertThreshold                              int
	PriorityWait                                       time.Duration
	ModelFailureThreshold                              int
	ModelFailureWindow, ModelCooldown                  time.Duration
}

func LoadChatTaskConfig() (ChatTaskConfig, error) {
	c := ChatTaskConfig{
		Workers: 2, UserPending: 10, TenantPending: 100,
		UserConcurrent: 2, TenantConcurrent: 4, DeviceCapacity: 1,
		MaxCalls: 12, MaxStageCalls: 4, MaxSwitches: 2, MaxDeliver: 20,
		Namespace: "RAGFLOW_CHAT", Consumer: "RAGFLOW_CHAT_WORKER", Device: "chat-media-device",
		Lease: 30 * time.Second, Renew: 5 * time.Second, Scan: 2 * time.Second, AckWait: 30 * time.Second,
		QueueTimeout: 15 * time.Minute, Timeout: 30 * time.Minute, StageTimeout: 10 * time.Minute,
		ShutdownTimeout: 30 * time.Second, ResourceWait: 5 * time.Minute,
		CleanupGrace: time.Hour, CleanupBatch: 100, CleanupAlertThreshold: 1000,
		PriorityWait:          2 * time.Minute,
		ModelFailureThreshold: 1, ModelFailureWindow: time.Minute, ModelCooldown: 5 * time.Second,
	}
	if value := os.Getenv("RAGFLOW_CHAT_WORKER_ENABLED"); value != "" {
		enabled, err := strconv.ParseBool(value)
		if err != nil {
			return c, fmt.Errorf("RAGFLOW_CHAT_WORKER_ENABLED: %w", err)
		}
		c.Enabled = enabled
	}
	for name, target := range map[string]*int{
		"WORKERS": &c.Workers, "USER_PENDING": &c.UserPending, "TENANT_PENDING": &c.TenantPending,
		"USER_CONCURRENT": &c.UserConcurrent, "TENANT_CONCURRENT": &c.TenantConcurrent,
		"DEVICE_CAPACITY": &c.DeviceCapacity, "MAX_CALLS": &c.MaxCalls,
		"MAX_STAGE_CALLS": &c.MaxStageCalls, "MAX_DELIVER": &c.MaxDeliver,
		"MAX_SWITCHES":            &c.MaxSwitches,
		"CLEANUP_BATCH":           &c.CleanupBatch,
		"CLEANUP_ALERT_THRESHOLD": &c.CleanupAlertThreshold,
		"MODEL_FAILURE_THRESHOLD": &c.ModelFailureThreshold,
	} {
		if value := os.Getenv("RAGFLOW_CHAT_" + name); value != "" {
			number, err := strconv.Atoi(value)
			minimum := 1
			if name == "MAX_SWITCHES" {
				minimum = 0
			}
			if err != nil || number < minimum || number > 1000 {
				return c, fmt.Errorf("RAGFLOW_CHAT_%s must be in %d..1000", name, minimum)
			}
			*target = number
		}
	}
	for name, target := range map[string]*time.Duration{
		"LEASE": &c.Lease, "RENEW": &c.Renew, "SCAN": &c.Scan, "ACK_WAIT": &c.AckWait,
		"QUEUE_TIMEOUT": &c.QueueTimeout, "TIMEOUT": &c.Timeout, "STAGE_TIMEOUT": &c.StageTimeout,
		"SHUTDOWN_TIMEOUT": &c.ShutdownTimeout, "RESOURCE_WAIT": &c.ResourceWait,
		"CLEANUP_GRACE":        &c.CleanupGrace,
		"PRIORITY_WAIT":        &c.PriorityWait,
		"MODEL_FAILURE_WINDOW": &c.ModelFailureWindow, "MODEL_COOLDOWN": &c.ModelCooldown,
	} {
		if value := os.Getenv("RAGFLOW_CHAT_" + name); value != "" {
			duration, err := time.ParseDuration(value)
			if err != nil || duration < time.Second || duration > 24*time.Hour {
				return c, fmt.Errorf("RAGFLOW_CHAT_%s must be a duration in 1s..24h", name)
			}
			*target = duration
		}
	}
	validName := regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	for name, target := range map[string]*string{"NAMESPACE": &c.Namespace, "CONSUMER": &c.Consumer, "DEVICE": &c.Device} {
		if value := os.Getenv("RAGFLOW_CHAT_" + name); value != "" {
			if !validName.MatchString(value) {
				return c, fmt.Errorf("invalid RAGFLOW_CHAT_%s", name)
			}
			*target = value
		}
	}
	if c.Renew*2 >= c.Lease || c.Renew*2 >= c.AckWait || c.QueueTimeout >= c.Timeout || c.StageTimeout > c.Timeout {
		return c, fmt.Errorf("chat worker requires renew*2 < lease/ack_wait, queue_timeout < timeout and stage_timeout <= timeout")
	}
	return c, nil
}
