package config

import (
	"os"
	"testing"
)

func setEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

func TestLoadRejectsExampleAdminToken(t *testing.T) {
	setEnv(t, map[string]string{"ADMIN_TOKEN": "change-me"})
	if _, err := Load(); err == nil {
		t.Fatal("示例 ADMIN_TOKEN 必须拒绝启动")
	}
}

func TestLoadAllowsEmptyAdminToken(t *testing.T) {
	setEnv(t, map[string]string{"ADMIN_TOKEN": "", "DATABASE_URL": "postgres://media:media@127.0.0.1:55432/media"})
	s, err := Load()
	if err != nil {
		t.Fatalf("空 ADMIN_TOKEN 应合法(fail-closed): %v", err)
	}
	if s.AdminToken != "" {
		t.Fatalf("ADMIN_TOKEN 应为空, got %q", s.AdminToken)
	}
}

func TestDatabaseURLNormalization(t *testing.T) {
	setEnv(t, map[string]string{
		"ADMIN_TOKEN":  "",
		"DATABASE_URL": "postgresql+psycopg://media:secret@db:5432/media",
	})
	s, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if s.DatabaseURL != "postgres://media:secret@db:5432/media" {
		t.Fatalf("SQLAlchemy 方言前缀应归一为 postgres://, got %q", s.DatabaseURL)
	}
}

func TestDatabaseURLFromPostgresParts(t *testing.T) {
	setEnv(t, map[string]string{
		"ADMIN_TOKEN":    "",
		"DATABASE_URL":   "",
		"POSTGRES_HOST":  "dbhost",
		"POSTGRES_PORT":  "55433",
		"POSTGRES_USER":  "u1",
		"POSTGRES_PASSWORD": "p1",
		"POSTGRES_DB":    "d1",
	})
	s, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	want := "postgres://u1:p1@dbhost:55433/d1"
	if s.DatabaseURL != want {
		t.Fatalf("拼接 URL = %q, want %q", s.DatabaseURL, want)
	}
}

func TestResolvePostgresHost(t *testing.T) {
	cases := []struct {
		in   string
		host string
		port *int
	}{
		{"", "", nil},
		{"dbhost", "dbhost", nil},
		{"dbhost:5433", "dbhost", ptrInt(5433)},
		{"postgres://u:p@[::1]:5434/d", "::1", ptrInt(5434)},
		{"[::1]", "::1", nil},
		{"[::1]:5435", "::1", ptrInt(5435)},
	}
	for _, tc := range cases {
		host, port := resolvePostgresHost(tc.in)
		if host != tc.host {
			t.Errorf("resolvePostgresHost(%q) host = %q, want %q", tc.in, host, tc.host)
		}
		if (port == nil) != (tc.port == nil) || (port != nil && *port != *tc.port) {
			t.Errorf("resolvePostgresHost(%q) port = %v, want %v", tc.in, port, tc.port)
		}
	}
}

func TestCookieSecureEffective(t *testing.T) {
	base := map[string]string{"ADMIN_TOKEN": "", "DATABASE_URL": "postgres://m:m@h:1/d"}

	setEnv(t, base)
	setEnv(t, map[string]string{"PUBLIC_BASE_URL": "https://example.com"})
	if s, _ := Load(); !s.CookieSecureEffective() {
		t.Error("https 部署应自动启用 Secure")
	}

	setEnv(t, base)
	setEnv(t, map[string]string{"PUBLIC_BASE_URL": "http://127.0.0.1:8080"})
	if s, _ := Load(); s.CookieSecureEffective() {
		t.Error("本地 http 不应启用 Secure")
	}

	setEnv(t, base)
	setEnv(t, map[string]string{"PUBLIC_BASE_URL": "http://x", "ADMIN_COOKIE_SECURE": "true"})
	if s, _ := Load(); !s.CookieSecureEffective() {
		t.Error("显式配置优先于自动推导")
	}
}

func TestCredentialWarnings(t *testing.T) {
	setEnv(t, map[string]string{
		"ADMIN_TOKEN":   "strong-token",
		"DATABASE_URL":  "postgres://m:m@h:1/d",
		"POSTGRES_HOST": "db",
	})
	s, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	warnings := s.CredentialWarnings()
	if len(warnings) == 0 {
		t.Fatal("change-me 数据库密码应产生警告")
	}
}

func TestEnvOptBoolNil(t *testing.T) {
	t.Setenv("SOMETHING_ELSE", "1")
	os.Unsetenv("ADMIN_COOKIE_SECURE")
	if envOptBool("ADMIN_COOKIE_SECURE") != nil {
		t.Fatal("未设置时应返回 nil")
	}
}

func ptrInt(v int) *int { return &v }
