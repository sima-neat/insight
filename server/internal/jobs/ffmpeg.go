package jobs

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"
)

const (
	// diagnosticLines is how many of ffmpeg's last other lines are kept for a failure's message.
	diagnosticLines = 8
	// maxLineBytes cuts a longer line, so that reading never stops while ffmpeg still writes.
	maxLineBytes = 4096
)

// FFmpegProgress follows one ffmpeg run's "-progress pipe:1" output: blocks of key=value lines
// ("out_time_us=2933333" ... "progress=continue"), read from its stdout with its stderr merged in,
// as Insight runs ffmpeg for long work. Every other line is a diagnostic, the last few kept for
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

// FollowFFmpeg reads ffmpeg's output from r until it ends, reporting the output time reached on
// progress as a percent of duration (none when duration is 0) and as its detail. The phase is the
// caller's. It returns what it followed, for the diagnostics of a failed run, and a read error.
func FollowFFmpeg(r io.Reader, duration time.Duration, progress *Progress) (*FFmpegProgress, error) {
	return FollowFFmpegWith(r, duration, func(f *FFmpegProgress) {
		if percent, ok := f.Percent(); ok {
			progress.SetPercent(percent)
		}
		progress.SetDetail(f.Detail())
	})
}

// FollowFFmpegWith reads ffmpeg's output as FollowFFmpeg does, but hands each move of the output
// time, and the end, to moved, for work that reports one run as part of a larger whole (one file
// of several).
func FollowFFmpegWith(r io.Reader, duration time.Duration, moved func(*FFmpegProgress)) (*FFmpegProgress, error) {
	f := &FFmpegProgress{Duration: duration}
	lines := bufio.NewScanner(r)
	lines.Buffer(make([]byte, 0, maxLineBytes), maxLineBytes)
	lines.Split(splitLines())
	for lines.Scan() {
		if f.Line(lines.Text()) {
			moved(f)
		}
	}
	if err := lines.Err(); err != nil {
		return f, fmt.Errorf("reading ffmpeg's output: %w", err)
	}
	return f, nil
}

// splitLines splits at "\n" or "\r" (ffmpeg's own status line ends in "\r"), and cuts a line
// longer than maxLineBytes, skipping the rest of it.
func splitLines() bufio.SplitFunc {
	skipping := false
	return func(data []byte, atEOF bool) (int, []byte, error) {
		if end := bytes.IndexAny(data, "\r\n"); end >= 0 {
			if skipping {
				skipping = false
				return end + 1, nil, nil
			}
			return end + 1, data[:end], nil
		}
		if len(data) >= maxLineBytes {
			if skipping {
				return len(data), nil, nil
			}
			skipping = true
			return len(data), data[:maxLineBytes], nil
		}
		if atEOF && len(data) > 0 {
			if skipping {
				return len(data), nil, nil
			}
			return len(data), data, nil
		}
		return 0, nil, nil
	}
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
