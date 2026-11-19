// resource_metrics.go 对齐原 app/services/resource_metrics.py:
// 轻量的进程与 cgroup 资源计数读取。
//
// 实现路线差异(有意为之):Python 依赖 Linux /proc 与 gc 模块;Go 用
// syscall.Getrusage / /proc 直读 / runtime.MemStats 对齐语义。数值
// (RSS、线程数、GC 代际)与 Python 版不逐字节一致,仅口径对齐。
package services

import (
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ---- 契约结构(字段名与序对齐 responses.ResourceStatus) ----

// ResourceProcessStatus 进程内存与线程计数。
type ResourceProcessStatus struct {
	RSSKBytes *int `json:"rss_kbytes"`
	Threads   *int `json:"threads"`
	PSSKBytes *int `json:"pss_kbytes"`
}

// ResourceGCStatus 垃圾回收计数(Go 以 NumGC 对齐 collections;
// 分代计数无对应语义,gen0 以堆上对象数近似,gen1/gen2 恒 0)。
type ResourceGCStatus struct {
	Gen0        int `json:"gen0"`
	Gen1        int `json:"gen1"`
	Gen2        int `json:"gen2"`
	Collections int `json:"collections"`
}

// ResourceTemporaryRegistryStatus 进程内临时文件注册表。
type ResourceTemporaryRegistryStatus struct {
	Paths int `json:"paths"`
}

// ResourceCgroupStatus cgroup 内存与 pids 计数(容器外读取失败即 nil)。
type ResourceCgroupStatus struct {
	MemoryCurrentBytes *int64 `json:"memory_current_bytes"`
	MemoryPeakBytes    *int64 `json:"memory_peak_bytes"`
	MemoryMaxBytes     *int64 `json:"memory_max_bytes"`
	PidsCurrent        *int64 `json:"pids_current"`
	PidsMax            *int64 `json:"pids_max"`
	OOM                int    `json:"oom"`
	OOMKill            int    `json:"oom_kill"`
}

// ResourceDiskStatus 磁盘用量。
type ResourceDiskStatus struct {
	FreeBytes  *int64   `json:"free_bytes"`
	TotalBytes *int64   `json:"total_bytes"`
	UsedBytes  *int64   `json:"used_bytes"`
	UsageRatio *float64 `json:"usage_ratio"`
}

// ResourceTemporaryStatus 临时目录用量(计数 + 磁盘,对齐合并字典)。
type ResourceTemporaryStatus struct {
	Files      int      `json:"files"`
	Bytes      int      `json:"bytes"`
	FreeBytes  *int64   `json:"free_bytes"`
	TotalBytes *int64   `json:"total_bytes"`
	UsedBytes  *int64   `json:"used_bytes"`
	UsageRatio *float64 `json:"usage_ratio"`
}

// ResourceDirectoryUsage 本地缓存目录用量(不含文件名与绝对路径)。
type ResourceDirectoryUsage struct {
	Files  int    `json:"files"`
	Bytes  int    `json:"bytes"`
	Status string `json:"status"`
}

// ResourceCachesStatus 派生缓存/临时/nginx 缓存用量。
type ResourceCachesStatus struct {
	DerivedThumbnails ResourceDirectoryUsage `json:"derived_thumbnails"`
	Temporary         ResourceDirectoryUsage `json:"temporary"`
	Nginx             ResourceDirectoryUsage `json:"nginx"`
}

// ResourceStackStatus 栈软硬限制(RLIM_INFINITY 读取为 null)。
type ResourceStackStatus struct {
	SoftKBytes *int64 `json:"soft_kbytes"`
	HardKBytes *int64 `json:"hard_kbytes"`
}

// ResourceLimitStatus 配置注入的容量上限。
type ResourceLimitStatus struct {
	BackendMemoryBytes *int64 `json:"backend_memory_bytes"`
	TempDiskQuotaBytes *int64 `json:"temp_disk_quota_bytes"`
	TempMaxFiles       *int   `json:"temp_max_files"`
}

// ResourceStatus 对齐 responses.ResourceStatus。
type ResourceStatus struct {
	Process           ResourceProcessStatus         `json:"process"`
	GarbageCollection ResourceGCStatus              `json:"garbage_collection"`
	TemporaryRegistry ResourceTemporaryRegistryStatus `json:"temporary_registry"`
	Cgroup            ResourceCgroupStatus          `json:"cgroup"`
	Temporary         ResourceTemporaryStatus       `json:"temporary"`
	Filesystem        ResourceDiskStatus            `json:"filesystem"`
	Caches            ResourceCachesStatus          `json:"caches"`
	Stack             ResourceStackStatus           `json:"stack"`
	Limits            ResourceLimitStatus           `json:"limits"`
}

// ---- /proc 与 cgroup 读取 ----

func readCgroupInt(path string) *int64 {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	text := strings.TrimSpace(string(data))
	if text == "" || text == "max" {
		return nil
	}
	value, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return nil
	}
	return &value
}

