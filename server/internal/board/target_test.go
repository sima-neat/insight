package board

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func TestTargetIDAndLabel(t *testing.T) {
	for _, test := range []struct {
		target    Target
		id, label string
	}{
		{Target{Mode: ModeSSH, Host: "192.168.1.20", Port: 22, User: "sima"}, "ssh:sima@192.168.1.20:22", "sima@192.168.1.20"},
		{Target{Mode: ModeSSH, Host: "devkit", Port: 2222, User: "dev"}, "ssh:dev@devkit:2222", "dev@devkit:2222"},
		{Target{Mode: ModeSSH, Host: "fe80::1%eth0", Port: 22, User: "sima"}, "ssh:sima@[fe80::1%eth0]:22", "sima@fe80::1%eth0"},
		{LocalTarget(), "local", "This board"},
	} {
		if got := test.target.ID(); got != test.id {
			t.Errorf("ID %q, want %q", got, test.id)
		}
		if got := test.target.Label(); got != test.label {
			t.Errorf("Label %q, want %q", got, test.label)
		}
	}
}

func TestSSHTarget(t *testing.T) {
	target, err := SSHTarget(" 10.0.0.2 ", 0, "", SourceManual)
	if err != nil || target != (Target{Mode: ModeSSH, Host: "10.0.0.2", Port: 22, User: "sima", Source: SourceManual}) {
		t.Errorf("defaults: %+v %v", target, err)
	}
	for _, host := range []string{"devkit.local", "::1", "fe80::1%eth0"} {
		if _, err := SSHTarget(host, 22, "sima", SourceManual); err != nil {
			t.Errorf("%q refused: %v", host, err)
		}
	}
	for _, bad := range []struct {
		host string
		port int
		user string
	}{
		{"", 22, "sima"}, {"-oProxyCommand=x", 22, "sima"}, {"a b", 22, "sima"},
		{"devkit", 70000, "sima"}, {"devkit", -1, "sima"},
		{"devkit", 22, "-l"}, {"devkit", 22, "a b"},
		// netip takes any text as a zone; a shell command in it is no interface's name.
		{"fe80::1%$(touch${IFS}/tmp/x)", 22, "sima"}, {"fe80::1%eth0;id", 22, "sima"},
		{"fe80::1%", 22, "sima"}, {"fe80::1%a-name-over-15-chars", 22, "sima"},
	} {
		if _, err := SSHTarget(bad.host, bad.port, bad.user, SourceManual); codeOf(err) != CodeInvalidRequest {
			t.Errorf("%+v accepted: %v", bad, err)
		}
	}
}

func TestSDKTarget(t *testing.T) {
	env := func(values map[string]string) func(string) string {
		return func(name string) string { return values[name] }
	}
	target, ok := sdkTarget(env(map[string]string{"DEVKIT_SYNC_DEVKIT_IP": "192.168.2.7",
		"DEVKIT_SYNC_DEVKIT_USER": "dev", "DEVKIT_SYNC_DEVKIT_PORT": "2222"}))
	if !ok || target.ID() != "ssh:dev@192.168.2.7:2222" || target.Source != SourceSDKEnv {
		t.Errorf("%+v %v", target, ok)
	}
	if target, ok := sdkTarget(env(map[string]string{"DEVKIT_SYNC_DEVKIT_IP": "192.168.2.2"})); !ok || target.ID() != "ssh:sima@192.168.2.2:22" {
		t.Errorf("defaults: %+v %v", target, ok)
	}
	for _, values := range []map[string]string{
		{},
		{"DEVKIT_SYNC_DEVKIT_IP": "devkit.local"}, // the SDK sets an IP address
		{"DEVKIT_SYNC_DEVKIT_IP": "192.168.2.2", "DEVKIT_SYNC_DEVKIT_PORT": "x"},
		{"SIMA_DEVKIT_IP": "192.168.2.9"}, // sima-cli sets it only beside DEVKIT_SYNC_DEVKIT_IP
	} {
		if target, ok := sdkTarget(env(values)); ok {
			t.Errorf("%v gave %+v", values, target)
		}
	}
}

func TestSSHCommand(t *testing.T) {
	for _, c := range []struct {
		target Target
		want   string
	}{
		{Target{Mode: ModeSSH, Host: "192.168.2.2", Port: 22, User: "sima"}, "ssh sima@192.168.2.2"},
		{Target{Mode: ModeSSH, Host: "fe80::1%eth0", Port: 2222, User: "dev"}, "ssh -p 2222 dev@fe80::1%eth0"},
		// SSHTarget refuses such a host; the command quotes it all the same.
		{Target{Mode: ModeSSH, Host: "a$(id)", Port: 22, User: "sima"}, "ssh sima@'a$(id)'"},
	} {
		if got := c.target.SSHCommand(); got != c.want {
			t.Errorf("%+v: %s, want %s", c.target, got, c.want)
		}
	}
}

func TestShellJoin(t *testing.T) {
	got := shellJoin([]string{"sh", "-c", `echo "$1" it's`, "", "a/b:c=d"})
	if want := `sh -c 'echo "$1" it'"'"'s' '' a/b:c=d`; got != want {
		t.Errorf("%s\nwant %s", got, want)
	}
}

