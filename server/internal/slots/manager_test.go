package slots

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"insight/internal/jobs"
	"insight/internal/media"
	"insight/internal/mediamtx"
)

func TestAFileSlotStreamsWhileStarted(t *testing.T) {
	h := newHarness(t)
	abs := h.file("clips/a.mp4", h264Info)
	must(t, h.m.AssignFile(3, "clips/a.mp4", 0))
	h.settle()
	if s := h.slot(3); s.State != Idle || s.Codec != "h264" || *s.NativeFPS != 25 || s.Run {
		t.Fatalf("an assigned slot: %+v", s)
	}
	h.noPublisher(3)

	must(t, h.m.Start(3))
	h.settle()
	p := h.publisher(3)
	args := strings.Join(p.spec.Args, " ")
	for _, want := range []string{"-re -stream_loop -1 -i file:" + abs, "-c:v copy", "-f rtsp -rtsp_transport tcp rtsp://127.0.0.1:8554/src3?" + testPublisherQuery} {
		if !strings.Contains(args, want) {
			t.Errorf("the publisher's arguments %q lack %q", args, want)
		}
	}
	if !p.spec.Restart {
		t.Error("the publisher is not restarted when it exits")
	}
	if s := h.slot(3); s.State != Starting || s.ActiveFile != "clips/a.mp4" {
		t.Fatalf("a started slot: %+v", s)
	}

	h.mtx.setPath(publishing(3, "h264", true))
	h.settle()
	s := h.slot(3)
	if s.State != Live || s.Publisher == nil || s.Publisher.Width != 1280 || s.Publisher.FPS != 25 || !s.Publisher.CodecSupported {
		t.Fatalf("a live slot: %+v %+v", s, s.Publisher)
	}
	if s.URLs.RTSP != "rtsp://insight.local:18554/src3" || s.URLs.HTTPMJPEG != "" || s.URLs.WHIP != "" {
		t.Errorf("the URLs: %+v", s.URLs)
	}

	must(t, h.m.Stop(3))
	if s := h.slot(3); s.State != Idle {
		t.Errorf("a stopped slot is %s", s.State)
	}
	h.settle()
	h.noPublisher(3)
	h.settle()
	if h.starter.count() != 1 {
		t.Errorf("%d publishers were started, not 1: reconcile is not idempotent", h.starter.count())
	}
}

func TestAnMJPEGFileIsEncodedForRTPAndHasAnHTTPOutput(t *testing.T) {
	h := newHarness(t)
	h.file("cam.mjpeg", mjpegInfo)
	must(t, h.m.AssignFile(1, "cam.mjpeg", 0))
	must(t, h.m.Start(1))
	h.settle()
	args := strings.Join(h.publisher(1).spec.Args, " ")
	if !strings.Contains(args, "-c:v mjpeg -q:v 5 -huffman default -force_duplicated_matrix 1") {
		t.Errorf("an MJPEG publisher's arguments: %s", args)
	}
	if s := h.slot(1); s.URLs.HTTPMJPEG != "https://insight.local:9900/stream/http/src1.mjpg" {
		t.Errorf("the HTTP MJPEG URL: %q", s.URLs.HTTPMJPEG)
	}
	wantCode(t, h.m.AssignFile(1, "cam.mjpeg", 30), CodeFPSNotSupported)
}

func TestAssigningAFileRestartsARunningSlotWithIt(t *testing.T) {
	h := newHarness(t)
	h.file("a.mp4", h264Info)
	b := h.file("b.mp4", h265Info)
	must(t, h.m.AssignFile(2, "a.mp4", 0))
	must(t, h.m.Start(2))
	h.settle()
	first := h.publisher(2)

	must(t, h.m.AssignFile(2, "b.mp4", 0))
	h.settle()
	if first.Status().Running {
		t.Error("the publisher of the old file still runs")
	}
	if args := strings.Join(h.publisher(2).spec.Args, " "); !strings.Contains(args, "file:"+b) {
		t.Errorf("the new publisher streams %s", args)
	}
	if s := h.slot(2); !s.Run || s.File != "b.mp4" {
		t.Errorf("the slot: %+v", s)
	}

	// A webcam slot that becomes a file slot does not start streaming by itself.
	_, err := h.m.AssignWebcam(4, "")
	must(t, err)
	must(t, h.m.AssignFile(4, "a.mp4", 0))
	if s := h.slot(4); s.Run {
		t.Error("a webcam slot given a file runs at once")
	}
}

