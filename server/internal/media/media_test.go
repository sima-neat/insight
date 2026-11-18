package media

import (
	"os"
	"path/filepath"
	"testing"

	"insight/internal/config"
)

// writeFile writes content to root/rel, creating its folders.
func writeFile(t *testing.T, root, rel, content string) string {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func symlink(t *testing.T, target, link string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(link), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
}

func TestRoot(t *testing.T) {
	tests := []struct {
		name  string
		place config.Place
		// workspace sets up the SDK workspace under a temporary folder and returns its path.
		workspace func(t *testing.T, dir string) string
		want      func(data, workspace string) string
	}{
		{
			name:      "a board keeps it in the data folder",
			place:     config.Board,
			workspace: usableWorkspaceIn,
			want:      func(data, _ string) string { return filepath.Join(data, "media") },
		},
		{
			name:      "a host keeps it in the data folder",
			place:     config.Host,
			workspace: usableWorkspaceIn,
			want:      func(data, _ string) string { return filepath.Join(data, "media") },
		},
		{
			name:      "the SDK keeps it in the workspace",
			place:     config.SDK,
			workspace: usableWorkspaceIn,
			want:      func(_, ws string) string { return filepath.Join(ws, ".insight-media") },
		},
		{
			name:  "the SDK without a workspace keeps it in the data folder",
			place: config.SDK,
			workspace: func(t *testing.T, dir string) string {
				return filepath.Join(dir, "workspace")
			},
			want: func(data, _ string) string { return filepath.Join(data, "media") },
		},
		{
			name:  "the SDK with a file for a workspace keeps it in the data folder",
			place: config.SDK,
			workspace: func(t *testing.T, dir string) string {
				return writeFile(t, dir, "workspace", "")
			},
			want: func(data, _ string) string { return filepath.Join(data, "media") },
		},
		{
			name:  "the SDK with a read-only workspace keeps it in the data folder",
			place: config.SDK,
			workspace: func(t *testing.T, dir string) string {
				if os.Geteuid() == 0 {
					t.Skip("root may write to a read-only folder")
				}
				ws := usableWorkspaceIn(t, dir)
				if err := os.Chmod(ws, 0o555); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(ws, 0o755) })
				return ws
			},
			want: func(data, _ string) string { return filepath.Join(data, "media") },
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			data := filepath.Join(dir, "data")
			ws := test.workspace(t, dir)
			got, err := Root(test.place, data, ws)
			if err != nil {
				t.Fatal(err)
			}
			if want := test.want(data, ws); got != want {
				t.Fatalf("Root = %s, want %s", got, want)
			}
			if info, err := os.Stat(got); err != nil || !info.IsDir() {
				t.Fatalf("the media folder was not created: %v", err)
			}
		})
	}
}

func usableWorkspaceIn(t *testing.T, dir string) string {
	t.Helper()
	ws := filepath.Join(dir, "workspace")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	return ws
}
