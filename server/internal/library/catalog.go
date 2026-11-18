package library

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"insight/internal/jobs"
)

const (
	// catalogMaxAge is how long a fetched catalog index answers Catalog and ImportCatalog.
	catalogMaxAge = 5 * time.Minute
	// catalogFetchTimeout bounds fetching the index.
	catalogFetchTimeout = 20 * time.Second
	// maxCatalogBytes bounds the index; the published one is a few hundred kB.
	maxCatalogBytes = 32 << 20
	// downloadStall ends a download that receives nothing for this long.
	downloadStall = time.Minute
	// catalogFolder is the library folder imported assets are saved in, one folder per source.
	catalogFolder = "catalog"
)

// Catalog is the published catalog of media assets, as its index has it, with each asset's
// download URL added as "url". It is shared between callers: read it, never change it.
type Catalog struct {
	Schema      string `json:"schema,omitempty"`
	GeneratedAt string `json:"generated_at,omitempty"`
	IndexURL    string `json:"index_url"`
	BaseURL     string `json:"base_url"`
	// Sources are the videos the assets are made from, as the index has them.
	Sources []json.RawMessage `json:"sources"`
	// Assets are the files to import, as the index has them, each with its "url".
	Assets []map[string]any `json:"assets"`

	byPath map[string]catalogAsset
}

// catalogAsset is what importing an asset reads of it.
type catalogAsset struct {
	Path        string `json:"path"`
	URL         string `json:"-"`
	SourceID    string `json:"source_id"`
	SourceTitle string `json:"source_title"`
	Profile     string `json:"profile"`
	Codec       string `json:"codec"`
	Container   string `json:"container"`
	FPS         any    `json:"fps"`
	Bytes       int64  `json:"bytes"`
	SHA256      string `json:"sha256"`
}

// Catalog returns the catalog, fetched again when the last fetch is older than a few minutes.
// A failed fetch is catalog_unavailable and is not kept: the next call tries again.
func (l *Library) Catalog(ctx context.Context) (*Catalog, error) {
	l.mu.Lock()
	if l.catalog != nil && l.now().Sub(l.catalogAt) < catalogMaxAge {
		catalog := l.catalog
		l.mu.Unlock()
		return catalog, nil
	}
	l.mu.Unlock()
	catalog, err := l.fetchCatalog(ctx)
	if err != nil {
		return nil, &Error{
			Status: http.StatusBadGateway, Code: CodeCatalogUnavailable, err: err,
			Message: fmt.Sprintf("The media catalog could not be fetched: %v.", err),
			Hint:    "The catalog needs internet access from Insight.",
		}
	}
	l.mu.Lock()
	l.catalog, l.catalogAt = catalog, l.now()
	l.mu.Unlock()
	return catalog, nil
}

