package jobs

import (
	"bufio"
	"context"
	"io"
	"math"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

// The samples in testdata are real output of ffmpeg 6.1 run with "-progress pipe:1 -nostats" and
// its stderr merged into its stdout, as Insight runs it: a re-encode paced by -re (several
// blocks), a run at the default log level (the banner, x264's report and ffmpeg's final status
// line among the blocks), and a run that failed to open its encoder.

// follow runs FollowFFmpeg over input inside a job, as long work does.
func follow(t *testing.T, input io.Reader, duration time.Duration) (*FFmpegProgress, Snapshot) {
	t.Helper()
	r := New(nil)
	j := r.Submit("encode", "encode", func(ctx context.Context, p *Progress) (any, error) {
		return FollowFFmpeg(input, duration, p)
	})
	s := waitDone(t, j)
	if s.State != Done {
		t.Fatalf("job %s: %s", s.State, s.Error)
	}
	return s.Result.(*FFmpegProgress), s
}

func sample(t *testing.T, name string) *os.File {
	t.Helper()
	f, err := os.Open("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.Close() })
	return f
}

func TestFFmpegProgressFollowsEachBlock(t *testing.T) {
	f := &FFmpegProgress{Duration: 4 * time.Second}
	var seen []time.Duration
	var percents []float64
	lines := bufio.NewScanner(sample(t, "ffmpeg-encode.txt"))
	for lines.Scan() {
		if f.Line(lines.Text()) && !f.Ended() {
			elapsed, _ := f.Elapsed()
			percent, _ := f.Percent()
			seen, percents = append(seen, elapsed), append(percents, percent)
		}
	}
	want := []time.Duration{400 * time.Millisecond, 933333 * time.Microsecond, 4066667 * time.Microsecond}
	if !slices.Equal(seen, want) {
		t.Errorf("output times %v, want %v (one change per block, the three time keys agreeing)", seen, want)
	}
	if want := []float64{10, 23.333325, 100}; !closeTo(percents, want) {
		t.Errorf("percents %v, want %v (held to 100 past the duration)", percents, want)
	}
	if !f.Ended() || len(f.Diagnostics()) != 0 {
		t.Errorf("ended %v, diagnostics %q", f.Ended(), f.Diagnostics())
	}
}

func closeTo(got, want []float64) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if math.Abs(got[i]-want[i]) > 1e-6 {
			return false
		}
	}
	return true
}

func TestFollowFFmpegReportsOnTheJob(t *testing.T) {
	f, s := follow(t, sample(t, "ffmpeg-encode.txt"), 4*time.Second)
	if elapsed, _ := f.Elapsed(); elapsed != 4066667*time.Microsecond || !f.Ended() {
		t.Errorf("elapsed %v, ended %v", elapsed, f.Ended())
	}
	if p := s.Progress; p.Percent == nil || *p.Percent != 100 || p.Detail != "00:04 / 00:04" {
		t.Errorf("job progress %+v, percent %v", p, deref(p.Percent))
	}
}

func TestFollowFFmpegAtTheDefaultLogLevel(t *testing.T) {
	f, s := follow(t, sample(t, "ffmpeg-verbose.txt"), 3*time.Second)
	if elapsed, _ := f.Elapsed(); elapsed != 2933333*time.Microsecond {
		t.Errorf("elapsed %v", elapsed)
	}
	if percent, _ := f.Percent(); math.Abs(percent-97.7777667) > 1e-6 {
		t.Errorf("percent %v", percent)
	}
	if s.Progress.Detail != "00:02 / 00:03" {
		t.Errorf("detail %q", s.Progress.Detail)
	}
	diagnostics := f.Diagnostics()
	if len(diagnostics) != diagnosticLines ||
		!strings.Contains(diagnostics[0], "mb B  I16..4") ||
		diagnostics[len(diagnostics)-1] != "[libx264 @ 0x5d17afb42280] kb/s:37.06" {
		t.Errorf("diagnostics %q", diagnostics)
	}
}