func TestAssigningAFileChecksIt(t *testing.T) {
	h := newHarness(t)
	h.file("vp9.webm", vp9Info)
	h.file("big.mp4", media.Info{Codec: media.CodecH264, Width: 3840, Height: 2160, FPS: 30})
	wantCode(t, h.m.AssignFile(0, "a.mp4", 0), CodeNoSuchSlot)
	wantCode(t, h.m.AssignFile(49, "a.mp4", 0), CodeNoSuchSlot)
	wantCode(t, h.m.AssignFile(1, "../etc/passwd", 0), CodeInvalidPath)
	wantCode(t, h.m.AssignFile(1, ".renditions/x.mp4", 0), CodeInvalidPath)
	wantCode(t, h.m.AssignFile(1, "missing.mp4", 0), CodeFileNotFound)
	wantCode(t, h.m.AssignFile(1, "vp9.webm", 0), CodeNotStreamable)
	wantCode(t, h.m.AssignFile(1, "big.mp4", -1), CodeInvalidFPS)

	// A file not probed yet is taken, and probed.
	abs := filepath.Join(h.root, "new.mp4")
	must(t, os.WriteFile(abs, []byte("x"), 0o644))
	must(t, h.m.AssignFile(1, "new.mp4", 15))
	if !h.probes.wasWanted(abs) {
		t.Error("an unprobed file was not queued for a probe")
	}
	must(t, h.m.Start(1))
	h.settle()
	h.noPublisher(1)
	if s := h.slot(1); s.State != Starting {
		t.Errorf("a slot whose file is being probed is %s", s.State)
	}
	// It turns out it cannot be streamed.
	h.probes.set(abs, vp9Info)
	h.settle()
	if s := h.slot(1); s.State != Failed || !strings.Contains(s.Error, "codec is vp9") {
		t.Errorf("a slot whose file cannot be streamed: %+v", s)
	}
}

func TestAPublisherThatExitsShowsWhyAndAStartFailureHolds(t *testing.T) {
	h := newHarness(t)
	h.file("a.mp4", h264Info)
	must(t, h.m.AssignFile(1, "a.mp4", 0))
	must(t, h.m.Start(1))
	h.settle()
	h.publisher(1).crash("Connection refused")
	if s := h.slot(1); s.State != Failed || !strings.Contains(s.Error, "Connection refused") {
		t.Errorf("a slot whose publisher exited: %+v", s)
	}

	h.starter.fail(errors.New("exec: no such file"))
	wantCode(t, h.m.Start(2), CodeNothingAssigned)
	must(t, h.m.AssignFile(2, "a.mp4", 0))
	must(t, h.m.Start(2))
	h.settle()
	if s := h.slot(2); s.State != Failed || !strings.Contains(s.Error, "no such file") {
		t.Fatalf("a slot whose publisher could not start: %+v", s)
	}
	before := h.starter.count()
	h.starter.fail(nil)
	h.settle()
	if h.starter.count() != before {
		t.Error("a failed start was retried before the slot was started again")
	}
	must(t, h.m.Start(2))
	h.settle()
	h.publisher(2)
}

func TestARenditionIsEncodedAsAJobBeforeTheSlotStreamsIt(t *testing.T) {
	h := newHarness(t)
	h.encoder.release = make(chan error)
	abs := h.file("a.mp4", h264Info)
	must(t, h.m.AssignFile(1, "a.mp4", 25)) // its own rate: no rendition
	must(t, h.m.Start(1))
	h.settle()
	if s := h.slot(1); s.ActiveFile != "a.mp4" {
		t.Fatalf("a slot at its file's own rate streams %q", s.ActiveFile)
	}

	must(t, h.m.AssignFile(1, "a.mp4", 15))
	h.settle()
	h.noPublisher(1)
	s := h.slot(1)
	if s.State != Preparing || s.Job == "" || *s.FPS != 15 {
		t.Fatalf("a slot waiting for its rendition: %+v", s)
	}
	job, ok := jobSnapshot(h.jobs, s.Job)
	if !ok || job.Kind != RenditionJob || job.Title != "Encode a.mp4 at 15 fps" {
		t.Fatalf("the job: %+v", job)
	}
	// A second slot with the same file and rate waits for the same encode.
	must(t, h.m.AssignFile(2, "a.mp4", 15))
	must(t, h.m.Start(2))
	h.settle()
	if s2 := h.slot(2); s2.Job != s.Job {
		t.Errorf("two slots need one rendition and have jobs %s and %s", s.Job, s2.Job)
	}
	if h.encoder.count() != 1 {
		t.Fatalf("%d encodes for one rendition", h.encoder.count())
	}

	h.encoder.release <- nil
	eventually(t, "the slot streams its rendition", func() bool {
		h.settle()
		return len(h.starter.running(pathName(1))) == 1
	})
	s = h.slot(1)
	if !strings.HasPrefix(s.ActiveFile, ".renditions/a_") || !strings.HasSuffix(s.ActiveFile, "_15fps_h264.mp4") {
		t.Errorf("the slot streams %q", s.ActiveFile)
	}
	if args := strings.Join(h.publisher(1).spec.Args, " "); !strings.Contains(args, "file:"+filepath.Join(h.root, s.ActiveFile)) || strings.Contains(args, abs+" ") {
		t.Errorf("the publisher streams %s", args)
	}
	run := h.encoder.run(0)
	encode := strings.Join(run.args, " ")
	for _, want := range []string{"-i file:" + abs, "fps=15", "-profile:v baseline", "-b:v 2000000", "-f mp4 file:" + run.output} {
		if !strings.Contains(encode, want) {
			t.Errorf("the encode's arguments %q lack %q", encode, want)
		}
	}
	h.publisher(2)
}

