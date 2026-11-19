package api

import (
	"fmt"
	"time"

	"limedia/backend/internal/models"
	"limedia/backend/internal/repo"
)

// ApiTime 以 pydantic v2 的 ISO8601 风格序列化时间(UTC,+00:00 后缀,
// 有微秒时才带小数),保证与契约样本逐字一致。
type ApiTime time.Time

func (t ApiTime) MarshalJSON() ([]byte, error) {
	tt := time.Time(t).UTC().Truncate(time.Microsecond)
	var s string
	if tt.Nanosecond() == 0 {
		s = tt.Format("2006-01-02T15:04:05+00:00")
	} else {
		s = tt.Format("2006-01-02T15:04:05.000000+00:00")
	}
	return []byte(`"` + s + `"`), nil
}

func apiTimeString(t *time.Time) *string {
	if t == nil {
		return nil
	}
	tt := (*t).UTC().Truncate(time.Microsecond)
	var s string
	if tt.Nanosecond() == 0 {
		s = tt.Format("2006-01-02T15:04:05+00:00")
	} else {
		s = tt.Format("2006-01-02T15:04:05.000000+00:00")
	}
	return &s
}

// ---- 计数结构 ----

type MemoryCounts struct {
	Photo int `json:"photo"`
	Video int `json:"video"`
}

type DisplayHealthCounts struct {
	Displayable int `json:"displayable"`
	Excluded    int `json:"excluded"`
}

type BrowserCompatibilityCounts struct {
	Supported   int `json:"supported"`
	Unsupported int `json:"unsupported"`
	Unknown     int `json:"unknown"`
}

type MemoryStatusCounts struct {
	Published   int `json:"published"`
	Unpublished int `json:"unpublished"`
}

// ---- 公开摘要(对齐 schemas/memory.py MemorySummaryRead)----

type MemoryCardFile struct {
	ID                   string `json:"id"`
	Filename             string `json:"filename"`
	RemoteState          string `json:"remote_state"`
	ThumbnailState       string `json:"thumbnail_state"`
	StreamState          string `json:"stream_state"`
	BrowserCompatibility string `json:"browser_compatibility"`
}

type MemorySummary struct {
	ID                string          `json:"id"`
	Title             string          `json:"title"`
	Description       string          `json:"description"`
	Kind              string          `json:"kind"`
	Status            string          `json:"status"`
	MediaDisplayState string          `json:"media_display_state"`
	PublicDisplayState string         `json:"public_display_state"`
	CapturedAt        *string         `json:"captured_at"`
	Location          *string         `json:"location"`
	ThumbnailPath     *string         `json:"thumbnail_path"`
	DurationSeconds   *int            `json:"duration_seconds"`
	Width             *int            `json:"width"`
	Height            *int            `json:"height"`
	PrimaryFile       *MemoryCardFile `json:"primary_file"`
	CreatedAt         *string         `json:"created_at"`
	UpdatedAt         *string         `json:"updated_at"`
	FileURL           string          `json:"file_url"`
	ThumbnailURL      *string         `json:"thumbnail_url"`
}

func toMemorySummary(m *models.Memory) *MemorySummary {
	id := m.ID.String()
	summary := &MemorySummary{
		ID:                id,
		Title:             m.Title,
		Description:       m.Description,
		Kind:              string(m.Kind),
		Status:            string(m.Status),
		MediaDisplayState: repo.GetMediaDisplayState(m),
		CapturedAt:        apiTimeString(m.CapturedAt),
		Location:          m.Location,
		ThumbnailPath:     m.ThumbnailPath,
		DurationSeconds:   m.DurationSeconds,
		Width:             m.Width,
		Height:            m.Height,
		CreatedAt:         apiTimeString(&m.CreatedAt),
		UpdatedAt:         apiTimeString(&m.UpdatedAt),
		FileURL:           fmt.Sprintf("/api/v1/memories/%s/file", id),
	}
	summary.PublicDisplayState = "excluded"
	if repo.GetPublicVisibilityState(m) == "displayable" {
		summary.PublicDisplayState = "displayable"
	}

	// 公开口径与 SQL any-文件谓词一致:选取首个通过公开条件的文件。
	if primary := repo.PrimaryPublicFile(m); primary != nil {
		summary.PrimaryFile = &MemoryCardFile{
			ID:                   primary.ID.String(),
			Filename:             primary.Filename,
			RemoteState:          string(primary.RemoteState),
			ThumbnailState:       string(primary.ThumbnailState),
			StreamState:          string(primary.StreamState),
			BrowserCompatibility: string(primary.BrowserCompatibility),
		}
	}
	summary.ThumbnailURL = thumbnailURLFor(m, summary.PrimaryFile)
	return summary
}

func thumbnailURLFor(m *models.Memory, primary *MemoryCardFile) *string {
	url := fmt.Sprintf("/api/v1/memories/%s/thumbnail", m.ID.String())
	if m.ThumbnailPath == nil {
		if primary == nil ||
			(primary.ThumbnailState != string(models.RemoteThumbnailStateReady) &&
				primary.ThumbnailState != string(models.RemoteThumbnailStateRetryable)) {
			return nil
		}
	}
	return &url
}

// ---- 列表响应 ----

type MemorySummaryListResponse struct {
	Items        []*MemorySummary `json:"items"`
	Total        int              `json:"total"`
	Page         int              `json:"page"`
	PageSize     int              `json:"page_size"`
	Counts       MemoryCounts     `json:"counts"`
	PublicCounts MemoryCounts     `json:"public_counts"`
}

type PublicMediaCounts struct {
	Total int `json:"total"`
	Photo int `json:"photo"`
	Video int `json:"video"`
}

type PublicPreheatStatusResponse struct {
	Status    string `json:"status"`
	Processed int    `json:"processed"`
	Total     int    `json:"total"`
}

type MemoryDirectLinkResponse struct {
	DirectURL string  `json:"direct_url"`
	ExpiresAt *string `json:"expires_at"`
	MimeType  string  `json:"mime_type"`
	SizeBytes *int64  `json:"size_bytes"`
}
