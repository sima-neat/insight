// Package api holds the server's API description (openapi.yaml) and the Go types and routing
// generated from it. Change openapi.yaml, then run `go generate ./...` in server/.
package api

//go:generate go tool oapi-codegen -config oapi-codegen.yaml openapi.yaml