func TestAFailedRenditionFailsTheSlotUntilItIsStartedAgain(t *testing.T) {
	h := newHarness(t)
	h.encoder.release = make(chan error, 1)
	h.file("a.mp4", h264Info)
	must(t, h.m.AssignFile(1, "a.mp4", 10))
	must(t, h.m.Start(1))
	h.settle()
	h.encoder.release <- errors.New("x264 [error]: broken")
	eventually(t, "the slot fails", func() bool { h.settle(); return h.slot(1).State == Failed })
	if s := h.slot(1); !strings.Contains(s.Error, "Encoding a.mp4 at 10 fps failed: x264 [error]: broken") {
		t.Errorf("the slot's error: %q", s.Error)
	}
	if h.encoder.count() != 1 {
		t.Error("a failed encode was tried again by itself")
	}
	h.encoder.release <- nil
	must(t, h.m.Start(1))
	eventually(t, "the slot streams", func() bool { h.settle(); return len(h.starter.running(pathName(1))) == 1 })
}

func TestStoppingStopsTheEncode(t *testing.T) {
	h := newHarness(t)
	h.encoder.release = make(chan error)
	h.file("a.mp4", h264Info)
	must(t, h.m.AssignFile(1, "a.mp4", 10))
	must(t, h.m.Start(1))
	h.settle()
	id := h.slot(1).Job
	must(t, h.m.Stop(1))
	h.settle()
	eventually(t, "the encode is cancelled", func() bool {
		job, _ := jobSnapshot(h.jobs, id)
		return job.State == jobs.Cancelled
	})
}

func TestAnExternalPublisherHoldsTheSlot(t *testing.T) {
	h := newHarness(t)
	h.file("a.mp4", h264Info)
	must(t, h.m.AssignFile(5, "a.mp4", 0))
	h.mtx.setPath(publishing(5, "vp8", false))
	h.settle()
	s := h.slot(5)
	if s.State != External || s.Publisher == nil || s.Publisher.Address != "10.0.0.9" || s.Publisher.CodecSupported || s.Codec != "vp8" {
		t.Fatalf("an external slot: %+v %+v", s, s.Publisher)
	}
	if s.Publisher.Width != 640 {
		t.Errorf("the external stream was not probed: %+v", s.Publisher)
	}
	wantCode(t, h.m.AssignFile(5, "a.mp4", 0), CodeSlotBusy)
	wantCode(t, h.m.Start(5), CodeSlotBusy)
	result, err := h.m.StartFirst(10)
	must(t, err)
	if !slices.Equal(result.SkippedExternal, []int{5}) || len(result.Started) != 0 {
		t.Errorf("a bulk start: %+v", result)
	}
	wantCode(t, h.m.TakeOver(context.Background(), 4), CodeNotExternal)

	must(t, h.m.TakeOver(context.Background(), 5))
	if calls := h.mtx.takeCalls(); !contains(calls, "kick rtspSession session-src5") {
		t.Errorf("the calls: %v", calls)
	}
	h.settle()
	if s := h.slot(5); s.State != Idle {
		t.Errorf("a slot taken over is %s", s.State)
	}
}

func TestAPublisherOfTheSlotsOwnIsNeverExternal(t *testing.T) {
	h := newHarness(t)
	h.file("a.mp4", h264Info)
	must(t, h.m.AssignFile(1, "a.mp4", 0))
	must(t, h.m.Start(1))
	h.settle()
	// MediaMTX shows the session before its query: not tagged as Insight's.
	h.mtx.setPath(publishing(1, "h264", false))
	h.settle()
	if s := h.slot(1); s.State != Live {
		t.Errorf("the slot's own publisher is taken for %s", s.State)
	}
	h.publisher(1)
}

