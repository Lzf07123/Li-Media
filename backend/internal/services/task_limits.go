// task_limits.go 对齐原 app/services/task_limits.py:
// 各任务类型的进程内有界队列总督 + 指标 + in-flight 合并注册表。
package services

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"

	"limedia/backend/internal/config"
)

type TaskType string

const (
	TaskTypeScan        TaskType = "scan"
	TaskTypeDirectProbe TaskType = "direct_probe"
	TaskTypeDerivative  TaskType = "derivative"
	TaskTypePreheat     TaskType = "preheat"
	TaskTypeStream      TaskType = "stream"
)

// TaskRejected 无法进入有界队列(队列满/等待超时)。
type TaskRejected struct {
	Detail     string
	RetryAfter float64
}

func (e *TaskRejected) Error() string { return e.Detail }

// TaskCancelled 等待槽位期间被取消(对齐 TaskCancelled)。
type TaskCancelled struct{}

func (e *TaskCancelled) Error() string { return "task cancelled" }

// TaskSlot 一次成功 acquire 的凭据,release 时归还。
type TaskSlot struct {
	TaskType       TaskType
	StartedAt      time.Time
	QueuedSeconds  float64
}

type waiter struct {
	priority int
	sequence int
	granted  bool
}

// TaskGovernor 每任务类型独立限制 active 与 waiter 数。
type TaskGovernor struct {
	settings *config.Settings

	mu      sync.Mutex
	active  map[TaskType]int
	waiters map[TaskType][]*waiter
	sequence int

	Metrics *TaskMetrics
}

func NewTaskGovernor(settings *config.Settings) *TaskGovernor {
	return &TaskGovernor{
		settings: settings,
		active: map[TaskType]int{
			TaskTypeScan: 0, TaskTypeDirectProbe: 0, TaskTypeDerivative: 0,
			TaskTypePreheat: 0, TaskTypeStream: 0,
		},
		waiters: map[TaskType][]*waiter{
			TaskTypeScan: {}, TaskTypeDirectProbe: {}, TaskTypeDerivative: {},
			TaskTypePreheat: {}, TaskTypeStream: {},
		},
		Metrics: NewTaskMetrics(),
	}
}

func (g *TaskGovernor) policy(tt TaskType) (maxActive, maxQueue int, waitTimeout time.Duration) {
	s := g.settings
	switch tt {
	case TaskTypeScan:
		return s.ScanConcurrencyLimit, s.ScanQueueLimit, durSec(s.ScanWaitTimeoutSec)
	case TaskTypeDirectProbe:
		return s.DirectProbeConcurrencyLimit, s.DirectProbeQueueLimit, durSec(s.DirectProbeWaitTimeoutSec)
	case TaskTypeDerivative:
		return s.DerivativeConcurrencyLimit, s.DerivativeQueueLimit, durSec(s.DerivativeWaitTimeoutSec)
	case TaskTypePreheat:
		return s.PreheatConcurrencyLimit, s.PreheatQueueLimit, durSec(s.PreheatWaitTimeoutSec)
	default:
		return s.StreamGlobalConcurrencyLimit, s.StreamQueueLimit, durSec(s.StreamWaitTimeoutSec)
	}
}

func durSec(seconds float64) time.Duration {
	return time.Duration(seconds * float64(time.Second))
}

