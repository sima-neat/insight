package system

import (
	"bufio"
	"bytes"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// minCPUWindow is the shortest time a CPU reading measures over: a read sooner after the last
// repeats its value instead of measuring a few milliseconds.
const minCPUWindow = 500 * time.Millisecond

// Host is the machine Insight runs on, as System Info's "This computer" shows it. A reading
// that could not be taken is nil.
type Host struct {
	// CPUPercent is the CPU's use, all cores, since the reading before.
	CPUPercent *float64 `json:"cpu_percent"`
	Memory     *Usage   `json:"memory"`
	// Disk is the disk that holds Insight's data folder.
	Disk *Usage `json:"disk"`
}

// Usage is how much of a memory or a disk is used, in bytes.
type Usage struct {
	Total   uint64  `json:"total"`
	Used    uint64  `json:"used"`
	Percent float64 `json:"percent"`
	// Path is a disk's folder.
	Path string `json:"path,omitempty"`
}

// HostReader reads the host from /proc and the data folder's file system, never blocking: the
// CPU's use is the difference between this reading of /proc/stat and the one before, the first
// taken when the reader is made.
type HostReader struct {
	proc    string // /proc
	dataDir string

	mu    sync.Mutex
	last  cpuTimes
	at    time.Time
	value *float64
}

// cpuTimes are /proc/stat's CPU line: time busy and in all, in clock ticks.
type cpuTimes struct{ busy, total uint64 }

// NewHostReader makes a reader of the host; proc is /proc, dataDir Insight's data folder.
func NewHostReader(proc, dataDir string) *HostReader {
	h := &HostReader{proc: proc, dataDir: dataDir}
	if times, err := h.cpu(); err == nil {
		h.last, h.at = times, time.Now()
	}
	return h
}

// Read takes the host's readings.
func (h *HostReader) Read() Host {
	return Host{CPUPercent: h.cpuPercent(), Memory: h.memory(), Disk: h.disk()}
}

func (h *HostReader) cpuPercent() *float64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.at.IsZero() && time.Since(h.at) < minCPUWindow {
		return h.value
	}
	times, err := h.cpu()
	if err != nil {
		return nil
	}
	if !h.at.IsZero() && times.total > h.last.total && times.busy >= h.last.busy {
		percent := math.Round(1000*float64(times.busy-h.last.busy)/float64(times.total-h.last.total)) / 10
		h.value = &percent
	}
	h.last, h.at = times, time.Now()
	return h.value
}

// cpu reads /proc/stat's first line: user nice system idle iowait irq softirq steal (guest
// time is counted in user's already). Idle and iowait are not busy.
func (h *HostReader) cpu() (cpuTimes, error) {
	content, err := os.ReadFile(filepath.Join(h.proc, "stat"))
	if err != nil {
		return cpuTimes{}, err
	}
	line, _, _ := bytes.Cut(content, []byte("\n"))
	fields := strings.Fields(string(line))
	if len(fields) < 9 || fields[0] != "cpu" {
		return cpuTimes{}, fmt.Errorf("unexpected /proc/stat line %q", line)
	}
	var times cpuTimes
	for i, field := range fields[1:9] {
		value, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			return cpuTimes{}, err
		}
		times.total += value
		if i != 3 && i != 4 {
			times.busy += value
		}
	}
	return times, nil
}

// memory reads /proc/meminfo: used is what is not available, as `free` counts it.
func (h *HostReader) memory() *Usage {
	file, err := os.Open(filepath.Join(h.proc, "meminfo"))
	if err != nil {
		return nil
	}
	defer file.Close()
	values := map[string]uint64{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 {
			if value, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
				values[strings.TrimSuffix(fields[0], ":")] = value * 1024 // kB
			}
		}
	}
	total, available := values["MemTotal"], values["MemAvailable"]
	if total == 0 || available > total {
		return nil
	}
	return &Usage{Total: total, Used: total - available, Percent: percent(total-available, total)}
}

// disk is the use of the file system that holds the data folder, as df counts it: used of what
// is used and what this user may still fill.
func (h *HostReader) disk() *Usage {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(h.dataDir, &fs); err != nil {
		return nil
	}
	size := uint64(fs.Bsize)
	total, used := fs.Blocks*size, (fs.Blocks-fs.Bfree)*size
	return &Usage{Total: total, Used: used, Percent: percent(used, used+fs.Bavail*size), Path: h.dataDir}
}

func percent(part, whole uint64) float64 {
	if whole == 0 {
		return 0
	}
	return math.Round(1000*float64(part)/float64(whole)) / 10
}