func TestAPullChecksTheSlotAgainAfterItsProbe(t *testing.T) {
	h := newHarness(t)
	h.settle() // the slot is free in the snapshot the Manager holds
	h.mtx.takeCalls()
	h.streams.onProbe = func() { h.mtx.setPath(publishing(1, "h264", false)) }

	err := h.m.AssignPull(context.Background(), 1, "rtsp://cam.local/live", "", "")
	wantCode(t, err, CodeSlotBusy)
	if calls := h.mtx.takeCalls(); len(calls) != 0 {
		t.Errorf("a pull was configured over the publisher that connected during the probe: %v", calls)
	}
	if d := h.m.store.get(1); d.Kind != KindNone {
		t.Errorf("the slot was assigned: %+v", d)
	}
}

func TestAPullIsRefusedWhenMediaMTXDoesNotAnswerAfterItsProbe(t *testing.T) {
	h := newHarness(t)
	h.settle()
	h.mtx.takeCalls()
	h.streams.onProbe = func() { h.mtx.setDown(true) }

	err := h.m.AssignPull(context.Background(), 1, "rtsp://cam.local/live", "", "")
	wantCode(t, err, CodeMediaMTXDown)
	if !strings.Contains(err.Error(), "src1") {
		t.Errorf("the refusal does not name the slot: %v", err)
	}
	if d := h.m.store.get(1); d.Kind != KindNone {
		t.Errorf("the slot was assigned: %+v", d)
	}
}

func TestAPullIsProbedSetAndForgottenAcrossARestart(t *testing.T) {
	h := newHarness(t)
	h.streams.answer("rtsp://admin:wrong@", &ProbeError{Auth: true})
	h.streams.answer("rtsp://10.0.0.7:", &ProbeError{Detail: "Connection refused"})
	h.streams.answer("rtsp://open.cam", &ProbeError{Auth: true})
	ctx := context.Background()

	wantCode(t, h.m.AssignPull(ctx, 1, "http://cam/x", "", ""), CodeInvalidPullURL)
	err := h.m.AssignPull(ctx, 1, "rtsp://cam.local/live", "admin", "wrong")
	wantCode(t, err, CodePullAuthFailed)
	if !strings.Contains(err.Error(), "rejected the username or password") {
		t.Errorf("an auth failure: %v", err)
	}
	err = h.m.AssignPull(ctx, 1, "rtsp://open.cam/live", "", "")
	if !strings.Contains(err.Error(), "requires a username and password") {
		t.Errorf("a camera that needs credentials: %v", err)
	}
	err = h.m.AssignPull(ctx, 1, "rtsp://10.0.0.7:8554/live", "", "")
	wantCode(t, err, CodePullUnreachable)
	if !strings.Contains(err.Error(), "Connection refused") {
		t.Errorf("an unreachable camera: %v", err)
	}
	h.mtx.takeCalls()

	must(t, h.m.AssignPull(ctx, 1, "rtsp://cam.local/live?token=abc", "admin", "s3cret!"))
	h.settle()
	full := "rtsp://admin:s3cret%21@cam.local/live?token=abc"
	if calls := h.mtx.takeCalls(); !slices.Equal(calls, []string{"set src1 " + full}) {
		t.Fatalf("the calls: %v", calls)
	}
	s := h.slot(1)
	if s.State != Starting || s.Pull.Status != PullConnecting || s.Pull.Host != "cam.local:554" || s.Pull.Path != "/live?token=***" {
		t.Fatalf("a pull: %+v %+v", s, s.Pull)
	}
	h.mtx.setPath(mediamtx.Path{Name: "src1", Ready: true, Codec: "h265",
		Source: &mediamtx.Source{Type: "rtspSource", Protocol: "rtspSource"}})
	h.settle()
	if s := h.slot(1); s.State != Live || s.Pull.Status != PullLive || s.Codec != "h265" {
		t.Errorf("a live pull: %+v", s)
	}

	content, err := os.ReadFile(h.store)
	must(t, err)
	if strings.Contains(string(content), "s3cret") || strings.Contains(string(content), "admin") || strings.Contains(string(content), "abc") {
		t.Errorf("the store holds credentials:\n%s", content)
	}

	// A camera without secrets is kept whole.
	must(t, h.m.AssignPull(ctx, 2, "rtsp://10.0.0.8/stream", "", ""))
	h.reopen()
	h.settle()
	if s := h.slot(1); s.Run || s.State != Idle || s.Pull.Status != PullNeedsCredentials {
		t.Errorf("a pull with credentials after a restart: %+v %+v", s, s.Pull)
	}
	wantCode(t, h.m.Start(1), CodePullCredentials)
	if s := h.slot(2); s.Run || s.Pull.Status != PullStopped {
		t.Errorf("a pull without credentials after a restart: %+v %+v", s, s.Pull)
	}
	h.mtx.takeCalls()
	must(t, h.m.Start(2))
	h.settle()
	if calls := h.mtx.takeCalls(); !contains(calls, "set src2 rtsp://10.0.0.8/stream") {
		t.Errorf("the calls: %v", calls)
	}
}