// Acquire 获取槽位;最多排队 max_queue 个任务,支持优先级插队。
// cancel 用 context.Context 取代 Python 的 cancel_event。
func (g *TaskGovernor) Acquire(ctx context.Context, tt TaskType, priority int, timeoutOverride *time.Duration) (*TaskSlot, error) {
	_, maxQueue, waitTimeout := g.policy(tt)
	timeout := waitTimeout
	if timeoutOverride != nil {
		timeout = *timeoutOverride
		if *timeoutOverride < 0 {
			timeout = 0
		}
	}
	deadline := time.Now().Add(timeout)

	g.mu.Lock()
	if g.canStartLocked(tt, priority) {
		g.active[tt]++
		g.mu.Unlock()
		g.Metrics.RecordStarted(tt)
		return &TaskSlot{TaskType: tt, StartedAt: time.Now()}, nil
	}

	if len(g.waiters[tt]) >= maxQueue {
		g.Metrics.RecordRejected(tt)
		g.mu.Unlock()
		return nil, &TaskRejected{Detail: fmt.Sprintf("%s 队列已满，请稍后重试", tt), RetryAfter: 1}
	}

	g.sequence++
	w := &waiter{priority: priority, sequence: g.sequence}
	g.waiters[tt] = append(g.waiters[tt], w)
	g.mu.Unlock()

	// 轮询等待授予:队列深度极小(≤1000),50ms 轮询成本可忽略;
	// 同时让 ctx 取消与超时都能及时退出。
	for {
		select {
		case <-ctx.Done():
			g.removeWaiter(tt, w, false)
			g.Metrics.RecordCancelled(tt)
			return nil, &TaskCancelled{}
		case <-time.After(50 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			g.removeWaiter(tt, w, false)
			g.Metrics.RecordCancelled(tt)
			return nil, &TaskRejected{Detail: fmt.Sprintf("%s 队列等待超时", tt), RetryAfter: 1}
		}

		g.mu.Lock()
		granted := w.granted
		queuedSeconds := timeout.Seconds() - time.Until(deadline).Seconds()
		g.mu.Unlock()
		if granted {
			g.Metrics.RecordStarted(tt)
			return &TaskSlot{TaskType: tt, StartedAt: time.Now(), QueuedSeconds: queuedSeconds}, nil
		}
	}
}

func (g *TaskGovernor) removeWaiter(tt TaskType, w *waiter, granted bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !granted {
		list := g.waiters[tt]
		for i, item := range list {
			if item == w {
				g.waiters[tt] = append(list[:i], list[i+1:]...)
				break
			}
		}
	}
}

// Release 归还槽位;有等待者且有空位时按 (priority, sequence) 授予。
func (g *TaskGovernor) Release(slot *TaskSlot) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.active[slot.TaskType] > 0 {
		g.active[slot.TaskType]--
	}
	maxActive, _, _ := g.policy(slot.TaskType)
	if waiters := g.waiters[slot.TaskType]; len(waiters) > 0 && g.active[slot.TaskType] < maxActive {
		best := 0
		for i, item := range waiters {
			if item.priority < waiters[best].priority ||
				(item.priority == waiters[best].priority && item.sequence < waiters[best].sequence) {
				best = i
			}
		}
		waiters[best].granted = true
		g.active[slot.TaskType]++
		g.waiters[slot.TaskType] = append(waiters[:best], waiters[best+1:]...)
	}
}

// Slot 便捷封装:函数返回后自动归还(对齐 Python slot contextmanager)。
func (g *TaskGovernor) Slot(ctx context.Context, tt TaskType, priority int, timeoutOverride *time.Duration) (*TaskSlot, func(), error) {
	slot, err := g.Acquire(ctx, tt, priority, timeoutOverride)
	if err != nil {
		return nil, nil, err
	}
	return slot, func() { g.Release(slot) }, nil
}

// canStartLocked active 未满且没有更高/同优先级等待者(防插队)。
func (g *TaskGovernor) canStartLocked(tt TaskType, priority int) bool {
	_, maxQueue, _ := g.policy(tt)
	_ = maxQueue
	if g.active[tt] >= g.policyLimit(tt) {
		return false
	}
	for _, item := range g.waiters[tt] {
		if item.priority <= priority {
			return false
		}
	}
	return true
}

func (g *TaskGovernor) policyLimit(tt TaskType) int {
	maxActive, _, _ := g.policy(tt)
	return maxActive
}

// Stats 队列快照(admin /tasks/metrics 与 system status 使用)。
func (g *TaskGovernor) Stats() map[string]map[string]any {
	out := make(map[string]map[string]any, 5)
	for _, tt := range []TaskType{TaskTypeScan, TaskTypeDirectProbe, TaskTypeDerivative, TaskTypePreheat, TaskTypeStream} {
		maxActive, maxQueue, waitTimeout := g.policy(tt)
		g.mu.Lock()
		stats := map[string]any{
			"active":              g.active[tt],
			"queued":              len(g.waiters[tt]),
			"limit":               maxActive,
			"queue_limit":         maxQueue,
			"wait_timeout_seconds": waitTimeout.Seconds(),
		}
		g.mu.Unlock()
		out[string(tt)] = stats
	}
	return out
}

// ---- TaskMetrics ----

type TaskMetrics struct {
	mu                 sync.Mutex
	counters           map[string]int
	waitTotalMS        int
	childPeakKbytes    int
	gcCollectedObjects int
}

func NewTaskMetrics() *TaskMetrics {
	return &TaskMetrics{counters: make(map[string]int)}
}

func (m *TaskMetrics) bump(name string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.counters == nil {
		m.counters = make(map[string]int)
	}
	m.counters[name]++
}

