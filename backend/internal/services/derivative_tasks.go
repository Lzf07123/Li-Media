// derivative_tasks.go 对齐原 app/services/derivative_tasks.py:
// 有界执行的派生任务封装(本地 ffmpeg / 远程官方缩略图)。
package services

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"limedia/backend/internal/config"
	"limedia/backend/internal/models"
)

// DerivativePriority 尺寸对应的任务优先级(小尺寸优先)。
func DerivativePriority(maxSize int) int {
	switch maxSize {
	case 240:
		return 0
	case 480:
		return 1
	case 768:
		return 2
	case 1280:
		return 3
	default:
		return 50
	}
}

// DerivativeTasks 有界派生执行器(依赖注入 governor 与 in-flight 注册表)。
type DerivativeTasks struct {
	Settings  *config.Settings
	Governor  *TaskGovernor
	InFlight  *InFlightRegistry
}

// RunLocalDerivative 单尺寸本地派生:槽位内执行,同键请求合并等待。
func (d *DerivativeTasks) RunLocalDerivative(
	ctx context.Context,
	sourcePath, mediaRoot string,
	memory *models.Memory,
	maxSize int,
	priorityOverride *int,
	failureSink map[string]string,
) (*string, error) {
	key := DerivativeKey(memory.ID, d.Settings.MediaDerivativeVersion, maxSize)

	operation := func() (any, error) {
		_, release, err := d.Governor.Slot(ctx, TaskTypeDerivative, derefPriority(priorityOverride, DerivativePriority(maxSize)), nil)
		if err != nil {
			return nil, err
		}
		defer release()
		result := CreateMemoryDerivative(sourcePath, mediaRoot, memory.Kind, memory.ID, maxSize, failureSink, d.Settings)
		return result, nil
	}

	raw, err := d.InFlight.Run(ctx, key, TaskTypeDerivative,
		durSec(d.Settings.DerivativeWaitTimeoutSec), operation)
	if err != nil {
		return nil, err
	}
	result, _ := raw.(*string)
	return result, nil
}

// RunLocalDerivatives 一次槽位生成多尺寸;每 size 注册独立 in-flight key。
// 批量注册语义对齐 Python run_many:已是 owner 的键照常执行,重复工作有界。
func (d *DerivativeTasks) RunLocalDerivatives(
	ctx context.Context,
	sourcePath, mediaRoot string,
	memory *models.Memory,
	maxSizes []int,
	priorityOverride *int,
	failureSink map[string]string,
) map[int]*string {
	sizes := dedupeInts(maxSizes)

	// 每尺寸独立注册;此处直接走 governor 槽位(合并由 RunLocalDerivative 承担)。
	priority := minPriority(sizes)
	if priorityOverride != nil {
		priority = *priorityOverride
	}
	_, release, err := d.Governor.Slot(ctx, TaskTypeDerivative, priority, nil)
	if err != nil {
		setFailureKind(failureSink, models.DerivativeFailureQueueRejected)
		return nilResult(sizes)
	}
	defer release()

	generated := CreateMemoryDerivatives(sourcePath, mediaRoot, memory.Kind, memory.ID, sizes, failureSink, d.Settings)
	return generated
}

// RunRemoteDerivative 远程派生:取官方缩略图转存本地缓存。
// remoteThumbnails 由 M3d 接入后填充实现体。
func (d *DerivativeTasks) RunRemoteDerivative(
	ctx context.Context,
	client *BaiduPanClient,
	remoteID, mediaRoot string,
	memory *models.Memory,
	maxSize int,
	priorityOverride *int,
	failureSink map[string]string,
) (*string, error) {
	key := DerivativeKey(memory.ID, d.Settings.MediaDerivativeVersion, maxSize)

	operation := func() (any, error) {
		_, release, err := d.Governor.Slot(ctx, TaskTypeDerivative, derefPriority(priorityOverride, DerivativePriority(maxSize)), nil)
		if err != nil {
			return nil, err
		}
		defer release()
		return CreateRemoteThumbnail(ctx, d.Settings, client, remoteID, mediaRoot, memory, maxSize, failureSink)
	}

	raw, err := d.InFlight.Run(ctx, key, TaskTypeDerivative,
		durSec(d.Settings.DerivativeWaitTimeoutSec), operation)
	if err != nil {
		return nil, err
	}
	result, _ := raw.(*string)
	return result, nil
}

func derefPriority(override *int, fallback int) int {
	if override != nil {
		return *override
	}
	return fallback
}

func minPriority(sizes []int) int {
	best := 50
	for _, size := range sizes {
		if p := DerivativePriority(size); p < best {
			best = p
		}
	}
	return best
}

func nilResult(sizes []int) map[int]*string {
	result := make(map[int]*string, len(sizes))
	for _, size := range sizes {
		result[size] = nil
	}
	return result
}

var _ = fmt.Sprintf // fmt 保留位
var _ = uuid.UUID{} // uuid 保留位
