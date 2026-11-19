// Package api holds the server's API description (openapi.yaml) and the Go types and routing
// generated from it. Change openapi.yaml, then run `go generate ./...` in server/.
package api

import _ "embed"

//go:generate go tool oapi-codegen -config oapi-codegen.yaml openapi.yaml

// Document is openapi.yaml as the server was built with it, served at /api/openapi.yaml.
//
//go:embed openapi.yaml
var Document []byte