func TestAPullIsSetAgainWhenMediaMTXLosesIt(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	must(t, h.m.AssignPull(ctx, 1, "rtsp://10.0.0.8/stream", "", ""))
	h.settle()
	h.mtx.takeCalls()
	h.settle()
	if calls := h.mtx.takeCalls(); len(calls) != 0 {
		t.Fatalf("a set pull is set again: %v", calls)
	}

	// MediaMTX restarts: its API is gone for a while, then answers without the pull.
	h.mtx.setDown(true)
	h.settle()
	h.mtx.setDown(false)
	h.mtx.setPath(mediamtx.Path{Name: "src1"})
	h.settle()
	if calls := h.mtx.takeCalls(); !contains(calls, "set src1 rtsp://10.0.0.8/stream") {
		t.Errorf("a pull lost in a restart is not set again: %v", calls)
	}
	// It forgets it without being unavailable in between.
	h.mtx.setPath(mediamtx.Path{Name: "src1"})
	h.settle()
	if calls := h.mtx.takeCalls(); !contains(calls, "set src1 rtsp://10.0.0.8/stream") {
		t.Errorf("a pull the snapshot lacks is not set again: %v", calls)
	}

	// The slot changes to a file: the pull goes first.
	h.file("a.mp4", h264Info)
	must(t, h.m.AssignFile(1, "a.mp4", 0))
	must(t, h.m.Start(1))
	h.settle()
	if calls := h.mtx.takeCalls(); !contains(calls, "clear src1") {
		t.Errorf("the calls: %v", calls)
	}
	h.publisher(1)

	// MediaMTX refuses a camera.
	h.mtx.failSets(&mediamtx.Error{Call: "patch", Status: 400, Message: "invalid source", Kind: mediamtx.ErrRejected})
	must(t, h.m.AssignPull(ctx, 2, "rtsp://10.0.0.8/other", "", ""))
	h.settle()
	if s := h.slot(2); s.State != Failed || !strings.Contains(s.Error, "invalid source") {
		t.Errorf("a refused pull: %+v", s)
	}
}

func TestAPullThatLaterRefusesItsCredentialsIsPaused(t *testing.T) {
	h := newHarness(t)
	must(t, h.m.AssignPull(context.Background(), 1, "rtsp://cam.local/live", "admin", "pw"))
	h.settle()
	h.mtx.takeCalls()
	h.streams.answer("rtsp://admin:pw@cam.local", &ProbeError{Auth: true})
	h.m.mu.Lock()
	h.m.rt[0].pullProbe.at = h.m.rt[0].pullProbe.at.Add(-pullProbeEvery) // due again
	h.m.mu.Unlock()
	h.settle()
	eventually(t, "the pull is paused", func() bool { h.settle(); return h.slot(1).State == Failed })
	s := h.slot(1)
	if s.Pull.Status != PullAuthFailed || !strings.Contains(s.Error, "rejected") {
		t.Errorf("a pull whose credentials were refused: %+v %+v", s, s.Pull)
	}
	if calls := h.mtx.takeCalls(); !contains(calls, "clear src1") {
		t.Errorf("the paused pull was not cleared: %v", calls)
	}
}

func TestAWebcamSlotKicksWhatItNoLongerWants(t *testing.T) {
	h := newHarness(t)
	url, err := h.m.AssignWebcam(7, "[fd00::1]:9900")
	must(t, err)
	if url != "https://[fd00::1]:18889/cam7/whip" {
		t.Errorf("the WHIP URL: %s", url)
	}
	cam := mediamtx.Path{Name: "cam7", Ready: true, Codec: "h264",
		Source: &mediamtx.Source{Type: "webRTCSession", ID: "browser-1", Protocol: "webrtc", Address: "10.0.0.20"}}
	h.mtx.setPath(cam)
	h.settle()
	if s := h.slot(7); s.State != Starting || s.URLs.WHIP == "" {
		t.Errorf("a webcam slot a browser publishes on: %+v", s)
	}
	h.mtx.setPath(publishing(7, "h264", true))
	h.settle()
	if s := h.slot(7); s.State != Live || s.Codec != "h264" {
		t.Errorf("a webcam slot whose stream is normalized: %+v", s)
	}
	if calls := h.mtx.takeCalls(); len(calls) != 0 {
		t.Errorf("a running webcam was kicked: %v", calls)
	}

	must(t, h.m.Stop(7))
	h.settle()
	if calls := h.mtx.takeCalls(); !slices.Equal(calls, []string{"kick webRTCSession browser-1"}) {
		t.Errorf("stopping a webcam: %v", calls)
	}
	// A tab that publishes on a slot that is now a file's is kicked too.
	h.file("a.mp4", h264Info)
	must(t, h.m.AssignFile(7, "a.mp4", 0))
	cam.Source.ID = "browser-2"
	h.mtx.setPath(cam)
	h.settle()
	if calls := h.mtx.takeCalls(); !contains(calls, "kick webRTCSession browser-2") {
		t.Errorf("a stale webcam publisher: %v", calls)
	}
}

