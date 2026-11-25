package mediamtx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// The kinds of failure a Client reports; errors.Is tells them apart.
var (
	// ErrUnavailable is an API that does not answer usefully: not listening (MediaMTX is
	// starting or restarting), too slow, refusing the password, failing, or answering
	// something that cannot be read.
	ErrUnavailable = errors.New("MediaMTX's API is unavailable")
	// ErrNotFound is a session, connection or path MediaMTX does not have (any more).
	ErrNotFound = errors.New("not found in MediaMTX")
	// ErrRejected is a request MediaMTX refused as invalid, such as a pull source it cannot
	// use; the Error's Message says why.
	ErrRejected = errors.New("MediaMTX rejected the request")
)

// Error is a failed API call.
type Error struct {
	// Call says what was asked ("list paths", "kick rtspSession 1a2b").
	Call string
	// Status is the HTTP status MediaMTX answered, or 0 without an answer.
	Status int
	// Message is what MediaMTX or the connection said.
	Message string
	// Kind is ErrUnavailable, ErrNotFound or ErrRejected.
	Kind error
	// cause is the underlying error, such as the context's when it ended.
	cause error
}

func (e *Error) Error() string {
	text := "mediamtx: " + e.Call
	if e.Status != 0 {
		text += ": " + strconv.Itoa(e.Status)
	}
	if e.Message != "" {
		text += ": " + e.Message
	}
	return text
}

// Unwrap gives errors.Is and errors.As the kind and the cause.
func (e *Error) Unwrap() []error { return []error{e.Kind, e.cause} }

const (
	// defaultTimeout bounds each of a Client's methods, a snapshot's calls together: they
	// are loopback calls of a few milliseconds, and the slots take a snapshot every second.
	defaultTimeout = time.Second
	pageSize       = 1000
	maxAnswer      = 16 << 20
)

// Client calls MediaMTX's API with this run's credentials. It keeps no state between calls
// and is safe for concurrent use.
type Client struct {
	base      string
	password  string
	publisher string
	http      *http.Client
	timeout   time.Duration
}

// NewClient makes a client of the API at baseURL (APIURL) for the run whose secrets s are.
func NewClient(baseURL string, s Secrets) *Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil // a loopback API and its password never go through a proxy
	return &Client{
		base:      strings.TrimRight(baseURL, "/"),
		password:  s.APIPassword,
		publisher: s.Publisher,
		http:      &http.Client{Transport: transport},
		timeout:   defaultTimeout,
	}
}

// Snapshot lists MediaMTX's paths and its sessions and joins them: each path's publisher with
// its protocol and address, and its readers. A protocol that is switched off has no session
// list, which is not an error.
func (c *Client) Snapshot(ctx context.Context) (Snapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	paths, err := list[apiPath](ctx, c, "paths")
	var apiErr *Error
	if errors.As(err, &apiErr) && apiErr.Kind == ErrNotFound {
		// Every MediaMTX has a path list: whatever answers without one is not its API.
		apiErr.Kind = ErrUnavailable
	}
	if err != nil {
		return Snapshot{}, err
	}
	at := time.Now()
	for _, path := range paths {
		if path.Name == "" {
			return Snapshot{}, &Error{Call: "list paths", Message: "a path without a name", Kind: ErrUnavailable}
		}
	}
	sessions := make(map[string][]apiSession, len(sessionKinds))
	for _, kind := range sessionKinds {
		items, err := list[apiSession](ctx, c, kind.endpoint)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return Snapshot{}, err
		}
		sessions[kind.sourceType] = items
	}
	return buildSnapshot(at, paths, sessions, c.publisher), nil
}

