package httpx

import (
	"net"
	"net/http"
	"strings"
)

// ClientIP 解析客户端地址,用作登录限流键与审计日志来源。
//
// X-Forwarded-For 由客户端任意填写,只有直连对端是受信代理时才可采信;
// 采信时从右向左取第一个非受信地址(标准代理链语义),客户端自带的前缀
// 无法覆盖真实来源。未配置受信代理(空列表)时一律使用 RemoteAddr。
func ClientIP(r *http.Request, trusted []*net.IPNet) string {
	peer := hostOnly(r.RemoteAddr)
	peerIP := net.ParseIP(peer)
	if peerIP == nil || !IPInNets(peerIP, trusted) {
		if peer == "" {
			return "unknown"
		}
		return peer
	}

	entries := forwardedFor(r)
	candidate := peer
	for i := len(entries) - 1; i >= 0; i-- {
		ip := parseForwardedIP(entries[i])
		if ip == nil {
			// 非法条目不能成为限流键,继续向链上寻找。
			continue
		}
		candidate = ip.String()
		if !IPInNets(ip, trusted) {
			return candidate
		}
	}
	return candidate
}

// IPInNets 判断 IP 是否落在任一网段内。
func IPInNets(ip net.IP, nets []*net.IPNet) bool {
	for _, network := range nets {
		if network != nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

// hostOnly 去掉 RemoteAddr 的端口;兼容 "1.2.3.4:80" 与 "[::1]:80"。
func hostOnly(addr string) string {
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return strings.Trim(host, "[]")
	}
	return strings.Trim(addr, "[]")
}

// forwardedFor 展开所有 X-Forwarded-For 头的逗号分隔条目。
func forwardedFor(r *http.Request) []string {
	var entries []string
	for _, value := range r.Header.Values("X-Forwarded-For") {
		for _, part := range strings.Split(value, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				entries = append(entries, trimmed)
			}
		}
	}
	return entries
}

// parseForwardedIP 接受裸 IP 或带方括号的 IPv6(个别代理会附带端口)。
func parseForwardedIP(entry string) net.IP {
	if ip := net.ParseIP(strings.Trim(entry, "[]")); ip != nil {
		return ip
	}
	if host, _, err := net.SplitHostPort(entry); err == nil {
		return net.ParseIP(strings.Trim(host, "[]"))
	}
	return nil
}