func TestFollowFFmpegOfAFailedRun(t *testing.T) {
	f, s := follow(t, sample(t, "ffmpeg-fail.txt"), 4*time.Second)
	if _, ok := f.Elapsed(); ok {
		t.Error("an output time from N/A")
	}
	if _, ok := f.Percent(); ok || f.Detail() != "" || s.Progress.Percent != nil {
		t.Error("progress from a run that wrote nothing")
	}
	if !f.Ended() {
		t.Error("ffmpeg writes progress=end after a failure too")
	}
	want := []string{
		"x264 [error]: baseline profile doesn't support 4:4:4",
		"[libx264 @ 0x5d17afb42280] Error setting profile baseline.",
		"[vost#0:0/libx264 @ 0x5d17afb42280] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.",
		"Error while filtering: Invalid argument",
		"[out#0/mp4 @ 0x5d17afb42280] Nothing was written into output file, because at least one of its streams received no packets.",
	}
	if got := f.Diagnostics(); !slices.Equal(got, want) {
		t.Errorf("diagnostics %q", got)
	}
}

func TestFollowFFmpegCutsLongLinesAndSplitsAtCarriageReturns(t *testing.T) {
	input := "out_time_us=1000000\r" + strings.Repeat("x", 3*maxLineBytes) + "\r\n" +
		"frame=   47 fps=0.0 q=-1.0 time=00:00:02.93 speed= 112x    \r" +
		"out_time_us=2000000\nprogress=end"
	f, s := follow(t, strings.NewReader(input), 0)
	if elapsed, _ := f.Elapsed(); elapsed != 2*time.Second || !f.Ended() {
		t.Errorf("elapsed %v, ended %v: reading stopped early", elapsed, f.Ended())
	}
	if diagnostics := f.Diagnostics(); len(diagnostics) != 1 || diagnostics[0] != strings.Repeat("x", maxLineBytes) {
		t.Errorf("diagnostics: %d, first %d bytes", len(diagnostics), len(diagnostics[0]))
	}
	if s.Progress.Percent != nil || s.Progress.Detail != "00:02" {
		t.Errorf("without a duration: percent %v, detail %q", deref(s.Progress.Percent), s.Progress.Detail)
	}
}

func TestOutTime(t *testing.T) {
	for _, c := range []struct {
		line string
		want time.Duration
		ok   bool
	}{
		{"out_time_us=2933333", 2933333 * time.Microsecond, true},
		{"out_time_ms=2933333", 2933333 * time.Microsecond, true}, // microseconds, despite the name
		{"out_time=00:00:02.933333", 2933333 * time.Microsecond, true},
		{"out_time=01:02:03.500000", time.Hour + 2*time.Minute + 3500*time.Millisecond, true},
		{"out_time=-00:00:00.033333", 0, true},
		{"out_time_us=-33333", 0, true},
		{"out_time_us=N/A", 0, false},
		{"out_time=N/A", 0, false},
		{"out_time=2.5", 0, false},
		{"total_size=16642", 0, false},
	} {
		key, value, _ := strings.Cut(c.line, "=")
		got, ok := outTime(key, value)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: %v, %v; want %v, %v", c.line, got, ok, c.want, c.ok)
		}
	}
}

func TestProgressField(t *testing.T) {
	for line, want := range map[string]bool{
		"out_time_us=2933333":                       true,
		"stream_0_0_q=27.0":                         true,
		"bitrate=   1.0kbits/s":                     true,
		"[libx264 @ 0x5d17afb42280] using SAR=1/1":  false,
		"Error opening input: x=y":                  false,
		"  cpb: bitrate max/min/avg: 0/0/0 buffer=": false,
		"0frame=1":       false,
		"=1":             false,
		"no equals sign": false,
	} {
		if _, _, ok := progressField(strings.TrimSpace(line)); ok != want {
			t.Errorf("%q: progress %v", line, ok)
		}
	}
}

func TestClock(t *testing.T) {
	for d, want := range map[time.Duration]string{
		0:                                     "00:00",
		25*time.Second + 900*time.Millisecond: "00:25",
		61 * time.Minute:                      "1:01:00",
		3723 * time.Second:                    "1:02:03",
		-time.Second:                          "00:00",
	} {
		if got := clock(d); got != want {
			t.Errorf("clock(%v) = %q, want %q", d, got, want)
		}
	}
}
