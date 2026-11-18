package web

import (
	"net/http"

	"insight/api"
	"insight/internal/library"
)

// The media library's routes answer with the library package's own types, which the API
// document describes (contract_test.go holds the two together).

func (h *handlers) GetMediaTree(w http.ResponseWriter, r *http.Request) {
	tree, err := h.deps.Library.Tree()
	if err != nil {
		library.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tree)
}

func (h *handlers) GetMediaInfo(w http.ResponseWriter, r *http.Request, params api.GetMediaInfoParams) {
	info, err := h.deps.Library.Info(r.Context(), params.Path)
	if err != nil {
		library.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, info)
}

func (h *handlers) DeleteMedia(w http.ResponseWriter, r *http.Request) {
	var body api.MediaDeleteRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	deleted, err := h.deps.Library.Delete(body.Paths)
	if err != nil {
		library.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, deleted)
}

func (h *handlers) UploadMedia(w http.ResponseWriter, r *http.Request) {
	result, err := h.deps.Library.Upload(w, r)
	switch {
	case err != nil:
		library.WriteError(w, err)
	case result.Job != nil:
		writeJSON(w, http.StatusAccepted, result.Job.Snapshot())
	default:
		writeJSON(w, http.StatusCreated, result.Saved)
	}
}

func (h *handlers) GetMediaFile(w http.ResponseWriter, r *http.Request, params api.GetMediaFileParams) {
	h.deps.Library.File(w, r, params.Path)
}

func (h *handlers) PreviewMedia(w http.ResponseWriter, r *http.Request, params api.PreviewMediaParams) {
	h.deps.Library.Preview(w, r, params.Path)
}

func (h *handlers) GetCatalog(w http.ResponseWriter, r *http.Request) {
	catalog, err := h.deps.Library.Catalog(r.Context())
	if err != nil {
		library.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, catalog)
}

func (h *handlers) ImportCatalogAsset(w http.ResponseWriter, r *http.Request) {
	var body api.CatalogImportRequest
	if !decodeJSON(w, r, &body) {
		return
	}
	job, err := h.deps.Library.ImportCatalog(r.Context(), body.Path)
	if err != nil {
		library.WriteError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, job.Snapshot())
}
