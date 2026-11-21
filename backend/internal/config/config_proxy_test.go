package config

import "testing"

func TestTrustedProxyCIDRsParsing(t *testing.T) {
	setEnv(t, map[string]string{
		"ADMIN_TOKEN":         "",
		"DATABASE_URL":        "postgres://media:media@127.0.0.1:55432/media",
		"TRUSTED_PROXY_CIDRS": "172.30.0.0/24, 10.0.0.1 ,2001:db8::1",
	})
	s, err := Load()
	if err != nil {
		t.Fatalf("合法 CIDR 列表不应报错: %v", err)
	}
	if len(s.TrustedProxies) != 3 {
		t.Fatalf("TrustedProxies 数量 = %d, want 3", len(s.TrustedProxies))
	}
	// 裸 IPv4 归一为 /32,裸 IPv6 归一为 /128。
	for _, want := range []string{"172.30.0.0/24", "10.0.0.1/32", "2001:db8::1/128"} {
		found := false
		for _, network := range s.TrustedProxies {
			if network.String() == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("缺少网段 %s, got %v", want, s.TrustedProxies)
		}
	}
}

func TestTrustedProxyCIDRsEmptyMeansNeverTrust(t *testing.T) {
	setEnv(t, map[string]string{
		"ADMIN_TOKEN":         "",
		"DATABASE_URL":        "postgres://media:media@127.0.0.1:55432/media",
		"TRUSTED_PROXY_CIDRS": "",
	})
	s, err := Load()
	if err != nil {
		t.Fatalf("空受信代理列表应合法: %v", err)
	}
	if len(s.TrustedProxies) != 0 {
		t.Fatalf("空配置应解析为 0 个网段, got %v", s.TrustedProxies)
	}
}

func TestTrustedProxyCIDRsRejectsInvalidEntry(t *testing.T) {
	setEnv(t, map[string]string{
		"ADMIN_TOKEN":         "",
		"DATABASE_URL":        "postgres://media:media@127.0.0.1:55432/media",
		"TRUSTED_PROXY_CIDRS": "172.30.0.0/24,not-an-ip",
	})
	if _, err := Load(); err == nil {
		t.Fatal("非法 TRUSTED_PROXY_CIDRS 必须拒绝启动")
	}
}
