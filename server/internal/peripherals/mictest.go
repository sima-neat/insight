package peripherals

import (
	"bytes"
	"context"
	"encoding/binary"
	"math"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"insight/api"
	"insight/internal/apierr"
	"insight/internal/board"
)

// A test records for at most MaxSeconds, at most preferredRate (48 kHz) and maxChannels (2) in
// 16 bits: about 5.5 MiB.
const (
	MaxSeconds    = 30
	preferredRate = 48000
	maxChannels   = 2
	// A recording is silent when its typical (median) slice of levelBars is below silentDBFS:
	// not its peak or RMS, which one click as a USB microphone opens moves. A quiet room
	// measured about -48 dBFS RMS on a Yeti Nano.
	levelBars  = 96
	silentDBFS = -60.0
	// stopWait bounds how long a stop waits for the recording's result.
	stopWait = 5 * time.Second
)

// AudioFormat is how a test records.
type AudioFormat struct {
	Rate     int `json:"rate"`
	Channels int `json:"channels"`
	Bits     int `json:"bits"`
	Seconds  int `json:"seconds"`
}

// Level is what a finished recording picked up: peak and RMS in dBFS (nil for digital silence).
type Level struct {
	PeakDBFS *float64 `json:"peak_dbfs"`
	RMSDBFS  *float64 `json:"rms_dbfs"`
	Silent   bool     `json:"silent"`
}

// MicTest is a microphone test as the API shows it.
type MicTest struct {
	// ID tells this test from the next one.
	ID         string      `json:"id"`
	Microphone string      `json:"microphone"`
	State      string      `json:"state"` // recording, ready, failed
	Device     string      `json:"device"`
	Format     AudioFormat `json:"format"`
	ElapsedMs  int64       `json:"elapsed_ms"`
	// LevelDBFS is the newest chunk's peak while recording.
	LevelDBFS *float64 `json:"level_dbfs,omitempty"`
	// Level is set once ready, Error once failed.
	Level *Level           `json:"level,omitempty"`
	Error *api.ErrorDetail `json:"error,omitempty"`
}

// MicTestAnswer is the board's test, nil before the first.
type MicTestAnswer struct {
	Test *MicTest `json:"test"`
}

// micTest is one recording: its live level while arecord runs, then the WAV or the error.
type micTest struct {
	stream *board.Stream
	done   chan struct{}

	mu      sync.Mutex
	info    MicTest
	pcm     []byte
	max     int
	stopped bool
	wav     []byte
}

// selector is the only ALSA device name arecord is given: Sentinel's plughw selector of a card
// with a stable id, which converts what the hardware captures to 16-bit PCM at the rate and
// channels asked for. A card of one or two digits is a number to alsa-lib, which a replug
// moves, so it is refused.
var (
	selector   = regexp.MustCompile(`^plughw:CARD=([A-Za-z0-9_-]{1,64}),DEV=(0|[1-9][0-9]{0,2})$`)
	cardNumber = regexp.MustCompile(`^[0-9]{1,2}$`)
)

func safeSelector(value string) bool {
	match := selector.FindStringSubmatch(value)
	return match != nil && !cardNumber.MatchString(match[1])
}

// MicTest is b's test, from memory.
func (m *Manager) MicTest(b *board.Board) (MicTestAnswer, error) {
	s, err := m.state(b)
	if err != nil {
		return MicTestAnswer{}, err
	}
	s.mu.Lock()
	test := s.test
	s.mu.Unlock()
	if test == nil {
		return MicTestAnswer{}, nil
	}
	return MicTestAnswer{Test: test.status()}, nil
}