func (m *TaskMetrics) RecordStarted(tt TaskType)   { m.bump(string(tt) + ".started") }
func (m *TaskMetrics) RecordCompleted(tt TaskType) { m.bump(string(tt) + ".completed") }
func (m *TaskMetrics) RecordFailed(tt TaskType)    { m.bump(string(tt) + ".failed") }
func (m *TaskMetrics) RecordCancelled(tt TaskType) { m.bump(string(tt) + ".cancelled") }
func (m *TaskMetrics) RecordRejected(tt TaskType)  { m.bump(string(tt) + ".rejected") }
func (m *TaskMetrics) RecordCoalesced(tt TaskType) { m.bump(string(tt) + ".coalesced") }
func (m *TaskMetrics) RecordRateLimited(tt TaskType) {
	m.bump(string(tt) + ".baidu_rate_limited")
}

func (m *TaskMetrics) RecordWait(seconds float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if seconds > 0 {
		m.waitTotalMS += int(seconds * 1000)
	}
}

func (m *TaskMetrics) RecordChildPeakKbytes(v int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if v > m.childPeakKbytes {
		m.childPeakKbytes = v
	}
}

func (m *TaskMetrics) RecordGC(collected int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if collected > 0 {
		m.gcCollectedObjects += collected
	}
}

// Snapshot 指标快照(契约:计数器 + active_jobs/queue_depth 聚合)。
func (m *TaskMetrics) Snapshot() map[string]any {
	m.mu.Lock()
	counters := make(map[string]int, len(m.counters))
	for k, v := range m.counters {
		counters[k] = v
	}
	waitTotalMS := m.waitTotalMS
	childPeak := m.childPeakKbytes
	gcObjects := m.gcCollectedObjects
	m.mu.Unlock()

	out := make(map[string]any, len(counters)+4)
	for k, v := range counters {
		out[k] = v
	}
	// 调用方持有 governor 时用 WithGovernor 聚合队列深度。
	out["active_jobs"] = 0
	out["queue_depth"] = 0
	out["queue_wait_total_ms"] = waitTotalMS
	out["child_peak_kbytes"] = childPeak
	out["gc_collected_objects"] = gcObjects
	return out
}

// ---- InFlightRegistry:同键并发工作合并 ----

type inFlightCall struct {
	done   chan struct{}
	result any
	err    error
}

// InFlightRegistry 用可持久幂等键合并重复工作。
type InFlightRegistry struct {
	mu      sync.Mutex
	calls   map[string]*inFlightCall
	Metrics *TaskMetrics
}

func NewInFlightRegistry(metrics *TaskMetrics) *InFlightRegistry {
	return &InFlightRegistry{calls: make(map[string]*inFlightCall), Metrics: metrics}
}

// Run 相同 key 的并发调用合并为一次执行;非 owner 等待 owner 的结果,
// 超过 waitTimeout 抛 TaskRejected。
func (r *InFlightRegistry) Run(ctx context.Context, key string, tt TaskType, waitTimeout time.Duration, operation func() (any, error)) (any, error) {
	r.mu.Lock()
	if call, ok := r.calls[key]; ok {
		r.mu.Unlock()
		r.Metrics.RecordCoalesced(tt)
		timer := time.NewTimer(waitTimeout)
		defer timer.Stop()
		select {
		case <-call.done:
		case <-timer.C:
			return nil, &TaskRejected{Detail: fmt.Sprintf("%s 任务仍在执行", tt), RetryAfter: 1}
		case <-ctx.Done():
			return nil, &TaskCancelled{}
		}
		if call.err != nil {
			return nil, call.err
		}
		return call.result, nil
	}
	call := &inFlightCall{done: make(chan struct{})}
	r.calls[key] = call
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		delete(r.calls, key)
		r.mu.Unlock()
		close(call.done)
	}()

	result, err := operation()
	call.result = result
	call.err = err
	return result, err
}

// Contains 键是否在执行中。
func (r *InFlightRegistry) Contains(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.calls[key]
	return ok
}

// DerivativeKey 派生任务的幂等键。
func DerivativeKey(memoryID uuid.UUID, version string, maxSize int) string {
	return fmt.Sprintf("%s:%s:%d", memoryID, version, maxSize)
}

// ---- 临时文件注册表(跨任务共享的活跃路径) ----

var (
	temporaryMu    sync.Mutex
	temporaryPaths = make(map[string]bool)
)

func RegisterTemporaryPath(path string) {
	temporaryMu.Lock()
	defer temporaryMu.Unlock()
	temporaryPaths[path] = true
}

func UnregisterTemporaryPath(path string) {
	temporaryMu.Lock()
	defer temporaryMu.Unlock()
	delete(temporaryPaths, path)
}

func IsTemporaryPathActive(path string) bool {
	temporaryMu.Lock()
	defer temporaryMu.Unlock()
	return temporaryPaths[path]
}

func TemporaryRegistrySize() int {
	temporaryMu.Lock()
	defer temporaryMu.Unlock()
	return len(temporaryPaths)
}