func (l *Library) fetchCatalog(ctx context.Context) (*Catalog, error) {
	ctx, cancel := context.WithTimeout(ctx, catalogFetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, l.indexURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "neat-insight")
	resp, err := l.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %s", l.indexURL, resp.Status)
	}
	var index struct {
		Schema      string            `json:"schema"`
		GeneratedAt string            `json:"generated_at"`
		Sources     []json.RawMessage `json:"sources"`
		Assets      []json.RawMessage `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxCatalogBytes)).Decode(&index); err != nil {
		return nil, fmt.Errorf("its index is not the catalog's JSON: %w", err)
	}
	catalog := &Catalog{
		Schema: index.Schema, GeneratedAt: index.GeneratedAt,
		IndexURL: l.indexURL, BaseURL: l.baseURL,
		Sources: index.Sources, Assets: []map[string]any{},
		byPath: map[string]catalogAsset{},
	}
	if catalog.Sources == nil {
		catalog.Sources = []json.RawMessage{}
	}
	for _, raw := range index.Assets {
		var listed map[string]any
		if json.Unmarshal(raw, &listed) != nil || listed == nil {
			continue // not an object: nothing to list
		}
		var asset catalogAsset
		if json.Unmarshal(raw, &asset) == nil {
			if clean, err := assetPath(asset.Path); err == nil {
				asset.Path, asset.URL = clean, l.assetURL(clean)
				listed["url"] = asset.URL
				catalog.byPath[clean] = asset
			}
		}
		catalog.Assets = append(catalog.Assets, listed)
	}
	return catalog, nil
}

// assetPath checks an asset's path in the catalog: relative, without "..", "\" read as "/".
func assetPath(p string) (string, error) {
	p = strings.ReplaceAll(strings.TrimSpace(p), `\`, "/")
	clean := path.Clean(p)
	if p == "" || strings.HasPrefix(p, "/") || !filepath.IsLocal(clean) || strings.ContainsAny(clean, "?#\x00") {
		return "", &Error{Status: http.StatusBadRequest, Code: CodeInvalidPath,
			Message: fmt.Sprintf("%q is not a path of the media catalog.", p)}
	}
	return clean, nil
}

// assetURL is where the asset at the checked path is downloaded from: below the base URL.
func (l *Library) assetURL(assetPath string) string {
	base, err := url.Parse(l.baseURL)
	if err != nil {
		return l.baseURL + assetPath
	}
	return base.ResolveReference(&url.URL{Path: assetPath}).String()
}

// ImportCatalog starts a job that downloads the catalog's asset at assetPath into the library,
// as catalog/<source>/<source>_<profile>_<fps>fps_<codec>.<container>. It checks the download's
// size and SHA-256 against the catalog's before the file joins the library. A taken name never
// asks: the file is saved as name_2. Catalog assets are made for the board, so they are never
// re-encoded.
func (l *Library) ImportCatalog(ctx context.Context, assetPathText string) (*jobs.Job, error) {
	p, err := assetPath(assetPathText)
	if err != nil {
		return nil, err
	}
	catalog, err := l.Catalog(ctx)
	if err != nil {
		return nil, err
	}
	asset, ok := catalog.byPath[p]
	if !ok {
		return nil, notFound("The media catalog has no asset %s.", p)
	}
	rel := path.Join(catalogFolder, cmp.Or(safeName(asset.SourceID), "catalog_asset"), importName(asset))
	stage, err := l.newStage()
	if err != nil {
		return nil, err
	}
	title := strings.Join(nonEmpty("Import", cmp.Or(asset.SourceTitle, asset.SourceID), asset.Profile, asset.Codec), " ")
	job := l.jobs.Submit(KindCatalogImport, title, func(ctx context.Context, progress *jobs.Progress) (any, error) {
		progress.Set(jobs.ProgressValue{Phase: "download"})
		file := filepath.Join(stage, path.Base(rel))
		if err := l.download(ctx, asset, file, progress); err != nil {
			return nil, err
		}
		progress.Set(jobs.ProgressValue{Phase: "save"})
		return l.place(ctx, file, rel, false, KeepBoth, stage)
	})
	go func() {
		<-job.Done()
		l.removeStage(stage)
	}()
	return job, nil
}

// importName is the file name an asset is saved under.
func importName(asset catalogAsset) string {
	profile := cmp.Or(safeName(asset.Profile), "video")
	fps := ""
	if asset.FPS != nil {
		if text := safeName(fmt.Sprint(asset.FPS)); text != "" {
			fps = "_" + text + "fps"
		}
	}
	codec := cmp.Or(safeName(asset.Codec), "video")
	ext := strings.TrimPrefix(path.Ext(asset.Path), ".")
	ext = strings.ToLower(cmp.Or(safeName(cmp.Or(asset.Container, ext)), "mp4"))
	source := cmp.Or(safeName(asset.SourceID), "catalog_asset")
	return fmt.Sprintf("%s_%s%s_%s.%s", source, profile, fps, codec, ext)
}

func nonEmpty(words ...string) []string {
	var kept []string
	for _, word := range words {
		if word != "" {
			kept = append(kept, word)
		}
	}
	return kept
}

var errStalled = errors.New("stalled")

// download fetches the asset into dst, reporting its progress, and checks its size and SHA-256.
func (l *Library) download(ctx context.Context, asset catalogAsset, dst string, progress *jobs.Progress) error {
	ctx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)
	stall := time.AfterFunc(downloadStall, func() { cancel(errStalled) })
	defer stall.Stop()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, asset.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "neat-insight")
	resp, err := l.client.Do(req)
	if err != nil {
		return downloadError(ctx, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("The catalog's server answered %s for %s.", resp.Status, asset.Path)
	}
	total := asset.Bytes
	if total <= 0 {
		total = resp.ContentLength
	}

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return saveError("saving the download", err)
	}
	defer out.Close()
	hash := sha256.New()
	buf := make([]byte, 256<<10)
	var got int64
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			stall.Reset(downloadStall)
			if _, err := out.Write(buf[:n]); err != nil {
				return saveError("saving the download", err)
			}
			hash.Write(buf[:n])
			got += int64(n)
			if asset.Bytes > 0 && got > asset.Bytes {
				return fmt.Errorf("The download is larger than the catalog's %s; nothing was saved.", sizeText(asset.Bytes))
			}
			if total > 0 {
				progress.SetPercent(100 * float64(got) / float64(total))
				progress.SetDetail(fmt.Sprintf("%s / %s MB", megabytes(got), megabytes(total)))
			} else {
				progress.SetDetail(megabytes(got) + " MB")
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return downloadError(ctx, readErr)
		}
	}
	if err := out.Close(); err != nil {
		return saveError("saving the download", err)
	}
	if asset.Bytes > 0 && got != asset.Bytes {
		return fmt.Errorf("The download ended after %s of %s; nothing was saved.", sizeText(got), sizeText(asset.Bytes))
	}
	if want := strings.ToLower(strings.TrimSpace(asset.SHA256)); want != "" {
		if sum := hex.EncodeToString(hash.Sum(nil)); sum != want {
			return fmt.Errorf("The download's SHA-256 is %s, not the catalog's %s; nothing was saved.", sum, want)
		}
	}
	return nil
}

// downloadError says why a download broke off: cancelled (the job's own error), stalled, or
// what the network said.
func downloadError(ctx context.Context, err error) error {
	if errors.Is(context.Cause(ctx), errStalled) {
		return fmt.Errorf("The catalog's server sent nothing for %d s; nothing was saved.", int(downloadStall.Seconds()))
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return fmt.Errorf("The download broke off: %v; nothing was saved.", err)
}

// megabytes writes bytes in MB to a tenth, as the import's progress shows them: "12.3".
func megabytes(bytes int64) string {
	return fmt.Sprintf("%.1f", float64(bytes)/1e6)
}
