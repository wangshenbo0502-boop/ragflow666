//go:build integration

package service

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/dao"
	"ragflow/internal/entity"
)

func verifyChatCancelCompletionCompetition(t *testing.T, ctx context.Context, db *gorm.DB) {
	t.Helper()
	d := dao.NewChatTaskDAO(db)
	svc := NewChatSessionService()
	for _, order := range []string{"completion_first", "cancel_first", "race"} {
		t.Run(order, func(t *testing.T) {
			iterations := 1
			if order == "race" {
				iterations = 20
			}
			for i := range iterations {
				chat, session := integrationChatSession(t, ctx, db, common.GenerateToken())
				id := common.GenerateToken()
				now := time.Now().UnixMilli()
				task, _, err := d.Submit(ctx, &entity.ChatTask{
					ID: id, TenantID: "owner", UserID: "owner", ChatID: chat.ID,
					SessionID: session.ID, TurnID: id, Kind: "voice", Input: "{}",
					InputHash: strings.Repeat("a", 64), IdempotencyKey: id,
					MaxCalls: 4, MaxStageCalls: 2, QueueDeadline: now + 60000, Deadline: now + 120000,
				}, 100, 100, nil)
				if err != nil {
					t.Fatal(err)
				}
				history := dao.NewChatSessionDAO()
				if err := history.UpdateByID(ctx, db, session.ID, map[string]interface{}{
					"history_update": dao.ConversationHistoryUpdate{Message: map[string]interface{}{
						"id": id, "role": "user", "content": "question",
					}},
				}); err != nil {
					t.Fatal(err)
				}
				task, err = d.Claim(ctx, id, "completion-race", time.Minute)
				if err != nil || task == nil {
					t.Fatalf("cannot claim cancellation fixture: %v", err)
				}
				execution := &chatTaskExecution{service: svc, dao: d, task: task,
					owner: "completion-race", input: &chatTaskInput{ExpectedAnswerAbsent: true}}
				answer := map[string]interface{}{"id": id, "role": "assistant", "content": "saved answer",
					"reference": map[string]interface{}{"chunks": []string{"citation-before-cancel"}}}
				if err := execution.commitText(ctx, map[string]interface{}{"answer": "saved answer"}, answer); err != nil {
					t.Fatal(err)
				}
				var saved entity.ConversationMessage
				if err := db.Take(&saved, "conversation_id = ? AND message_id = ? AND role = ?", session.ID, id, "assistant").Error; err != nil {
					t.Fatal(err)
				}
				complete := func() error {
					return d.Mutate(ctx, id, execution.owner, task.LeaseEpoch, "task_terminal",
						func(_ *gorm.DB, current *entity.ChatTask) (entity.JSONMap, error) {
							current.State = "succeeded"
							return entity.JSONMap{"state": current.State}, nil
						})
				}
				cancel := func() error {
					_, err := d.Cancel(ctx, id)
					return err
				}
				var completionErr, cancelErr error
				switch order {
				case "completion_first":
					completionErr, cancelErr = complete(), cancel()
				case "cancel_first":
					cancelErr, completionErr = cancel(), complete()
				case "race":
					start := make(chan struct{})
					completed, cancelled := make(chan error, 1), make(chan error, 1)
					go func() { <-start; completed <- complete() }()
					go func() { <-start; cancelled <- cancel() }()
					close(start)
					completionErr, cancelErr = <-completed, <-cancelled
				}
				if cancelErr != nil {
					t.Fatalf("cancellation failed/deadlocked: %v", cancelErr)
				}
				current, err := d.Get(ctx, id)
				if err != nil {
					t.Fatal(err)
				}
				switch {
				case completionErr == nil:
					if current.State != "succeeded" || order == "cancel_first" {
						t.Fatalf("late cancellation replaced committed success: %s", current.State)
					}
				case errors.Is(completionErr, dao.ErrChatTaskState):
					if current.State != "cancel_requested" || order == "completion_first" {
						t.Fatalf("cancellation winner lost its state: %s", current.State)
					}
					if err := d.Mutate(ctx, id, execution.owner, task.LeaseEpoch, "task_terminal",
						func(_ *gorm.DB, current *entity.ChatTask) (entity.JSONMap, error) {
							current.State = "cancelled"
							return entity.JSONMap{"state": current.State}, nil
						}); err != nil {
						t.Fatal(err)
					}
					current, err = d.Get(ctx, id)
					if err != nil || current.State != "cancelled" {
						t.Fatalf("cancellation did not settle: %v", err)
					}
				default:
					t.Fatalf("terminal competition failed/deadlocked: %v", completionErr)
				}
				stable := *current
				if _, err := d.Cancel(ctx, id); err != nil {
					t.Fatal(err)
				}
				if err := execution.commitText(ctx, map[string]interface{}{"answer": "late replacement"},
					map[string]interface{}{"id": id, "role": "assistant", "content": "late replacement"}); !errors.Is(err, dao.ErrChatTaskLease) {
					t.Fatalf("terminal task accepted late output: %v", err)
				}
				after, err := d.Get(ctx, id)
				if err != nil || !reflect.DeepEqual(*after, stable) {
					t.Fatalf("late cancellation/output changed terminal task: %v", err)
				}
				var message entity.ConversationMessage
				if err := db.Take(&message, "conversation_id = ? AND position = ?", session.ID, saved.Position).Error; err != nil || !reflect.DeepEqual(message, saved) {
					t.Fatalf("competition changed committed text, citations or answer version: %v", err)
				}
				var events []entity.ChatTaskEvent
				if err := db.Where("task_id = ?", id).Order("seq").Find(&events).Error; err != nil {
					t.Fatal(err)
				}
				terminals := 0
				for index, event := range events {
					if event.Seq != int64(index+1) || event.TaskRevision > after.Revision {
						t.Fatal("terminal competition corrupted event ordering")
					}
					if event.Type == "task_terminal" {
						terminals++
						if event.Data["state"] != after.State {
							t.Fatal("terminal event disagrees with the authoritative task")
						}
					}
				}
				if terminals != 1 || int64(len(events)) != after.EventSeq {
					t.Fatalf("expected one terminal event, got %d/%d", terminals, len(events))
				}
				t.Logf("%s iteration=%d terminal=%s events=%d answer_version=%d", order, i, after.State, len(events), message.AnswerVersion)
			}
			t.Log(fmt.Sprintf("PASS real MySQL %s: %d competitions; saved text/citations/version unchanged; one immutable terminal event", order, iterations))
		})
	}
}
