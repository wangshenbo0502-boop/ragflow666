package dao

import (
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"

	"ragflow/internal/entity"
)

func TestChatTaskDispatchSQLBindsPriorityWindow(t *testing.T) {
	d, db := setupChatTaskTest(t)
	var sql string
	var vars []interface{}
	if err := db.Callback().Query().Before("gorm:query").Register("dispatch_dry_run", func(tx *gorm.DB) {
		if tx.Statement.Table == (entity.ChatTask{}).TableName() {
			tx.DryRun = true
		}
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.Callback().Query().After("gorm:query").Register("capture_dispatch_sql", func(tx *gorm.DB) {
		if tx.DryRun && tx.Statement.Table == (entity.ChatTask{}).TableName() {
			sql, vars = tx.Statement.SQL.String(), append([]interface{}(nil), tx.Statement.Vars...)
		}
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Dispatchable(t.Context(), 19, 17*time.Second); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sql, "CASE WHEN scheduling_class = 'interactive' THEN 0 ELSE ? END ASC, id ASC") ||
		!strings.Contains(sql, "next_run_at <= ? AND dispatch_after <= ?") ||
		!strings.HasSuffix(sql, " LIMIT 19") ||
		len(vars) != 6 || vars[0] != "queued" || vars[1] != "running" || vars[2] != "" ||
		vars[5] != int64(17000) {
		t.Fatalf("dispatch SQL or bound values changed: %s %#v", sql, vars)
	}
	t.Logf("DryRun dispatch SQL: %s; priority window bound=%vms, limit=19", sql, vars[5])
}
