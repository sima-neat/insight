// Package boardtest makes a board for the tests of the packages that use one: the board
// Insight runs on (local mode), whose programs a test replaces with scripts of its own and
// whose Sentinel is an HTTP handler of the test's. Only tests import it.
package boardtest

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"insight/internal/board"
)

// Fixture is a registry whose selected board is the local one.
type Fixture struct {
	Registry *board.Registry
	Board    *board.Board
	// Socket is where the board's Sentinel listens.
	Socket string
	bin    string
}

// New makes the fixture. sentinel answers the board's Sentinel requests; nil leaves its socket
// absent, as on a board without Sentinel. The test's PATH gets a folder of its own first, for
// Program; New uses t.Setenv, so the test must not run in parallel.
func New(t testing.TB, sentinel http.Handler) *Fixture {
	t.Helper()
	// A socket's path must fit in 108 bytes, which a test's TempDir may not.
	dir, err := os.MkdirTemp("", "boardtest")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) }) // the folder MkdirTemp just made
	f := &Fixture{Socket: filepath.Join(dir, "api.sock"), bin: filepath.Join(dir, "bin")}
	if err := os.Mkdir(f.bin, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", f.bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	if sentinel != nil {
		f.Serve(t, sentinel)
	}
	f.Registry = board.NewRegistry(board.Config{
		SavedFile: filepath.Join(dir, "board-target.json"), KnownHosts: filepath.Join(dir, "known_hosts"),
		OnBoard: true, Env: func(string) string { return "" }, SentinelSocket: f.Socket,
	})
	t.Cleanup(f.Registry.Close)
	if f.Board, err = f.Registry.Selected(); err != nil {
		t.Fatal(err)
	}
	return f
}

// Serve answers the board's Sentinel requests with handler, from now until the test ends.
func (f *Fixture) Serve(t testing.TB, handler http.Handler) {
	t.Helper()
	listener, err := (&net.ListenConfig{}).Listen(context.Background(), "unix", f.Socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
}

// Program puts an executable named name on the board, a shell script, ahead of any program of
// that name.
func (f *Fixture) Program(t testing.TB, name, script string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(f.bin, name), []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}