// Kick ends a publishing or reading session, named by its type and id as a snapshot gives
// them (Source.Type and Source.ID). ErrNotFound means it had ended already.
func (c *Client) Kick(ctx context.Context, sessionType, id string) error {
	kind, ok := kindOf(sessionType)
	if !ok {
		return fmt.Errorf("mediamtx: a %q cannot be kicked", sessionType)
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	call := "kick " + sessionType + " " + id
	return c.expectOK(c.do(ctx, call, http.MethodPost, "/v3/"+kind.endpoint+"/kick/"+url.PathEscape(id), nil))
}

// SetPullSource points path name at a camera's URL: MediaMTX pulls it over TCP, keeps the
// connection while nothing reads it, reconnects on its own and forwards the stream unchanged.
// The path refuses publishers meanwhile. The URL may hold credentials; no error repeats it.
func (c *Client) SetPullSource(ctx context.Context, name, source string) error {
	err := c.patchPath(ctx, "set the pull source of "+name, name,
		map[string]any{"source": source, "sourceOnDemand": false, "rtspTransport": "tcp"})
	var apiErr *Error
	if errors.As(err, &apiErr) {
		apiErr.Message = redact(apiErr.Message, source)
	}
	return err
}

// ClearPullSource makes path name take publishers again. A path MediaMTX does not have needs
// no clearing, which is not an error.
func (c *Client) ClearPullSource(ctx context.Context, name string) error {
	// "" is refused; "publisher" is MediaMTX's default.
	err := c.patchPath(ctx, "clear the pull source of "+name, name, map[string]any{"source": "publisher"})
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

func (c *Client) patchPath(ctx context.Context, call, name string, body map[string]any) error {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	return c.expectOK(c.do(ctx, call, http.MethodPatch, "/v3/config/paths/patch/"+url.PathEscape(name), body))
}

// list reads every page of one of the API's lists.
func list[T any](ctx context.Context, c *Client, endpoint string) ([]T, error) {
	call := "list " + endpoint
	var all []T
	for page := 0; ; page++ {
		target := fmt.Sprintf("/v3/%s/list?itemsPerPage=%d&page=%d", endpoint, pageSize, page)
		a, err := c.do(ctx, call, http.MethodGet, target, nil)
		if err = c.expectOK(a, err); err != nil {
			return nil, err
		}
		var decoded struct {
			PageCount int `json:"pageCount"`
			Items     []T `json:"items"`
		}
		if err := json.Unmarshal(a.body, &decoded); err != nil || decoded.Items == nil {
			return nil, &Error{Call: call, Status: a.status, Message: "an answer that is not a list", Kind: ErrUnavailable, cause: err}
		}
		all = append(all, decoded.Items...)
		if page+1 >= decoded.PageCount {
			return all, nil
		}
	}
}

type answer struct {
	call   string
	status int
	body   []byte
}

// do sends one request. An error means there was no usable answer.
func (c *Client) do(ctx context.Context, call, method, target string, body any) (answer, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return answer{}, fmt.Errorf("mediamtx: %s: %w", call, err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.base+target, reader)
	if err != nil {
		return answer{}, fmt.Errorf("mediamtx: %s: %w", call, err)
	}
	request.SetBasicAuth(APIUser, c.password)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		return answer{}, &Error{Call: call, Message: transportMessage(err), Kind: ErrUnavailable, cause: err}
	}
	defer response.Body.Close()
	content, err := io.ReadAll(io.LimitReader(response.Body, maxAnswer))
	if err != nil {
		return answer{}, &Error{Call: call, Status: response.StatusCode, Message: "the answer broke off", Kind: ErrUnavailable, cause: err}
	}
	return answer{call: call, status: response.StatusCode, body: content}, nil
}

// expectOK turns an answer other than 200 into an Error of its kind.
func (c *Client) expectOK(a answer, err error) error {
	if err != nil {
		return err
	}
	if a.status == http.StatusOK {
		return nil
	}
	kind := ErrUnavailable
	switch {
	case a.status == http.StatusNotFound:
		kind = ErrNotFound
	case a.status == http.StatusUnauthorized || a.status == http.StatusForbidden:
		// Not the caller's fault: this run's password and the running MediaMTX disagree.
	case a.status >= 400 && a.status < 500:
		kind = ErrRejected
	}
	return &Error{Call: a.call, Status: a.status, Message: errorMessage(a.body), Kind: kind}
}

// errorMessage is the message of MediaMTX's {"error": "..."} answer, or the answer's start.
func errorMessage(body []byte) string {
	var decoded struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &decoded) == nil && decoded.Error != "" {
		return decoded.Error
	}
	text := strings.TrimSpace(string(body))
	if len(text) > 200 {
		text = text[:200] + "…"
	}
	return text
}

// transportMessage says why a request got no answer, without the request's URL.
func transportMessage(err error) string {
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		err = urlErr.Err
	}
	return err.Error()
}

// redact replaces a pull source and the password it may hold wherever MediaMTX repeated them.
func redact(message, source string) string {
	if source == "" {
		return message
	}
	message = strings.ReplaceAll(message, source, "<the source URL>")
	if parsed, err := url.Parse(source); err == nil && parsed.User != nil {
		if password, ok := parsed.User.Password(); ok && password != "" {
			message = strings.ReplaceAll(message, password, "<password>")
		}
	}
	return message
}