// readProcStatus Linux /proc/self/status:VmRSS(KB)与线程数。
func readProcStatus() (*int, *int) {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return nil, nil
	}
	var rss, threads *int
	for _, line := range strings.Split(string(data), "\n") {
		switch {
		case strings.HasPrefix(line, "VmRSS:"):
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if v, err := strconv.Atoi(fields[1]); err == nil {
					rss = &v
				}
			}
		case strings.HasPrefix(line, "Threads:"):
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if v, err := strconv.Atoi(fields[1]); err == nil {
					threads = &v
				}
			}
		}
	}
	return rss, threads
}

// readSelfRSSKBytes getrusage 回退:Linux ru_maxrss 单位 KB,macOS 为字节。
func readSelfRSSKBytes() *int {
	var usage syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &usage); err != nil {
		return nil
	}
	rss := int(usage.Maxrss)
	if runtime.GOOS != "linux" {
		rss /= 1024
	}
	return &rss
}

func readThreadCount() *int {
	if threads := pprof.Lookup("threadcreate"); threads != nil {
		count := threads.Count()
		return &count
	}
	return nil
}

func readPSSKBytes() *int {
	data, err := os.ReadFile("/proc/self/smaps_rollup")
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "Pss:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if v, err := strconv.Atoi(fields[1]); err == nil {
					return &v
				}
			}
		}
	}
	return nil
}

func readMemoryEvents() (int, int) {
	data, err := os.ReadFile("/sys/fs/cgroup/memory.events")
	if err != nil {
		return 0, 0
	}
	oom, oomKill := 0, 0
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		parts := strings.Fields(line)
		if len(parts) != 2 {
			continue
		}
		value, err := strconv.Atoi(parts[1])
		if err != nil {
			continue
		}
		switch parts[0] {
		case "oom":
			oom = value
		case "oom_kill":
			oomKill = value
		}
	}
	return oom, oomKill
}

func readStackLimits() ResourceStackStatus {
	status := ResourceStackStatus{}
	var rlim syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_STACK, &rlim); err == nil {
		const rlimInfinity = ^uint64(0)
		if uint64(rlim.Cur) != rlimInfinity {
			soft := int64(rlim.Cur)
			status.SoftKBytes = &soft
		}
		if uint64(rlim.Max) != rlimInfinity {
			hard := int64(rlim.Max)
			status.HardKBytes = &hard
		}
	}
	return status
}

// ---- 磁盘与目录用量 ----

// diskUsageForPath shutil.disk_usage 语义:used 含保留块(Blocks-Bfree)。
func diskUsageForPath(directory string) (*ResourceDiskStatus, bool) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(directory, &stat); err != nil {
		return nil, false
	}
	blockSize := int64(stat.Bsize)
	total := int64(stat.Blocks) * blockSize
	free := int64(stat.Bavail) * blockSize
	used := (int64(stat.Blocks) - int64(stat.Bfree)) * blockSize

	status := &ResourceDiskStatus{
		FreeBytes:  &free,
		TotalBytes: &total,
		UsedBytes:  &used,
	}
	if total > 0 {
		ratio := math.Round(float64(used)/float64(total)*10000) / 10000
		status.UsageRatio = &ratio
	}
	return status, true
}

// resolveDiskDirectory 对齐 _read_disk 的目录选择:优先已存在的目录,
// 其次其父目录,最后文件系统根(容器视角,避免误导性 null)。
func resolveDiskDirectory(directory string) string {
	if resolved, err := filepath.EvalSymlinks(directory); err == nil {
		directory = resolved
	} else if abs, absErr := filepath.Abs(directory); absErr == nil {
		directory = abs
	}
	if info, err := os.Stat(directory); err == nil && info.IsDir() {
		return directory
	}
	parent := filepath.Dir(directory)
	if info, err := os.Stat(parent); err == nil && info.IsDir() {
		return parent
	}
	return string(filepath.Separator)
}

func readDisk(directory string) *ResourceDiskStatus {
	chosen := resolveDiskDirectory(directory)
	status, ok := diskUsageForPath(chosen)
	if !ok {
		return &ResourceDiskStatus{}
	}
	return status
}