func TestRestoredSlotsComeBackStopped(t *testing.T) {
	h := newHarness(t)
	h.file("a.mp4", h264Info)
	must(t, h.m.AssignFile(1, "a.mp4", 15))
	must(t, h.m.Start(1))
	_, err := h.m.AssignWebcam(2, "")
	must(t, err)
	h.settle()
	// The encode runs as a job, on a goroutine of its own.
	eventually(t, "the rendition's encode", func() bool { return h.encoder.count() == 1 })
	encodes, publishers := h.encoder.count(), h.starter.count()

	h.reopen()
	h.settle()
	if s := h.slot(1); s.Kind != KindFile || s.File != "a.mp4" || *s.FPS != 15 || s.Run || s.State != Idle {
		t.Errorf("a restored file slot: %+v", s)
	}
	if s := h.slot(2); s.Kind != KindWebcam || s.Run {
		t.Errorf("a restored webcam slot: %+v", s)
	}
	h.noPublisher(1)
	if h.encoder.count() != encodes || h.starter.count() != publishers {
		t.Error("a restored slot started something")
	}
}

func TestBulkOperations(t *testing.T) {
	h := newHarness(t)
	_, err := h.m.StartFirst(3)
	wantCode(t, err, CodeNothingAssigned)
	_, err = h.m.StartFirst(0)
	wantCode(t, err, CodeInvalidCount)

	for _, name := range []string{"a.mp4", "b.mp4", "c.mp4", "d.mp4"} {
		h.file(name, h264Info)
	}
	h.file("bad.webm", vp9Info)
	must(t, h.m.AssignFile(9, "b.mp4", 10)) // keeps its rate when it keeps its file
	must(t, h.m.AssignPull(context.Background(), 2, "rtsp://10.0.0.8/stream", "", ""))
	h.mtx.setPath(publishing(4, "h264", false))
	h.settle()
	must(t, h.m.AssignFile(48, "d.mp4", 0))

	result := h.m.AutoAssign([]string{"a.mp4", "bad.webm", "missing.mp4", "b.mp4", "c.mp4", "a.mp4", "d.mp4"})
	if result.Assigned != 4 || result.Available != 4 || !slices.Equal(result.SkippedExternal, []int{4}) || !slices.Equal(result.SkippedPulled, []int{2}) {
		t.Errorf("auto assign: %+v", result)
	}
	want := map[int]string{1: "a.mp4", 3: "b.mp4", 5: "c.mp4", 6: "d.mp4"}
	for n := 1; n <= Count; n++ {
		s := h.slot(n)
		switch {
		case n == 2:
			if s.Kind != KindPull || s.Run {
				t.Errorf("the pulled slot: %+v", s)
			}
		case n == 4:
			if s.Kind != KindNone {
				t.Errorf("the external slot: %+v", s)
			}
		case want[n] != "":
			if s.Kind != KindFile || s.File != want[n] || s.Run {
				t.Errorf("slot %d: %+v, want %s", n, s, want[n])
			}
		case s.Kind != KindNone:
			t.Errorf("slot %d beyond the files: %+v", n, s)
		}
	}
	if s := h.slot(3); s.FPS != nil {
		t.Errorf("slot 3 took over another slot's rate: %+v", s)
	}

	must(t, h.m.Start(1))
	started, err := h.m.StartFirst(3)
	must(t, err)
	if !slices.Equal(started.AlreadyRunning, []int{1}) || !slices.Equal(started.Started, []int{3, 5}) {
		t.Errorf("a bulk start: %+v", started)
	}
	must(t, os.Remove(filepath.Join(h.root, "d.mp4")))
	started, err = h.m.StartFirst(10)
	must(t, err)
	if len(started.Errors) != 1 || started.Errors[0].N != 6 || started.Errors[0].Code != CodeFileNotFound {
		t.Errorf("a bulk start with a file gone: %+v", started)
	}
	h.settle()
	if len(h.starter.running(pathName(5))) != 1 {
		t.Error("a bulk-started slot does not stream")
	}

	stopped := h.m.StopAll()
	if !slices.Equal(stopped.Stopped, []int{1, 3, 5}) || !slices.Equal(stopped.SkippedExternal, []int{4}) {
		t.Errorf("stop all: %+v", stopped)
	}
	h.settle()
	for _, n := range []int{1, 3, 5} {
		h.noPublisher(n)
	}
	if s := h.slot(1); s.Kind != KindFile {
		t.Error("stop all dropped an assignment")
	}

	reset := h.m.Reset()
	if !slices.Equal(reset.SkippedExternal, []int{4}) {
		t.Errorf("reset: %+v", reset)
	}
	for n := 1; n <= Count; n++ {
		if s := h.slot(n); s.Kind != KindNone || s.Run {
			t.Errorf("slot %d after a reset: %+v", n, s)
		}
	}
	if s := h.slot(4); s.State != External {
		t.Error("a reset touched the external stream")
	}
}

