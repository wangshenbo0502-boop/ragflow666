// Copyright 2026 The InfiniFlow Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package service

import (
	"errors"
	"testing"

	"gorm.io/gorm"

	"ragflow/internal/common"
	"ragflow/internal/entity"
)

func TestPasswordLoginKeepsSessionsUntilLogout(t *testing.T) {
	ctx := t.Context()
	db := setupServiceTestDB(t)
	pushServiceDB(t, db)

	password := "test-session-password!"
	hash, err := common.GenerateWerkzeugPasswordHash(password)
	if err != nil {
		t.Fatal(err)
	}
	account := &entity.User{
		ID:       common.GenerateToken(),
		Nickname: "Session test",
		Email:    "session@example.invalid",
		Password: &hash,
	}
	if err := db.Create(account).Error; err != nil {
		t.Fatal(err)
	}

	users := NewUserService()
	req := &EmailLoginRequest{Email: account.Email, Password: password}
	first, _, err := users.LoginByEmail(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := users.Login(ctx, &LoginRequest{Username: account.Email, Password: password})
	if err != nil {
		t.Fatal(err)
	}
	firstToken := *first.AccessToken
	if firstToken != *second.AccessToken {
		t.Fatal("signing in again replaced the account credential")
	}

	if _, err := users.Logout(ctx, second); err != nil {
		t.Fatal(err)
	}
	third, _, err := users.LoginByEmail(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if *third.AccessToken == firstToken {
		t.Fatal("signing in after logout reused the revoked credential")
	}
	if _, err := users.userDAO.GetByAccessToken(ctx, db, firstToken); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("lookup of revoked credential returned %v, want record not found", err)
	}
}
