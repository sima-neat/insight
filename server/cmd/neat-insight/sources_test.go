package main

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"insight/internal/jobs"
	"insight/internal/library"
	"insight/internal/media"
)

type noSlots struct{}

func (noSlots) SlotsUsing(string) []int                { return nil }
func (noSlots) Restart(context.Context, []int) []error { return nil }
func (noSlots) Unassign([]int)                         {}

func TestProducersHandEachKeyToItsOwner(t *testing.T) {
	root := t.TempDir()
	lib, err := library.New(library.Options{Root: root, Cache: media.NewCache(t.Context(), nil),
		FFmpeg: "/opt/ffmpeg", Jobs: jobs.New(nil), Files: noSlots{}})
	if err != nil {
		t.Fatal(err)
	}
	p := &producers{ffmpeg: "/opt/ffmpeg"}

	if _, err := p.start(library.PreviewKeyPrefix+"clip.mp4", filepath.Join(root, "clip.mp4")); err == nil {
		t.Fatal("a file preview started before the library was ready")
	}
	p.library = lib
	preview, err := p.start(library.PreviewKeyPrefix+"clip.mp4", filepath.Join(root, "clip.mp4"))
	if err != nil || preview.Path != "/opt/ffmpeg" || !slices.Contains(preview.Args, "-stream_loop") {
		t.Fatalf("the file preview: %v %v", preview, err)
	}
	if _, err := p.start(library.PreviewKeyPrefix+"x", "/etc/passwd"); err == nil {
		t.Fatal("a preview of a file outside the library started")
	}

	slot, err := p.start("slot-preview/src3", "rtsp://127.0.0.1:8554/src3")
	if err != nil || slot.Path != "/opt/ffmpeg" || !strings.Contains(strings.Join(slot.Args, " "), "rtsp://127.0.0.1:8554/src3") {
		t.Fatalf("the slot preview: %v %v", slot, err)
	}
	if _, err := p.start("something/else", "x"); err == nil {
		t.Fatal("an unknown key started a producer")
	}
	p.ffmpeg = ""
	if _, err := p.start("slot-mjpeg/src3", "rtsp://127.0.0.1:8554/src3"); err == nil {
		t.Fatal("a slot's stream started without FFmpeg")
	}
}