func TestTheMediaLibrarysFileUser(t *testing.T) {
	h := newHarness(t)
	h.file("cats/a.mp4", h264Info)
	h.file("cats/b.mp4", h264Info)
	h.file("cats.mp4", h264Info)
	must(t, h.m.AssignFile(1, "cats/a.mp4", 0))
	must(t, h.m.AssignFile(2, "cats/b.mp4", 0))
	must(t, h.m.AssignFile(3, "cats.mp4", 0))
	must(t, h.m.AssignFile(4, "cats/a.mp4", 0))
	if got := h.m.SlotsUsing("cats/a.mp4"); !slices.Equal(got, []int{1, 4}) {
		t.Errorf("slots using a file: %v", got)
	}
	if got := h.m.SlotsUsing("cats"); len(got) != 0 {
		t.Errorf("slots using a folder's name: %v", got)
	}

	must(t, h.m.Start(1))
	h.settle()
	old := h.publisher(1)
	// The file is replaced: a new version.
	abs := filepath.Join(h.root, "cats", "a.mp4")
	must(t, os.WriteFile(abs, []byte("another video"), 0o644))
	h.probes.set(abs, h265Info)
	errs := h.m.Restart(context.Background(), []int{1, 4, 0})
	if len(errs) != 3 || errs[0] != nil || errs[1] != nil || errs[2] == nil || !strings.Contains(errs[2].Error(), "no source 0") {
		t.Errorf("restart: %v", errs)
	}
	if old.Status().Running {
		t.Error("the old publisher still runs")
	}
	h.publisher(1)
	h.noPublisher(4)

	// A slot that cannot start again says so, in its place.
	must(t, h.m.Start(2))
	h.settle()
	h.starter.fail(errors.New("exec: out of processes"))
	errs = h.m.Restart(context.Background(), []int{1, 2})
	if len(errs) != 2 || errs[1] == nil || !strings.Contains(errs[1].Error(), "src2: The stream could not be started: exec: out of processes") {
		t.Errorf("a restart that fails: %v", errs)
	}
	h.starter.fail(nil)

	h.m.Unassign([]int{1, 4})
	h.settle()
	h.noPublisher(1)
	if s := h.slot(1); s.Kind != KindNone {
		t.Errorf("an unassigned slot: %+v", s)
	}
}

