package httpx

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func parseNets(t *testing.T, cidrs ...string) []*net.IPNet {
	t.Helper()
	nets := make([]*net.IPNet, 0, len(cidrs))
	for _, cidr := range cidrs {
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			t.Fatalf("测试 CIDR 无效 %q: %v", cidr, err)
		}
		nets = append(nets, network)
	}
	return nets
}

func filterRequest(remote string, forwarded ...string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = remote
	for _, value := range forwarded {
		r.Header.Add("X-Forwarded-For", value)
	}
	return r
}

func TestClientIPIgnoresForwardedForWithoutTrustedProxy(t *testing.T) {
	cases := []struct {
		name    string
		remote  string
		forward string
		want    string
	}{
		{"直连伪造 XFF", "198.51.100.9:5555", "203.0.113.5", "198.51.100.9"},
		{"直连伪造内网地址", "198.51.100.9:5555", "172.30.0.9", "198.51.100.9"},
		{"IPv6 直连", "[2001:db8::1]:443", "", "2001:db8::1"},
		{"空地址", "", "", "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := filterRequest(tc.remote)
			if tc.forward != "" {
				r.Header.Set("X-Forwarded-For", tc.forward)
			}
			if got := ClientIP(r, nil); got != tc.want {
				t.Fatalf("ClientIP = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClientIPUsesForwardedForFromTrustedProxy(t *testing.T) {
	trusted := parseNets(t, "172.30.0.0/24")
	cases := []struct {
		name    string
		remote  string
		forward []string
		want    string
	}{
		{"单跳", "172.30.0.2:41000", []string{"203.0.113.5"}, "203.0.113.5"},
		{"客户端自带前缀取最右非受信", "172.30.0.2:41000", []string{"1.1.1.1, 203.0.113.5"}, "203.0.113.5"},
		{"多级受信代理跳过", "172.30.0.2:41000", []string{"203.0.113.5, 172.30.0.3"}, "203.0.113.5"},
		{"全部受信时取最左", "172.30.0.2:41000", []string{"172.30.0.4, 172.30.0.3"}, "172.30.0.4"},
		{"非法条目忽略", "172.30.0.2:41000", []string{"not-an-ip, 203.0.113.5"}, "203.0.113.5"},
		{"带端口条目也解析", "172.30.0.2:41000", []string{"203.0.113.5:1234"}, "203.0.113.5"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := filterRequest(tc.remote, tc.forward...)
			if got := ClientIP(r, trusted); got != tc.want {
				t.Fatalf("ClientIP = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestClientIPUntrustedPeerCannotClaimProxyNetwork(t *testing.T) {
	trusted := parseNets(t, "172.30.0.0/24")
	r := filterRequest("198.51.100.9:5555", "172.30.0.2")
	if got := ClientIP(r, trusted); got != "198.51.100.9" {
		t.Fatalf("非受信对端不得采信 XFF, got %q", got)
	}
}