// readDirectoryUsage 有界遍历:计数本地缓存文件与字节,不暴露路径。
func readDirectoryUsage(directory string) ResourceDirectoryUsage {
	const maxFiles = 50_000
	const timeoutSeconds = 2.0
	startedAt := time.Now()

	if info, err := os.Stat(directory); err != nil {
		// Python exists() 对任何 OSError 返回 False → {"ok"}。
		return ResourceDirectoryUsage{Files: 0, Bytes: 0, Status: "ok"}
	} else if !info.IsDir() {
		return ResourceDirectoryUsage{Files: 0, Bytes: 0, Status: "unavailable"}
	}

	files := 0
	var bytesSeen int64
	stack := []string{directory}
	for len(stack) > 0 {
		if files >= maxFiles {
			return ResourceDirectoryUsage{Files: 0, Bytes: 0, Status: "truncated"}
		}
		if time.Since(startedAt).Seconds() > timeoutSeconds {
			return ResourceDirectoryUsage{Files: 0, Bytes: 0, Status: "timeout"}
		}

		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		entries, err := os.ReadDir(current)
		if err != nil {
			return ResourceDirectoryUsage{Files: 0, Bytes: 0, Status: "unavailable"}
		}
		for _, entry := range entries {
			if entry.Type()&fs.ModeSymlink != 0 {
				continue
			}
			if entry.IsDir() {
				stack = append(stack, filepath.Join(current, entry.Name()))
				continue
			}
			if files >= maxFiles {
				return ResourceDirectoryUsage{Files: 0, Bytes: 0, Status: "truncated"}
			}
			info, statErr := entry.Info()
			if statErr != nil {
				return ResourceDirectoryUsage{Files: 0, Bytes: 0, Status: "unavailable"}
			}
			if !info.Mode().IsRegular() {
				continue
			}
			files++
			bytesSeen += info.Size()
			if time.Since(startedAt).Seconds() > timeoutSeconds {
				return ResourceDirectoryUsage{Files: 0, Bytes: 0, Status: "timeout"}
			}
		}
	}
	return ResourceDirectoryUsage{Files: files, Bytes: int(bytesSeen), Status: "ok"}
}

// ---- 聚合入口 ----

// CollectResourceMetrics 汇集进程、cgroup 与缓存目录的轻量指标
// (对齐 collect_resource_metrics;limit 参数为注入配置的可选值)。
func CollectResourceMetrics(
	mediaRoot string,
	backendMemoryLimitBytes *int64,
	tempDiskQuotaBytes *int64,
	tempMaxFiles *int,
	nginxCacheRoot string,
) *ResourceStatus {
	rss, threads := readProcStatus()
	if rss == nil {
		rss = readSelfRSSKBytes()
	}
	if threads == nil {
		threads = readThreadCount()
	}

	temporaryDir := filepath.Join(mediaRoot, "tmp")
	filesystemDir := mediaRoot
	if info, err := os.Stat(mediaRoot); err != nil || !info.IsDir() {
		filesystemDir = temporaryDir
	}

	derivedCache := readDirectoryUsage(filepath.Join(mediaRoot, "thumbnails"))
	// tmp 目录只走一遍遍历:计数与字节直接复用目录用量结果。
	temporaryCache := readDirectoryUsage(temporaryDir)
	nginxDir := nginxCacheRoot
	if nginxDir == "" {
		nginxDir = filepath.Join(mediaRoot, "nginx_cache")
	}
	nginxCache := readDirectoryUsage(nginxDir)

	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	oom, oomKill := readMemoryEvents()

	temporaryDisk := ResourceDiskStatus{}
	if status, ok := diskUsageForPath(resolveDiskDirectory(temporaryDir)); ok {
		temporaryDisk = *status
	}

	return &ResourceStatus{
		Process: ResourceProcessStatus{
			RSSKBytes: rss,
			Threads:   threads,
			PSSKBytes: readPSSKBytes(),
		},
		GarbageCollection: ResourceGCStatus{
			Gen0:        int(memStats.HeapObjects),
			Gen1:        0,
			Gen2:        0,
			Collections: int(memStats.NumGC),
		},
		TemporaryRegistry: ResourceTemporaryRegistryStatus{
			Paths: TemporaryRegistrySize(),
		},
		Cgroup: ResourceCgroupStatus{
			MemoryCurrentBytes: readCgroupInt("/sys/fs/cgroup/memory.current"),
			MemoryPeakBytes:    readCgroupInt("/sys/fs/cgroup/memory.peak"),
			MemoryMaxBytes:     readCgroupInt("/sys/fs/cgroup/memory.max"),
			PidsCurrent:        readCgroupInt("/sys/fs/cgroup/pids.current"),
			PidsMax:            readCgroupInt("/sys/fs/cgroup/pids.max"),
			OOM:                oom,
			OOMKill:            oomKill,
		},
		Temporary: ResourceTemporaryStatus{
			Files:      temporaryCache.Files,
			Bytes:      temporaryCache.Bytes,
			FreeBytes:  temporaryDisk.FreeBytes,
			TotalBytes: temporaryDisk.TotalBytes,
			UsedBytes:  temporaryDisk.UsedBytes,
			UsageRatio: temporaryDisk.UsageRatio,
		},
		Filesystem: *readDisk(filesystemDir),
		Caches: ResourceCachesStatus{
			DerivedThumbnails: derivedCache,
			Temporary:         temporaryCache,
			Nginx:             nginxCache,
		},
		Stack: readStackLimits(),
		Limits: ResourceLimitStatus{
			BackendMemoryBytes: backendMemoryLimitBytes,
			TempDiskQuotaBytes: tempDiskQuotaBytes,
			TempMaxFiles:       tempMaxFiles,
		},
	}
}
