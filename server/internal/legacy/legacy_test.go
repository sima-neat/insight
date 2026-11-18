package legacy

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"slices"
	"strconv"
	"testing"
	"time"

	"insight/internal/supervisor"
)

// The test binary stands in for the Python interpreter: run with FAKE_LEGACY_BACKEND set, it
// serves what the old backend would on the port it is given.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_LEGACY_BACKEND") == "1" {
		fakeBackend()
		return
	}
	os.Exit(m.Run())
}

func fakeBackend() {
	i := slices.Index(os.Args, "--port")
	if i < 0 || !slices.Contains(os.Args, "--behind-proxy") {
		fmt.Println("missing --port or --behind-proxy")
		os.Exit(2)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"status":"ok"}`)) })
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]string{
			"path": r.URL.Path, "host": r.Host, "proto": r.Header.Get("X-Forwarded-Proto"),
		})
	})
	fmt.Println("fake backend up")
	http.ListenAndServe("127.0.0.1:"+os.Args[i+1], mux)
}

func TestTheOldBackendIsStartedAndProxied(t *testing.T) {
	t.Setenv("FAKE_LEGACY_BACKEND", "1")
	sup, err := supervisor.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer sup.StopAll(context.Background())
	backend, err := Start(ctx, sup, Options{Python: os.Args[0], CertFile: "c.pem", KeyFile: "k.pem"})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for !backend.Ready() {
		if time.Now().After(deadline) {
			t.Fatalf("not ready; it printed %v", backend.Process().Tail())
		}
		time.Sleep(50 * time.Millisecond)
	}

	front := httptest.NewTLSServer(backend.Handler())
	defer front.Close()
	resp, err := front.Client().Get(front.URL + "/api/mediasrc?x=1")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var got map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	frontHost, _ := url.Parse(front.URL)
	if got["path"] != "/api/mediasrc" || got["host"] != frontHost.Host || got["proto"] != "https" {
		t.Fatalf("the backend saw %v", got)
	}
}

func TestAnUnreachableBackendAnswersTheErrorShape(t *testing.T) {
	port, err := freeLoopbackPort()
	if err != nil {
		t.Fatal(err)
	}
	backend := &Backend{target: &url.URL{Scheme: "http", Host: "127.0.0.1:" + strconv.Itoa(port)}}
	w := httptest.NewRecorder()
	backend.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/mediasrc", nil))
	var body struct {
		Error struct{ Code, Message string }
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("%v: %s", err, w.Body.String())
	}
	if w.Code != http.StatusServiceUnavailable || body.Error.Code != "backend_starting" {
		t.Fatalf("%d %+v", w.Code, body)
	}
	backend.ready.Store(true)
	w = httptest.NewRecorder()
	backend.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/mediasrc", nil))
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status %d once it had been ready", w.Code)
	}
}