// StartMicTest records from microphone on b, as the last scan names it, for seconds (1 to
// MaxSeconds; 0 is MaxSeconds) or until stopped, and answers at once; the test's level and then
// its result are read from MicTest. One test records on a board at a time.
func (m *Manager) StartMicTest(b *board.Board, microphone string, seconds int) (MicTestAnswer, error) {
	if seconds == 0 {
		seconds = MaxSeconds
	}
	if seconds < 1 || seconds > MaxSeconds {
		return MicTestAnswer{}, apierr.Errorf(http.StatusBadRequest, "invalid_request",
			"Leave seconds out to record until stopped, at most "+strconv.Itoa(MaxSeconds)+" seconds.",
			"seconds must be a whole number from 1 to %d.", MaxSeconds)
	}
	s, err := m.state(b)
	if err != nil {
		return MicTestAnswer{}, err
	}
	scanned, err := s.scanned()
	if err != nil {
		return MicTestAnswer{}, err
	}
	d, ok := scanned.device(microphone)
	if !ok || d.Type != "microphone" {
		return MicTestAnswer{}, apierr.Errorf(http.StatusNotFound, "not_found", "Refresh; the microphone may have been unplugged.",
			"The last scan lists no microphone %s.", microphone)
	}
	if scanned.stale(d) {
		return MicTestAnswer{}, apierr.Errorf(http.StatusConflict, "stale_scan",
			"Resolve the problem the scan reports, then refresh and test again.",
			"%s is listed from Sentinel's last successful scan: its provider failed in this one.", d.name())
	}
	if !safeSelector(d.CaptureTarget.Selector) {
		return MicTestAnswer{}, apierr.Errorf(http.StatusUnprocessableEntity, "no_device",
			"Refresh once the device has finished starting; if this persists, update Sentinel with `sima-cli neat install sentinel`.",
			"Sentinel names no ALSA device Insight records from for %s.", d.name())
	}
	rate, channels := chooseFormat(d.Modes)

	s.mu.Lock()
	if s.testStarting || (s.test != nil && s.test.recording()) {
		s.mu.Unlock()
		return MicTestAnswer{}, apierr.Errorf(http.StatusConflict, "test_running", "Wait for it to finish, or stop it.",
			"A microphone test is already recording.")
	}
	s.testStarting = true
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(seconds+10)*time.Second)
	// 50 ms periods: arecord hands over audio that often, which is what the live level shows.
	stream, err := b.Stream(ctx, []string{"arecord", "-q", "-D", d.CaptureTarget.Selector, "-f", "S16_LE",
		"-r", strconv.Itoa(rate), "-c", strconv.Itoa(channels), "-d", strconv.Itoa(seconds), "-F", "50000", "-t", "raw", "-"})
	s.mu.Lock()
	defer s.mu.Unlock()
	s.testStarting = false
	if err != nil {
		cancel()
		return MicTestAnswer{}, err
	}
	test := &micTest{stream: stream, done: make(chan struct{}), max: rate * channels * 2 * (seconds + 1),
		info: MicTest{ID: newID(), Microphone: microphone, State: "recording", Device: d.CaptureTarget.Selector,
			Format: AudioFormat{Rate: rate, Channels: channels, Bits: 16, Seconds: seconds}}}
	s.test = test
	go func() {
		defer cancel()
		test.record()
	}()
	return MicTestAnswer{Test: test.status()}, nil
}

// chooseFormat is the rate and channels to record at: 48 kHz when the hardware has it, else its
// nearest rate below (plughw resamples a device that only has higher ones); its most channels,
// at most two.
func chooseFormat(modes []mode) (int, int) {
	var rates []int
	channels := 1
	for _, m := range modes {
		channels = max(channels, m.Channels)
		rates = append(rates, m.RatesHz...)
		if r := m.RateRangeHz; r != nil && r.Min > 0 && r.Max >= r.Min {
			rates = append(rates, r.Min, min(r.Max, preferredRate))
		}
	}
	rate := 0
	for _, r := range rates {
		if r > 0 && r <= preferredRate {
			rate = max(rate, r)
		}
	}
	if rate == 0 {
		rate = preferredRate
	}
	return rate, min(channels, maxChannels)
}

// busy is what arecord prints for a device another process holds.
var busy = regexp.MustCompile(`(?i)Device or resource busy|audio open error: Device`)

// record reads the recording until arecord ends, then keeps its result.
func (t *micTest) record() {
	defer close(t.done)
	buffer := make([]byte, 32<<10)
	var carry []byte
	for {
		n, err := t.stream.Read(buffer)
		if n > 0 {
			chunk := append(carry, buffer[:n]...)
			whole := len(chunk) - len(chunk)%2
			t.mu.Lock()
			if room := t.max - len(t.pcm); room > 0 {
				t.pcm = append(t.pcm, buffer[:min(n, room)]...)
			}
			t.info.ElapsedMs = int64(len(t.pcm)) * 1000 / int64(t.info.Format.Rate*t.info.Format.Channels*2)
			t.info.LevelDBFS = dbfs(float64(peak(chunk[:whole])))
			t.mu.Unlock()
			carry = append(carry[:0], chunk[whole:]...)
		}
		if err != nil {
			break
		}
	}
	_ = t.stream.Close()
	t.finish(string(t.stream.Stderr()))
}

func (t *micTest) finish(stderr string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	format := t.info.Format
	pcm := t.pcm[:len(t.pcm)-len(t.pcm)%(2*format.Channels)]
	t.pcm, t.info.LevelDBFS = nil, nil
	fail := func(code, hint, message string) {
		t.info.State = "failed"
		body := apierr.New(code, message, hint)
		t.info.Error = &body.Error
	}
	switch {
	case strings.Contains(stderr, "arecord: not found") || strings.Contains(stderr, "arecord: command not found"):
		fail("tool_missing", "Install alsa-utils on the board, then test again.", "arecord is not installed on the board.")
	case busy.MatchString(stderr):
		fail("microphone_in_use", "Stop the application that records from it, then test again. Insight never stops it for you.",
			"Another process has the microphone open.")
	case t.stopped && len(pcm) < format.Rate*format.Channels*2/10:
		fail("stopped_early", "Test again, and speak.", "The test was stopped before anything was recorded.")
	case len(pcm) == 0:
		fail("command_failed", "Check the microphone on the board."+lastLine(stderr),
			"Recording from the microphone failed on the board.")
	default:
		level := measure(pcm, format.Channels)
		t.info.State, t.info.Level, t.wav = "ready", &level, wav(pcm, format.Rate, format.Channels)
	}
}

