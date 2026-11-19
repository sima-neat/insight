package jobs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"insight/internal/supervisor"
)

// diagnosticLines is how many of ffmpeg's last other lines are kept for a failure's message.
const diagnosticLines = 8

// FFmpegProgress follows one ffmpeg run's "-progress pipe:1" output: blocks of key=value lines
// ("out_time_us=2933333" ... "progress=continue"), read from its stdout with its stderr merged in,
// as the supervisor runs it (RunFFmpeg). Every other line is a diagnostic, the last few kept for
// the message of a failed run.
type FFmpegProgress struct {
	// Duration is the length of the output when it is known (from ffprobe), else 0.
	Duration time.Duration

	elapsed     time.Duration
	hasElapsed  bool
	ended       bool
	diagnostics []string
}

// Line takes one line of ffmpeg's output and reports whether it moved the output time or ended
// the run.
func (f *FFmpegProgress) Line(line string) bool {
	line = strings.TrimSpace(line)
	if line == "" {
		return false
	}
	key, value, ok := progressField(line)
	if !ok {
		f.diagnostics = append(f.diagnostics, line)
		if len(f.diagnostics) > diagnosticLines {
			f.diagnostics = f.diagnostics[len(f.diagnostics)-diagnosticLines:]
		}
		return false
	}
	if key == "progress" {
		ended := value == "end"
		changed := ended && !f.ended
		f.ended = f.ended || ended
		return changed
	}
	elapsed, ok := outTime(key, value)
	if !ok || (f.hasElapsed && elapsed == f.elapsed) {
		return false
	}
	f.elapsed, f.hasElapsed = elapsed, true
	return true
}

// Elapsed is the output time ffmpeg has reached, false before it reports one.
func (f *FFmpegProgress) Elapsed() (time.Duration, bool) { return f.elapsed, f.hasElapsed }

// Ended says whether ffmpeg wrote "progress=end". It does so after a failure too.
func (f *FFmpegProgress) Ended() bool { return f.ended }

// Percent is the share of Duration reached, 0–100, false while either is unknown.
func (f *FFmpegProgress) Percent() (float64, bool) {
	if !f.hasElapsed || f.Duration <= 0 {
		return 0, false
	}
	return clampPercent(100 * f.elapsed.Seconds() / f.Duration.Seconds()), true
}

// Detail is the output time reached, with Duration when it is known: "00:25 / 01:00", "00:25",
// or "" before ffmpeg reports a time.
func (f *FFmpegProgress) Detail() string {
	if !f.hasElapsed {
		return ""
	}
	if f.Duration <= 0 {
		return clock(f.elapsed)
	}
	return clock(f.elapsed) + " / " + clock(f.Duration)
}

// Diagnostics are the last lines that were not progress, oldest first.
func (f *FFmpegProgress) Diagnostics() []string {
	return append([]string(nil), f.diagnostics...)
}

// Follow reports a move of an ffmpeg run's output time on the job: the share of its duration
// as the percent, when known, and the time reached as the detail. The phase is the caller's.
// A run that is one of several reports through a function of its own instead.
func (p *Progress) Follow(f *FFmpegProgress) {
	if percent, ok := f.Percent(); ok {
		p.SetPercent(percent)
	}
	p.SetDetail(f.Detail())
}

// stopTimeout bounds stopping an ffmpeg run whose work was cancelled.
const stopTimeout = 10 * time.Second