func TestRenditionsUsageClearingAndPruning(t *testing.T) {
	h := newHarness(t)
	a := h.file("a.mp4", h264Info)
	h.file("b.mp4", h264Info)
	must(t, h.m.AssignFile(1, "a.mp4", 10))
	must(t, h.m.Start(1))
	must(t, h.m.AssignFile(2, "b.mp4", 10))
	must(t, h.m.Start(2))
	eventually(t, "both stream renditions", func() bool {
		h.settle()
		return len(h.starter.running("src1")) == 1 && len(h.starter.running("src2")) == 1
	})
	must(t, h.m.Stop(2))
	h.settle()
	dir := filepath.Join(h.root, renditionsDir)
	// Files Insight did not make stay, whatever is done.
	must(t, os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o644))
	must(t, os.WriteFile(filepath.Join(dir, "old_0123456789abcdef_15fps_h264.mp4"), []byte("x"), 0o644))

	usage, err := h.m.RenditionUsage()
	must(t, err)
	if usage.Count != 2 || usage.InUse != 1 || usage.Bytes != 2*int64(len("rendition")) {
		t.Errorf("usage: %+v", usage)
	}
	cleared, err := h.m.ClearRenditions()
	must(t, err)
	if cleared.Removed != 1 || cleared.Kept != 1 {
		t.Errorf("clear: %+v", cleared)
	}
	if s := h.slot(1); s.State != Starting && s.State != Live {
		t.Errorf("clearing stopped a slot's rendition: %+v", s)
	}

	// The file is replaced: its rendition is stale, but kept while the slot streams it.
	must(t, os.WriteFile(a, []byte("another video, longer"), 0o644))
	must(t, h.m.PruneRenditions())
	if usage, _ := h.m.RenditionUsage(); usage.Count != 1 {
		t.Errorf("a rendition in use was pruned: %+v", usage)
	}
	must(t, h.m.Stop(1))
	h.settle()
	must(t, h.m.PruneRenditions())
	if usage, _ := h.m.RenditionUsage(); usage.Count != 0 {
		t.Errorf("a stale rendition was kept: %+v", usage)
	}
	for _, name := range []string{"notes.txt", "old_0123456789abcdef_15fps_h264.mp4"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s, which Insight did not make, is gone", name)
		}
	}

	// What an encode left unfinished goes at the next start.
	tmp := filepath.Join(dir, ".a_0123456789abcdef_0123456789abcdef_10fps_h264.mp4.tmp")
	must(t, os.WriteFile(tmp, []byte("half"), 0o644))
	h.reopen()
	if _, err := os.Stat(tmp); !os.IsNotExist(err) {
		t.Error("an unfinished rendition was left")
	}
}

func TestPreviewAndHTTPMJPEGGoThroughTheRelay(t *testing.T) {
	h := newHarness(t)
	get := func(serve func(http.ResponseWriter, *http.Request, int), n int) int {
		w := httptest.NewRecorder()
		serve(w, httptest.NewRequest("GET", "/", nil), n)
		return w.Code
	}
	if code := get(h.m.Preview, 1); code != http.StatusConflict {
		t.Errorf("the preview of an idle slot: %d", code)
	}
	if code := get(h.m.Preview, 49); code != http.StatusNotFound {
		t.Errorf("the preview of no slot: %d", code)
	}
	h.mtx.setPath(publishing(1, "h264", true))
	h.mtx.setPath(publishing(2, "mjpeg", false))
	h.settle()
	if code := get(h.m.Preview, 1); code != http.StatusOK {
		t.Errorf("the preview of a live slot: %d", code)
	}
	if code := get(h.m.ServeHTTPMJPEG, 1); code != http.StatusConflict {
		t.Errorf("the HTTP MJPEG output of an H.264 slot: %d", code)
	}
	if code := get(h.m.ServeHTTPMJPEG, 2); code != http.StatusOK {
		t.Errorf("the HTTP MJPEG output of an MJPEG slot: %d", code)
	}
	want := []string{
		"slot-preview/src1 rtsp://127.0.0.1:8554/src1?reader=insight-preview",
		"slot-mjpeg/src2 rtsp://127.0.0.1:8554/src2",
	}
	if served := h.relay.servedAll(); !slices.Equal(served, want) {
		t.Errorf("served %v", served)
	}

	preview, ok := RelayCommand("/usr/bin/ffmpeg", "slot-preview/src1", "rtsp://x/src1")
	if !ok || !strings.Contains(strings.Join(preview.Args, " "), "-i rtsp://x/src1 -fps_mode passthrough -an -vf scale=min(640\\,iw):-2 -c:v mjpeg") {
		t.Errorf("a preview's command: %v", preview)
	}
	copyCmd, ok := RelayCommand("/usr/bin/ffmpeg", "slot-mjpeg/src2", "rtsp://x/src2")
	if !ok || !strings.Contains(strings.Join(copyCmd.Args, " "), "-c:v copy -f mpjpeg -boundary_tag frame pipe:1") {
		t.Errorf("an HTTP output's command: %v", copyCmd)
	}
	if _, ok := RelayCommand("/usr/bin/ffmpeg", "file/a.mp4", "a.mp4"); ok {
		t.Error("a file preview's key made a slot's command")
	}
}

func TestALeftoverPullIsCleared(t *testing.T) {
	h := newHarness(t)
	h.mtx.setPath(mediamtx.Path{Name: "src6", Source: &mediamtx.Source{Type: "rtspSource", Protocol: "rtspSource"}})
	h.settle()
	if calls := h.mtx.takeCalls(); !slices.Equal(calls, []string{"clear src6"}) {
		t.Errorf("a pull this run did not set: %v", calls)
	}
}