func TestRegistrySelection(t *testing.T) {
	dir := t.TempDir()
	saved := filepath.Join(dir, "data", "board-target.json")
	env := map[string]string{"DEVKIT_SYNC_DEVKIT_IP": "192.168.2.2"}
	newRegistry := func(onBoard bool) *Registry {
		r := NewRegistry(Config{SavedFile: saved, KnownHosts: filepath.Join(dir, "known_hosts"),
			SSHDir: dir, OnBoard: onBoard, Env: func(name string) string { return env[name] }})
		t.Cleanup(r.Close)
		return r
	}
	ids := func(r *Registry) []string {
		var ids []string
		for _, target := range r.Targets() {
			ids = append(ids, target.ID()+" "+string(target.Source))
		}
		return ids
	}

	r := newRegistry(false)
	sdk, _ := r.Selected()
	if sdk.ID() != "ssh:sima@192.168.2.2:22" {
		t.Fatalf("selected %s", sdk.ID())
	}
	if onBoard := newRegistry(true); !slices.Equal(ids(onBoard), []string{"local on-board", "ssh:sima@192.168.2.2:22 sdk-env"}) {
		t.Errorf("on a board: %v", ids(onBoard))
	}

	manual, err := r.Select(Target{Mode: ModeSSH, Host: "10.0.0.5", User: "dev"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(ids(r), []string{"ssh:dev@10.0.0.5:22 manual", "ssh:sima@192.168.2.2:22 sdk-env"}) {
		t.Errorf("after select: %v", ids(r))
	}
	content, _ := os.ReadFile(saved)
	if string(content) != "{\n  \"host\": \"10.0.0.5\",\n  \"port\": 22,\n  \"user\": \"dev\"\n}\n" {
		t.Errorf("saved file %q", content)
	}
	if _, err := r.Board(sdk.ID()); codeOf(err) != CodeNotFound {
		t.Errorf("the board no longer selected: %v", err)
	}
	if got, err := r.Board(manual.ID()); got != manual || err != nil {
		t.Errorf("the selected board: %v", err)
	}
	if _, err := sdk.Run(t.Context(), []string{"true"}); codeOf(err) != CodeBoardChanged {
		t.Errorf("the replaced board ran: %v", err)
	}

	// A later start reads the saved board back.
	if again, _ := newRegistry(false).Selected(); again.ID() != manual.ID() || again.Target().Source != SourceManual {
		t.Errorf("after a restart: %+v", again.Target())
	}

	// Entering the paired board keeps its connection, now as the entered one.
	r2 := newRegistry(false)
	before, _ := r2.Selected()
	if err := r2.Forget(); err != nil {
		t.Fatal(err)
	}
	paired, _ := r2.Selected()
	same, err := r2.Select(paired.Target())
	if err != nil || same != paired || same.Target().Source != SourceManual {
		t.Errorf("selecting the paired board: %+v %v", same.Target(), err)
	}
	if before == paired {
		t.Errorf("forgetting did not replace the board")
	}

	if err := r.Forget(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(saved); !os.IsNotExist(err) {
		t.Errorf("the saved file remains: %v", err)
	}
	if back, _ := r.Selected(); back.ID() != sdk.ID() {
		t.Errorf("after forget: %s", back.ID())
	}

	if _, err := r.Select(LocalTarget()); codeOf(err) != CodeInvalidRequest {
		t.Errorf("selecting the local board: %v", err)
	}
	if _, err := r.Select(Target{Mode: ModeSSH, Host: "bad host"}); codeOf(err) != CodeInvalidRequest {
		t.Errorf("a bad host: %v", err)
	}
}

func TestRegistryWithoutBoards(t *testing.T) {
	dir := t.TempDir()
	saved := filepath.Join(dir, "board.json")
	if err := os.WriteFile(saved, []byte(`{"host": "bad host"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	r := NewRegistry(Config{SavedFile: saved, Env: func(string) string { return "" }})
	if _, err := r.Selected(); codeOf(err) != CodeNoTarget {
		t.Errorf("got %v", err)
	}
	if len(r.Targets()) != 0 {
		t.Errorf("targets %v", r.Targets())
	}
}

func TestKnownHostsReplaceKeepsOtherLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	old, other, presented := newSigner(t).PublicKey(), newSigner(t).PublicKey(), newSigner(t).PublicKey()
	line := func(hosts string, key ssh.PublicKey) string {
		return hosts + " " + strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
	}
	content := "# a comment\n" + line("[10.0.0.2]:2222", other) + "\n" + line("10.0.0.2,devkit", old) + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	hosts := &knownHosts{path: path}
	change, err := hosts.check("10.0.0.2:22", presented)
	if err != nil || change == nil || change.Expected != ssh.FingerprintSHA256(old) {
		t.Fatalf("check: %+v %v", change, err)
	}
	if algorithms, _ := hosts.algorithms("10.0.0.2:22"); !slices.Equal(algorithms, []string{ssh.KeyAlgoED25519}) {
		t.Errorf("algorithms %v", algorithms)
	}
	if err := hosts.replace("10.0.0.2:22", presented); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	want := "# a comment\n" + line("[10.0.0.2]:2222", other) + "\n" + line("devkit", old) + "\n" + line("10.0.0.2", presented) + "\n"
	if string(got) != want {
		t.Errorf("after replace:\n%s\nwant:\n%s", got, want)
	}
	if change, err := hosts.check("10.0.0.2:22", presented); change != nil || err != nil {
		t.Errorf("the trusted key: %+v %v", change, err)
	}
}

func TestStreamStderrKeepsHeadAndTail(t *testing.T) {
	var h headTail
	_, _ = h.Write([]byte(strings.Repeat("h", stderrHead)))
	_, _ = h.Write([]byte(strings.Repeat("m", 10*stderrTail)))
	_, _ = h.Write([]byte("end"))
	got := string(h.bytes())
	if !strings.HasPrefix(got, strings.Repeat("h", stderrHead)+"\n...\n") || !strings.HasSuffix(got, "mend") ||
		len(got) != stderrHead+5+stderrTail {
		t.Errorf("%d bytes: %q…", len(got), got[:20])
	}
}
