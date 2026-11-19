package jobs

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"insight/internal/supervisor"
)

// The samples in testdata are real output of ffmpeg 6.1 run with "-progress pipe:1 -nostats" and
// its stderr merged into its stdout, as the supervisor runs it: a re-encode paced by -re (several
// blocks), a run at the default log level (the banner, x264's report and ffmpeg's final status
// line among the blocks), and a run that failed to open its encoder.

// replay stands in for the supervisor: the child "prints" output, each line as the supervisor
// writes it to the spec's Output, then exits with exit.
func replay(output io.Reader, exit string) supervisor.Starter {
	return func(spec supervisor.Spec) (supervisor.Child, error) {
		lines := bufio.NewScanner(output)
		for lines.Scan() {
			fmt.Fprintf(spec.Output, "[%s] %s\n", spec.Name, lines.Text())
		}
		child := &exited{status: supervisor.Status{LastExit: exit}, done: make(chan struct{})}
		close(child.done)
		return child, nil
	}
}

type exited struct {
	status supervisor.Status
	done   chan struct{}
}

func (e *exited) Status() supervisor.Status      { return e.status }
func (e *exited) Tail() []string                 { return nil }
func (e *exited) Done() <-chan struct{}          { return e.done }
func (e *exited) Stop(ctx context.Context) error { return nil }

// follow runs RunFFmpeg over output inside a job, as long work does, and returns what it
// followed, the job at its end and RunFFmpeg's error.
func follow(t *testing.T, output io.Reader, exit string, duration time.Duration) (*FFmpegProgress, Snapshot, error) {
	t.Helper()
	r := New(nil)
	var followed *FFmpegProgress
	var runErr error
	j := r.Submit("encode", "encode", func(ctx context.Context, p *Progress) (any, error) {
		runErr = RunFFmpeg(ctx, replay(output, exit), supervisor.Spec{Name: "encode-1"}, duration, func(f *FFmpegProgress) {
			followed = f
			p.Follow(f)
		})
		return nil, nil
	})
	s := waitDone(t, j)
	if followed == nil {
		followed = &FFmpegProgress{}
	}
	return followed, s, runErr
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

func TestRunFFmpegReportsOnTheJob(t *testing.T) {
	f, s, err := follow(t, sample(t, "ffmpeg-encode.txt"), "exit status 0", 4*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if elapsed, _ := f.Elapsed(); elapsed != 4066667*time.Microsecond || !f.Ended() {
		t.Errorf("elapsed %v, ended %v", elapsed, f.Ended())
	}
	if p := s.Progress; p.Percent == nil || *p.Percent != 100 || p.Detail != "00:04 / 00:04" {
		t.Errorf("job progress %+v, percent %v", p, deref(p.Percent))
	}
}

func TestRunFFmpegAtTheDefaultLogLevel(t *testing.T) {
	f, s, _ := follow(t, sample(t, "ffmpeg-verbose.txt"), "exit status 0", 3*time.Second)
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

func TestRunFFmpegOfAFailedRun(t *testing.T) {
	r := New(nil)
	var err error
	j := r.Submit("encode", "encode", func(ctx context.Context, p *Progress) (any, error) {
		err = RunFFmpeg(ctx, replay(sample(t, "ffmpeg-fail.txt"), "exit status 1"), supervisor.Spec{Name: "encode-1"}, 4*time.Second, p.Follow)
		return nil, nil
	})
	if s := waitDone(t, j); s.Progress.Percent != nil || s.Progress.Detail != "" {
		t.Errorf("progress from a run that wrote nothing: %+v", s.Progress)
	}
	want := "[vost#0:0/libx264 @ 0x5d17afb42280] Error while opening encoder - maybe incorrect parameters such as bit_rate, rate, width or height.; " +
		"Error while filtering: Invalid argument; " +
		"[out#0/mp4 @ 0x5d17afb42280] Nothing was written into output file, because at least one of its streams received no packets."
	if err == nil || !strings.HasPrefix(err.Error(), "[libx264 @ 0x5d17afb42280] Error setting profile baseline.; ") || !strings.HasSuffix(err.Error(), want) {
		t.Errorf("the failure: %v", err)
	}
	if err := RunFFmpeg(context.Background(), replay(strings.NewReader(""), "signal: killed"), supervisor.Spec{Name: "encode-2"}, 0, func(*FFmpegProgress) {}); err == nil || err.Error() != "ffmpeg ended with signal: killed" {
		t.Errorf("a run that said nothing: %v", err)
	}
}

func TestFFmpegProgressOfAFailedRun(t *testing.T) {
	f := &FFmpegProgress{Duration: 4 * time.Second}
	lines := bufio.NewScanner(sample(t, "ffmpeg-fail.txt"))
	for lines.Scan() {
		f.Line(lines.Text())
	}
	if _, ok := f.Elapsed(); ok {
		t.Error("an output time from N/A")
	}
	if _, ok := f.Percent(); ok || f.Detail() != "" {
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

func TestRunFFmpegStopsItWhenCancelled(t *testing.T) {
	child := &hanging{done: make(chan struct{})}
	start := func(supervisor.Spec) (supervisor.Child, error) { return child, nil }
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := RunFFmpeg(ctx, start, supervisor.Spec{Name: "encode-1"}, 0, func(*FFmpegProgress) {}); !errors.Is(err, context.Canceled) {
		t.Errorf("returned %v", err)
	}
	select {
	case <-child.done:
	default:
		t.Error("ffmpeg was not stopped")
	}
}

// hanging is a child that runs until it is stopped.
type hanging struct{ done chan struct{} }

func (h *hanging) Status() supervisor.Status {
	return supervisor.Status{LastExit: "signal: terminated"}
}
func (h *hanging) Tail() []string        { return nil }
func (h *hanging) Done() <-chan struct{} { return h.done }
func (h *hanging) Stop(context.Context) error {
	close(h.done)
	return nil
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
