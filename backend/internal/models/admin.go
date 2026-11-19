package models

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// ---- admin_sessions ----

type AdminSession struct {
	ID        uuid.UUID
	TokenHash string // sha256 hex,唯一索引
	ClientIP  *string
	ExpiresAt time.Time
	RevokedAt *time.Time
	CreatedAt time.Time
}

// ---- admin_operation_logs ----

type AdminOperationLog struct {
	ID        uuid.UUID
	Action    string
	TargetType *string
	TargetID  *uuid.UUID
	ClientIP  *string
	Detail    *string
	CreatedAt time.Time
}

// ---- admin_background_jobs ----

type AdminBackgroundJob struct {
	ID              uuid.UUID
	Action          string
	Status          string // queued/running/completed/cancelled/failed
	FilterSnapshot  json.RawMessage
	ResourceIDs     json.RawMessage // JSON 数组,元素为 uuid 字符串
	Total           int
	Processed       int
	Changed         int
	Skipped         int
	Failed          int
	ErrorMessage    *string
	CreatedBySession *uuid.UUID
	CreatedAt       time.Time
	StartedAt       *time.Time
	CompletedAt     *time.Time
}
