package services

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"limedia/backend/internal/config"
)

func testGovernor() *TaskGovernor {
	settings := &config.Settings{
		ScanConcurrencyLimit: 1, ScanQueueLimit: 1, ScanWaitTimeoutSec: 0.2,
		DirectProbeConcurrencyLimit: 4, DirectProbeQueueLimit: 16, DirectProbeWaitTimeoutSec: 3,
		DerivativeConcurrencyLimit: 2, DerivativeQueueLimit: 32, DerivativeWaitTimeoutSec: 15,
		PreheatConcurrencyLimit: 3, PreheatQueueLimit: 64, PreheatWaitTimeoutSec: 2,
		StreamGlobalConcurrencyLimit: 2, StreamQueueLimit: 4, StreamWaitTimeoutSec: 0.2,
	}
	return NewTaskGovernor(settings)
}

func TestAcquireHonorsConcurrencyLimit(t *testing.T) {
	g := testGovernor()
	ctx := context.Background()

	s1, release1, err := g.Slot(ctx, TaskTypeStream, 50, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = s1
	_, release2, err := g.Slot(ctx, TaskTypeStream, 50, nil)
	if err != nil {
		t.Fatal(err)
	}

	// 第 3 个并发获取应超时拒绝(全局并发 2,队列等 0.2s)。
	_, _, err = g.Slot(ctx, TaskTypeStream, 50, nil)
	var rejected *TaskRejected
	if !errors.As(err, &rejected) {
		t.Fatalf("第 3 个并发获取应 TaskRejected, got %v", err)
	}

	release1()
	release2()
}

func TestQueueFullRejectedImmediately(t *testing.T) {
	g := testGovernor()
	ctx := context.Background()

	// 占满并发(2)后,并行让 4 个排队者入队(队列上限 4)。
	var releases []func()
	for i := 0; i < 2; i++ {
		_, rel, err := g.Slot(ctx, TaskTypeStream, 50, nil)
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, rel)
	}

	// 排队者会在 0.2s 超时前留在队列;并行发起保证全部入队。
	queued := make(chan error, 4)
	for i := 0; i < 4; i++ {
		go func() {
			_, rel, err := g.Slot(ctx, TaskTypeStream, 50, nil)
			if err == nil {
				rel()
			}
			queued <- err
		}()
	}
	time.Sleep(100 * time.Millisecond)

	// 队列已满 → 立即拒绝。
	_, _, err := g.Slot(ctx, TaskTypeStream, 50, nil)
	var rejected *TaskRejected
	if !errors.As(err, &rejected) || rejected.RetryAfter != 1 {
		t.Fatalf("队列满应立即拒绝, got %v", err)
	}
	// 排队者最终全部超时退出(无人释放)。
	for i := 0; i < 4; i++ {
		select {
		case <-queued:
		case <-time.After(2 * time.Second):
			t.Fatal("排队者应在超时后退出")
		}
	}
	for _, rel := range releases {
		rel()
	}
}

func TestCancelUnblocksWaiter(t *testing.T) {
	g := testGovernor()
	ctx := context.Background()

	// 占满全部并发位,等待者必须排队。
	_, relA, _ := g.Slot(ctx, TaskTypeStream, 50, nil)
	_, relB, _ := g.Slot(ctx, TaskTypeStream, 50, nil)

	cancelCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() {
		_, _, err := g.Slot(cancelCtx, TaskTypeStream, 50, nil)
		done <- err
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		var cancelled *TaskCancelled
		if !errors.As(err, &cancelled) {
			t.Fatalf("取消应返回 TaskCancelled, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("取消应在合理时间内解除等待")
	}
	relA()
	relB()
}

func TestReleaseGrantsHighestPriorityWaiter(t *testing.T) {
	g := testGovernor()
	ctx := context.Background()

	// 占满并发位(全局并发 2),再让等待者排队。
	_, relA, _ := g.Slot(ctx, TaskTypeStream, 50, nil)
	_, relB, _ := g.Slot(ctx, TaskTypeStream, 50, nil)

	// 三个等待者:低(50)、高(10)、中(30)。
	acquired := make(chan string, 3)
	for _, p := range []struct {
		name string
		prio int
	}{{"low", 50}, {"high", 10}, {"mid", 30}} {
		go func(name string, prio int) {
			_, rel, err := g.Slot(ctx, TaskTypeStream, prio, nil)
			if err != nil {
				acquired <- "err:" + name
				return
			}
			defer rel()
			acquired <- name
		}(p.name, p.prio)
	}
	time.Sleep(100 * time.Millisecond) // 等待者就位

	relA()
	first := <-acquired
	if first != "high" {
		t.Fatalf("最高优先级应先获得槽位, got %s", first)
	}
	// 清理:其余等待者最终获得或超时退出。
	for i := 0; i < 2; i++ {
		select {
		case <-acquired:
		case <-time.After(3 * time.Second):
		}
	}
	relB()
}

func TestInFlightRegistryCoalesces(t *testing.T) {
	g := testGovernor()
	r := NewInFlightRegistry(g.Metrics)

	var calls atomic.Int32
	started := make(chan struct{})
	release := make(chan struct{})

	var wg sync.WaitGroup
	var resultA any
	var errA error
	wg.Add(2)
	go func() {
		defer wg.Done()
		resultA, errA = r.Run(context.Background(), "k1", TaskTypeDerivative, 3*time.Second, func() (any, error) {
			calls.Add(1)
			close(started)
			<-release
			return "owner-result", nil
		})
	}()
	<-started
	var resultB any
	var errB error
	go func() {
		defer wg.Done()
		resultB, errB = r.Run(context.Background(), "k1", TaskTypeDerivative, 3*time.Second, func() (any, error) {
			return "should-not-run", nil
		})
	}()
	time.Sleep(100 * time.Millisecond)
	if !r.Contains("k1") {
		t.Fatal("执行中的键应可见")
	}
	close(release)
	wg.Wait()

	if calls.Load() != 1 {
		t.Fatalf("操作应只执行一次, got %d", calls.Load())
	}
	if errA != nil || errB != nil {
		t.Fatalf("等待不应报错: %v / %v", errA, errB)
	}
	if resultA != "owner-result" || resultB != "owner-result" {
		t.Fatalf("合并调用应复用 owner 结果: %v / %v", resultA, resultB)
	}
}

func TestInFlightRegistryWaitTimeout(t *testing.T) {
	g := testGovernor()
	r := NewInFlightRegistry(g.Metrics)

	release := make(chan struct{})
	go func() {
		_, _ = r.Run(context.Background(), "slow", TaskTypeScan, time.Second, func() (any, error) {
			<-release
			return nil, nil
		})
	}()
	time.Sleep(50 * time.Millisecond)

	_, err := r.Run(context.Background(), "slow", TaskTypeScan, 30*time.Millisecond, func() (any, error) {
		return nil, nil
	})
	close(release)
	var rejected *TaskRejected
	if !errors.As(err, &rejected) {
		t.Fatalf("等待超时应 TaskRejected, got %v", err)
	}
}

func TestDerivativeKeyFormat(t *testing.T) {
	id := uuid.MustParse("00000000-0000-4000-8000-000000000001")
	got := DerivativeKey(id, "20260906-ratio-v1", 240)
	want := "00000000-0000-4000-8000-000000000001:20260906-ratio-v1:240"
	if got != want {
		t.Fatalf("key = %s, want %s", got, want)
	}
}