func (t *micTest) recording() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.info.State == "recording"
}

func (t *micTest) status() *MicTest {
	t.mu.Lock()
	defer t.mu.Unlock()
	info := t.info
	return &info
}

// stop ends the recording; what arrived so far is its result.
func (t *micTest) stop() {
	t.mu.Lock()
	t.stopped = true
	t.mu.Unlock()
	_ = t.stream.Close()
}

// StopMicTest ends microphone's test on b now and answers with its result. id, when not "",
// must name the test: a stop meant for an earlier test stops nothing.
func (m *Manager) StopMicTest(b *board.Board, microphone, id string) (MicTestAnswer, error) {
	s, err := m.state(b)
	if err != nil {
		return MicTestAnswer{}, err
	}
	s.mu.Lock()
	test := s.test
	s.mu.Unlock()
	if test == nil || test.info.Microphone != microphone || (id != "" && test.info.ID != id) {
		return MicTestAnswer{}, apierr.Errorf(http.StatusNotFound, "not_found", "Test again.", "No test of this microphone is running.")
	}
	test.stop()
	select {
	case <-test.done:
	case <-time.After(stopWait):
	}
	return MicTestAnswer{Test: test.status()}, nil
}

// ServeMicTestWAV answers with microphone's finished recording on b, as WAV, with ranges (an
// audio element asks for them). id, when not "", must name the test.
func (m *Manager) ServeMicTestWAV(w http.ResponseWriter, r *http.Request, b *board.Board, microphone, id string) {
	s, err := m.state(b)
	if err != nil {
		apierr.WriteError(w, err)
		return
	}
	s.mu.Lock()
	test := s.test
	s.mu.Unlock()
	var audio []byte
	if test != nil && test.info.Microphone == microphone && (id == "" || test.info.ID == id) {
		test.mu.Lock()
		audio = test.wav
		test.mu.Unlock()
	}
	if audio == nil {
		apierr.Write(w, http.StatusNotFound, "not_found", "There is no finished recording of this microphone.", "Test again.")
		return
	}
	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, "test.wav", time.Time{}, bytes.NewReader(audio))
}

// peak is the largest magnitude of the 16-bit little-endian samples in pcm.
func peak(pcm []byte) int {
	most := 0
	for i := 0; i+1 < len(pcm); i += 2 {
		v := int(int16(binary.LittleEndian.Uint16(pcm[i:])))
		most = max(most, v, -v)
	}
	return most
}

// dbfs is a magnitude in dBFS to a tenth; nil for 0, digital silence.
func dbfs(magnitude float64) *float64 {
	if magnitude <= 0 {
		return nil
	}
	value := math.Round(200*math.Log10(magnitude/32768)) / 10
	return &value
}

// measure is pcm's peak, its RMS, and whether it is silent.
func measure(pcm []byte, channels int) Level {
	samples := len(pcm) / 2
	if samples == 0 {
		return Level{Silent: true}
	}
	var squares float64
	for i := 0; i+1 < len(pcm); i += 2 {
		v := float64(int16(binary.LittleEndian.Uint16(pcm[i:])))
		squares += v * v
	}
	frames := samples / channels
	bucket := max(1, (frames+levelBars-1)/levelBars)
	frameBytes := 2 * channels
	var bars []int
	for start := 0; start < frames; start += bucket {
		bars = append(bars, peak(pcm[start*frameBytes:min(frames, start+bucket)*frameBytes]))
	}
	slices.Sort(bars)
	typical := dbfs(float64(bars[len(bars)/2]))
	return Level{
		PeakDBFS: dbfs(float64(peak(pcm))),
		RMSDBFS:  dbfs(math.Sqrt(squares / float64(samples))),
		Silent:   typical == nil || *typical < silentDBFS,
	}
}

// wav is pcm (16-bit little-endian) in a WAV file.
func wav(pcm []byte, rate, channels int) []byte {
	var out bytes.Buffer
	header := []any{
		[]byte("RIFF"), uint32(36 + len(pcm)), []byte("WAVE"),
		[]byte("fmt "), uint32(16), uint16(1), uint16(channels), uint32(rate),
		uint32(rate * channels * 2), uint16(channels * 2), uint16(16),
		[]byte("data"), uint32(len(pcm)),
	}
	for _, field := range header {
		_ = binary.Write(&out, binary.LittleEndian, field)
	}
	out.Write(pcm)
	return out.Bytes()
}