// RunFFmpeg runs ffmpeg as spec says (its arguments with "-progress pipe:1"), under start (the
// supervisor's Starter), and returns once it has ended: nil when it exited 0, else an error
// whose message is ffmpeg's last diagnostics. Each move of the output time, and the end, is
// handed to moved; duration is the output's length when it is known, else 0. When ctx ends,
// ffmpeg is stopped and ctx's error returned.
func RunFFmpeg(ctx context.Context, start supervisor.Starter, spec supervisor.Spec, duration time.Duration, moved func(*FFmpegProgress)) error {
	lines := &ffmpegLines{prefix: "[" + spec.Name + "] ", f: &FFmpegProgress{Duration: duration}, moved: moved}
	spec.Output = lines
	proc, err := start(spec)
	if err != nil {
		return err
	}
	select {
	case <-proc.Done():
	case <-ctx.Done():
		stop, cancel := context.WithTimeout(context.Background(), stopTimeout)
		defer cancel()
		_ = proc.Stop(stop)
		return ctx.Err()
	}
	if exit := proc.Status().LastExit; exit != "exit status 0" {
		return errors.New(lines.failure(exit))
	}
	return nil
}

// ffmpegLines takes a run's lines as the supervisor writes them ("[name] line") and follows them.
type ffmpegLines struct {
	prefix string
	moved  func(*FFmpegProgress)

	mu      sync.Mutex
	partial []byte
	f       *FFmpegProgress
}

func (l *ffmpegLines) Write(b []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.partial = append(l.partial, b...)
	for {
		line, rest, found := bytes.Cut(l.partial, []byte("\n"))
		if !found {
			break
		}
		if l.f.Line(strings.TrimPrefix(string(line), l.prefix)) {
			l.moved(l.f)
		}
		l.partial = append(l.partial[:0], rest...)
	}
	return len(b), nil
}

// failure says why a run that ended with exit failed: ffmpeg's last diagnostics, else exit.
func (l *ffmpegLines) failure(exit string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	lines := l.f.Diagnostics()
	if len(lines) == 0 {
		return "ffmpeg ended with " + exit
	}
	return strings.Join(lines[max(0, len(lines)-4):], "; ")
}

// progressField splits a progress line, a lower-case key and "=" at its start ("out_time_us=…",
// "stream_0_0_q=…"); any other line is a diagnostic, even with a "=" in it.
func progressField(line string) (key, value string, ok bool) {
	key, value, found := strings.Cut(line, "=")
	if !found || key == "" {
		return "", "", false
	}
	for i, c := range key {
		if !(c >= 'a' && c <= 'z' || c == '_' || i > 0 && c >= '0' && c <= '9') {
			return "", "", false
		}
	}
	return key, value, true
}

// outTime reads the output time from out_time_us, out_time_ms (also microseconds, an old ffmpeg
// mistake it keeps) or out_time ("00:00:02.933333", negative at the very start of some runs).
// "N/A" is no time; a negative one is 0.
func outTime(key, value string) (time.Duration, bool) {
	value = strings.TrimSpace(value)
	switch key {
	case "out_time_us", "out_time_ms":
		us, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return 0, false
		}
		return max(0, time.Duration(us)*time.Microsecond), true
	case "out_time":
		negative := strings.HasPrefix(value, "-")
		parts := strings.Split(strings.TrimPrefix(value, "-"), ":")
		if len(parts) != 3 {
			return 0, false
		}
		hours, err1 := strconv.Atoi(parts[0])
		minutes, err2 := strconv.Atoi(parts[1])
		seconds, err3 := strconv.ParseFloat(parts[2], 64)
		if err1 != nil || err2 != nil || err3 != nil {
			return 0, false
		}
		if negative {
			return 0, true
		}
		// To the microsecond, as ffmpeg writes it, so that it equals out_time_us in the same block.
		total := time.Duration(hours)*time.Hour + time.Duration(minutes)*time.Minute +
			time.Duration(math.Round(seconds*1e6))*time.Microsecond
		return total, true
	}
	return 0, false
}

// clock writes d as the old backend did: "01:05" under an hour, "1:02:03" from one, whole seconds.
func clock(d time.Duration) string {
	total := int(max(0, d) / time.Second)
	hours, minutes, seconds := total/3600, total/60%60, total%60
	if hours > 0 {
		return fmt.Sprintf("%d:%02d:%02d", hours, minutes, seconds)
	}
	return fmt.Sprintf("%02d:%02d", minutes, seconds)
}
