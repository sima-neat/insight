// Package spa serves the web UI, built into the server binary.
//
// The build copies the frontend's production build (frontend/dist) into dist/ before compiling
// the server; a server built without it answers every page with a note saying so.
package spa

import (
	"embed"
	"errors"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strings"
)

//go:embed all:dist
var embedded embed.FS

// Files is the built frontend.
func Files() fs.FS {
	files, err := fs.Sub(embedded, "dist")
	if err != nil {
		panic(err) // "dist" is embedded above, so this cannot happen
	}
	return files
}

// hashed matches the file names Angular's build gives its bundles ("main-B2TFS5NE.js"): their
// content never changes under one name, so browsers may keep them.
var hashed = regexp.MustCompile(`-[A-Za-z0-9_]{8}\.(js|css)$`)

// Handler serves files from files, and index.html for every other path without a file
// extension (the app's own routes, such as /viewer); a missing file with an extension is 404.
func Handler(files fs.FS) http.Handler {
	fileServer := http.FileServerFS(files)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if name != "" && name != "index.html" {
			if info, err := fs.Stat(files, name); err == nil && !info.IsDir() {
				if hashed.MatchString(name) {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else {
					w.Header().Set("Cache-Control", "no-cache")
				}
				fileServer.ServeHTTP(w, r)
				return
			}
			if path.Ext(name) != "" {
				http.NotFound(w, r)
				return
			}
		}
		index, err := fs.ReadFile(files, "index.html")
		if errors.Is(err, fs.ErrNotExist) {
			http.Error(w, "This server was built without its web UI. Build it with ./build.sh.",
				http.StatusServiceUnavailable)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(index)
	})
}
