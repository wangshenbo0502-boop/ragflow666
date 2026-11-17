//go:build integration

package service

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	chatqueue "ragflow/internal/engine/nats"
	"ragflow/internal/entity"
)

func verifyChatDispatchFaultBoundaries(t *testing.T, ctx context.Context, db *gorm.DB, d *dao.ChatTaskDAO) {
	t.Helper()
	queue := chatqueue.NewNatsEngine("ragflow-chat-test-nats", 4222)
	if err := queue.Init(); err != nil {
		t.Fatal(err)
	}
	conn, err := nats.Connect("nats://ragflow-chat-test-nats:4222")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	broker, err := jetstream.New(conn)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadChatTaskConfig()
	if err != nil {
		t.Fatal(err)
	}
	cfg.Scan, cfg.Lease, cfg.AckWait = 20*time.Millisecond, time.Second, 250*time.Millisecond
	chat, session := integrationChatSession(t, ctx, db, common.GenerateToken())
	submit := func(t *testing.T) *entity.ChatTask {
		t.Helper()
		id := common.GenerateToken()
		task, replayed, err := d.Submit(ctx, &entity.ChatTask{
			ID: id, TenantID: "owner", UserID: "owner", ChatID: chat.ID, SessionID: session.ID,
			TurnID: id, Kind: "voice", Input: "{}", InputHash: strings.Repeat("c", 64), IdempotencyKey: id,
			MaxCalls: 8, MaxStageCalls: 4, MaxSwitches: 1,
			QueueDeadline: time.Now().Add(time.Minute).UnixMilli(), Deadline: time.Now().Add(2 * time.Minute).UnixMilli(),
		}, 1000, 1000, nil)
		if err != nil || replayed {
			t.Fatalf("durable submission failed: replayed=%v err=%v", replayed, err)
		}
		return task
	}
	newWorker := func(t *testing.T) *ChatTaskWorker {
		t.Helper()
		config := cfg
		config.Namespace, config.Consumer = "DISPATCH_"+common.GenerateToken(), "verify"
		if err := queue.InitChatTasks(ctx, config.Namespace, config.Consumer, config.AckWait, 5); err != nil {
			t.Fatal(err)
		}
		deferDelete := config.Namespace
		t.Cleanup(func() {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := broker.DeleteStream(cleanupCtx, deferDelete); err != nil {
				t.Error(err)
			}
		})
		return &ChatTaskWorker{config: config, queue: queue, dao: d, id: common.GenerateToken()}
	}
	startScan := func(t *testing.T, worker *ChatTaskWorker) func() {
		t.Helper()
		scanCtx, cancel := context.WithCancel(ctx)
		worker.wg.Add(1)
		go worker.scan(scanCtx)
		stop := func() { cancel(); worker.wg.Wait() }
		t.Cleanup(stop)
		return stop
	}
	pull := func(t *testing.T, worker *ChatTaskWorker, id string) jetstream.Msg {
		t.Helper()
		pullCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
		defer cancel()
		for {
			msg, err := queue.PullChatTask(pullCtx, worker.config.Namespace, worker.config.Consumer)
			if err != nil || msg == nil {
				t.Fatalf("real NATS wakeup unavailable: %v", err)
			}
			if string(msg.Data()) == id {
				return msg
			}
			if err := msg.DoubleAck(pullCtx); err != nil {
				t.Fatal(err)
			}
		}
	}
	waitDispatched := func(t *testing.T, id string) {
		t.Helper()
		for deadline := time.Now().Add(3 * time.Second); ; {
			current, err := d.Get(ctx, id)
			if err != nil {
				t.Fatal(err)
			}
			if current.DispatchAfter > 0 {
				return
			}
			if time.Now().After(deadline) {
				t.Fatal("durable scan did not record a real publication")
			}
			select {
			case <-time.After(10 * time.Millisecond):
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}
	}
	assertUnchanged := func(t *testing.T, before *entity.ChatTask) {
		t.Helper()
		after, err := d.Get(ctx, before.ID)
		if err != nil || !reflect.DeepEqual(before, after) {
			t.Fatalf("duplicate delivery changed durable task: %v", err)
		}
		var attempts int64
		if err := db.Model(&entity.ChatTaskAttempt{}).Where("task_id = ?", before.ID).Count(&attempts).Error; err != nil || attempts != 0 {
			t.Fatalf("duplicate delivery created attempts: count=%d err=%v", attempts, err)
		}
		var events int64
		if err := db.Model(&entity.ChatTaskEvent{}).Where("task_id = ?", before.ID).Count(&events).Error; err != nil || events != before.EventSeq {
			t.Fatalf("duplicate delivery changed events: count=%d expected=%d err=%v", events, before.EventSeq, err)
		}
	}

	t.Run("accepted_before_publish_and_claim_expiry", func(t *testing.T) {
		worker := newWorker(t)
		task := submit(t)
		stream, err := broker.Stream(ctx, worker.config.Namespace)
		if err != nil {
			t.Fatal(err)
		}
		info, err := stream.Info(ctx)
		if err != nil || info.State.Msgs != 0 {
			t.Fatal("new durable task was not initially independent of broker publication")
		}
		stop := startScan(t, worker)
		waitDispatched(t, task.ID)
		stop()
		msg := pull(t, worker, task.ID)
		task, err = d.Claim(ctx, task.ID, "lost-before-call", time.Second)
		if err != nil || task == nil {
			t.Fatalf("first real claim failed: %v", err)
		}
		if err := worker.execute(ctx, task.ID, msg); err != nil {
			t.Fatal(err)
		}
		assertUnchanged(t, task)
		if err := msg.DoubleAck(ctx); err != nil {
			t.Fatal(err)
		}
		// The executor disappears without changing its database lease.
		timer := time.NewTimer(time.Until(time.UnixMilli(task.LeaseUntil).Add(25 * time.Millisecond)))
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		if err := d.RecoverExpired(ctx, 100); err != nil {
			t.Fatal(err)
		}
		recovered, err := d.Get(ctx, task.ID)
		if err != nil || recovered.State != "running" || recovered.LeaseOwner != "" ||
			recovered.LeaseEpoch <= task.LeaseEpoch || recovered.Calls != 0 {
			t.Fatalf("natural expired claim did not become safely dispatchable: %v", err)
		}
		stop = startScan(t, worker)
		waitDispatched(t, task.ID)
		stop()
		msg = pull(t, worker, task.ID)
		resumed, err := d.Claim(ctx, task.ID, "recovered-before-call", time.Second)
		if err != nil || resumed == nil || resumed.LeaseEpoch <= recovered.LeaseEpoch || resumed.Calls != 0 {
			t.Fatalf("recovered wakeup could not claim a fresh epoch: %v", err)
		}
		if _, err := d.ReserveCall(ctx, task.ID, task.LeaseOwner, task.LeaseEpoch,
			dao.ChatTaskCall{Stage: "planning", Model: "must-not-run"}); !errors.Is(err, dao.ErrChatTaskLease) {
			t.Fatalf("expired owner could reserve a side effect: %v", err)
		}
		assertUnchanged(t, resumed)
		if err := msg.DoubleAck(ctx); err != nil {
			t.Fatal(err)
		}
		t.Log("real durable scan recovered unpublished admission and a naturally expired pre-call claim; active duplicate and old epoch created no attempts/events")
	})

	t.Run("publish_succeeded_dispatch_journal_failed", func(t *testing.T) {
		worker := newWorker(t)
		worker.config.AckWait = time.Minute
		if err := queue.InitChatTasks(ctx, worker.config.Namespace, worker.config.Consumer, time.Minute, 5); err != nil {
			t.Fatal(err)
		}
		task := submit(t)
		trigger := "dispatch_fault_" + common.GenerateToken()
		if err := db.Exec("CREATE TRIGGER " + trigger + " BEFORE UPDATE ON chat_task FOR EACH ROW " +
			"BEGIN IF NEW.id = '" + task.ID + "' AND NEW.dispatch_after > OLD.dispatch_after THEN " +
			"SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'isolated dispatch journal fault'; END IF; END").Error; err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := db.Exec("DROP TRIGGER IF EXISTS " + trigger).Error; err != nil {
				t.Error(err)
			}
		})
		stop := startScan(t, worker)
		first := pull(t, worker, task.ID)
		stop()
		firstMeta, err := first.Metadata()
		if err != nil {
			t.Fatal(err)
		}
		current, err := d.Get(ctx, task.ID)
		if err != nil || current.DispatchAfter != 0 || current.State != "queued" {
			t.Fatalf("SQL fault did not preserve the pending durable dispatch: %v", err)
		}
		if err := db.Exec("DROP TRIGGER " + trigger).Error; err != nil {
			t.Fatal(err)
		}
		stop = startScan(t, worker)
		waitDispatched(t, task.ID)
		stop()
		second := pull(t, worker, task.ID)
		secondMeta, err := second.Metadata()
		if err != nil || secondMeta.Sequence.Stream == firstMeta.Sequence.Stream || secondMeta.NumDelivered != 1 {
			t.Fatal("recovery did not publish a distinct wakeup after the real SQL failure")
		}
		if _, err := d.Cancel(ctx, task.ID); err != nil {
			t.Fatal(err)
		}
		terminal, err := d.Get(ctx, task.ID)
		if err != nil || terminal.State != "cancelled" {
			t.Fatal("test task did not reach its real cancellation terminal")
		}
		for _, msg := range []jetstream.Msg{first, second} {
			if err := worker.execute(ctx, task.ID, msg); err != nil {
				t.Fatal(err)
			}
			if err := msg.DoubleAck(ctx); err != nil {
				t.Fatal(err)
			}
		}
		assertUnchanged(t, terminal)
		t.Log("real MySQL trigger rejected dispatch bookkeeping after successful NATS publication; next scan republished; both terminal wakeups acknowledged without execution")
	})

	t.Run("ack_connection_closed", func(t *testing.T) {
		worker := newWorker(t)
		task := submit(t)
		if _, err := d.Cancel(ctx, task.ID); err != nil {
			t.Fatal(err)
		}
		terminal, err := d.Get(ctx, task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := queue.PublishChatTask(ctx, worker.config.Namespace, task.ID); err != nil {
			t.Fatal(err)
		}
		lost, err := nats.Connect("nats://ragflow-chat-test-nats:4222")
		if err != nil {
			t.Fatal(err)
		}
		defer lost.Close()
		lostBroker, err := jetstream.New(lost)
		if err != nil {
			t.Fatal(err)
		}
		consumer, err := lostBroker.Consumer(ctx, worker.config.Namespace, worker.config.Consumer)
		if err != nil {
			t.Fatal(err)
		}
		batch, err := consumer.Fetch(1, jetstream.FetchMaxWait(3*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		msg := <-batch.Messages()
		if msg == nil || string(msg.Data()) != task.ID {
			t.Fatal("real closed-connection consumer did not receive the intended wakeup")
		}
		firstMeta, err := msg.Metadata()
		if err != nil || firstMeta.NumDelivered != 1 {
			t.Fatal("ACK fault did not start from a first delivery")
		}
		if err := worker.execute(ctx, task.ID, msg); err != nil {
			t.Fatal(err)
		}
		lost.Close()
		if err := msg.Ack(); !errors.Is(err, nats.ErrConnectionClosed) {
			t.Fatalf("closed transport did not fail the actual ACK: %v", err)
		}
		redelivered := pull(t, worker, task.ID)
		meta, err := redelivered.Metadata()
		if err != nil || meta.NumDelivered < 2 || meta.Sequence.Stream != firstMeta.Sequence.Stream {
			t.Fatal("ACK failure did not redeliver the same actual broker message")
		}
		if err := worker.execute(ctx, task.ID, redelivered); err != nil {
			t.Fatal(err)
		}
		if err := redelivered.DoubleAck(ctx); err != nil {
			t.Fatal(err)
		}
		assertUnchanged(t, terminal)
		t.Logf("actual ACK failed with nats.ErrConnectionClosed; broker redelivered the same stream sequence %d %d times; terminal state, calls, attempts and events unchanged",
			meta.Sequence.Stream, meta.NumDelivered)
	})
}
