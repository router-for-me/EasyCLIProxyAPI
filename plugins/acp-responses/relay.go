package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"gopkg.in/yaml.v3"
)

const (
	provider        = "openai-compatible-ecpa-antigravity-acp"
	responsesFormat = "openai-response"
	maxEvent        = 2 << 20
	maxActive       = 16
	ipcTimeout      = 185 * time.Second
)

type hostCaller func(string, []byte) ([]byte, error)
type configuration struct {
	Enabled       bool   `yaml:"enabled"`
	Priority      int    `yaml:"priority"`
	BridgeProfile string `yaml:"bridge_profile"`
}
type relay struct {
	mu     sync.Mutex
	active map[string]context.CancelFunc
	paused bool
	config configuration
	call   hostCaller
	ipc    *http.Client
}
type httpFailure struct {
	status  int
	message string
}

func (err *httpFailure) Error() string             { return err.message }
func fail(status int, message string) *httpFailure { return &httpFailure{status, message} }

func newRelay(call hostCaller) *relay {
	// This is private ECPA IPC, not a remote model upstream. CPA's host HTTP
	// callback can send requests for 127.0.0.1 through its configured proxy.
	// Never send bridge credentials or prompt data via that transport.
	return &relay{active: map[string]context.CancelFunc{}, call: call, ipc: &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				host, _, err := net.SplitHostPort(address)
				if err != nil || host != "127.0.0.1" {
					return nil, errors.New("ACP IPC is restricted to IPv4 loopback")
				}
				return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp4", address)
			},
			DisableKeepAlives:      true,
			DisableCompression:     true,
			MaxResponseHeaderBytes: 64 << 10,
		},
	}}
}

func (r *relay) stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.paused = true
	for _, cancel := range r.active {
		cancel()
	}
}

func (r *relay) invoke(method string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = r.call(method, data)
	return err
}

func parseConfig(raw []byte) (configuration, error) {
	var cfg configuration
	if len(bytes.TrimSpace(raw)) > 0 {
		decoder := yaml.NewDecoder(bytes.NewReader(raw))
		decoder.KnownFields(true)
		if err := decoder.Decode(&cfg); err != nil {
			return cfg, errors.New("invalid ACP executor settings")
		}
	}
	if cfg.Enabled && !filepath.IsAbs(cfg.BridgeProfile) {
		return cfg, errors.New("bridge_profile must be the absolute ECPA ACP profile path")
	}
	return cfg, nil
}

func (r *relay) dispatch(method string, data []byte) (any, error) {
	switch method {
	case pluginabi.MethodPluginRegister, pluginabi.MethodPluginReconfigure:
		var request struct {
			ConfigYAML []byte `json:"config_yaml"`
			Schema     uint32 `json:"schema_version"`
		}
		if err := json.Unmarshal(data, &request); err != nil {
			return nil, err
		}
		if request.Schema < 10 {
			return nil, errors.New("ACP Responses requires CPA 8.0.78 or newer")
		}
		cfg, err := parseConfig(request.ConfigYAML)
		if err != nil {
			return nil, err
		}
		r.mu.Lock()
		r.config, r.paused = cfg, false
		r.mu.Unlock()
		return map[string]any{
			"schema_version": 10,
			"metadata":       pluginapi.Metadata{Name: "ECPA ACP Responses", Version: "0.1.0", Author: "EasyCLIProxyAPI", GitHubRepository: "https://github.com/router-for-me/EasyCLIProxyAPI"},
			"capabilities": map[string]any{"model_router": true, "request_lifecycle_plugin": true, "executor": true,
				"executor_model_scope": "static", "executor_input_formats": []string{"responses"}, "executor_output_formats": []string{"responses"}},
		}, nil
	case pluginabi.MethodPluginQuiesce, pluginabi.MethodPluginShutdown:
		r.stop()
		return struct{}{}, nil
	case pluginabi.MethodExecutorIdentifier:
		return map[string]string{"identifier": "ecpa-acp-responses"}, nil
	case pluginabi.MethodRequestComplete:
		var req pluginapi.RequestCompletion
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		r.mu.Lock()
		cancel := r.active[req.RequestID]
		r.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		return struct{}{}, nil
	case pluginabi.MethodModelRoute:
		var req pluginapi.ModelRouteRequest
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, err
		}
		r.mu.Lock()
		enabled := r.config.Enabled && !r.paused
		r.mu.Unlock()
		if !enabled || !nativeHTTP(req.SourceFormat, req.RequestedModel, req.Headers, req.Metadata) {
			return pluginapi.ModelRouteResponse{}, nil
		}
		for _, candidate := range req.AvailableProviders {
			if candidate == provider {
				return pluginapi.ModelRouteResponse{Handled: true, TargetKind: pluginapi.ModelRouteTargetSelf}, nil
			}
		}
		return pluginapi.ModelRouteResponse{}, nil
	case pluginabi.MethodExecutorExecute, pluginabi.MethodExecutorExecuteStream:
		return r.execute(method, data)
	default:
		return nil, fmt.Errorf("unsupported ACP executor method")
	}
}

func nativeHTTP(format, model string, headers http.Header, metadata map[string]any) bool {
	path, _ := metadata["request_path"].(string)
	return format == responsesFormat && path == "/v1/responses" && headers.Get("Upgrade") == "" && strings.HasPrefix(model, "acp/")
}

type executorCall struct {
	pluginapi.ExecutorRequest
	StreamID string `json:"stream_id"`
}

func bounded(body io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if len(data) > int(limit) {
		return nil, errors.New("ACP IPC size limit exceeded")
	}
	return data, err
}

func privateFile(path string, maxSize int64) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Size() > maxSize {
		return nil, errors.New("ACP settings must be a small regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !os.SameFile(before, info) {
		return nil, errors.New("ACP private file changed while opening")
	}
	if os.PathSeparator == '/' && info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("ACP file is not private")
	}
	return bounded(file, maxSize)
}

func endpoint(profile string) (string, string, error) {
	var settings struct {
		Enabled bool   `json:"enabled"`
		Port    uint16 `json:"port"`
	}
	raw, err := privateFile(filepath.Join(profile, "bridge.json"), 8192)
	if err != nil || json.Unmarshal(raw, &settings) != nil || !settings.Enabled || settings.Port == 0 {
		return "", "", fail(503, "ACP bridge is not enabled")
	}
	key, err := privateFile(filepath.Join(profile, "bridge-key.txt"), 64)
	if err != nil || len(key) != 64 {
		return "", "", fail(503, "ACP bridge key unavailable")
	}
	for _, b := range key {
		if !strings.ContainsRune("0123456789abcdefABCDEF", rune(b)) {
			return "", "", fail(503, "ACP bridge key invalid")
		}
	}
	return "http://127.0.0.1:" + strconv.Itoa(int(settings.Port)) + "/v1/responses", string(key), nil
}

func upstreamFailure(status int, body []byte) error {
	if status < 400 || status > 599 {
		return fail(502, "Unexpected ACP bridge HTTP status")
	}
	var value struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &value)
	if value.Error.Message == "" {
		value.Error.Message = "ACP bridge rejected the request"
	}
	return fail(status, value.Error.Message)
}

// CPA constructs caller_scope from its authenticated API-key context. Do not
// use inbound headers, request metadata from the JSON body or the raw key.
func bridgeCallerScope(metadata map[string]any, key string) string {
	scope, _ := metadata["caller_scope"].(string)
	decoded, err := hex.DecodeString(scope)
	if err != nil || len(decoded) != sha256.Size {
		return ""
	}
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("ecpa-acp-caller-v1\x00"))
	mac.Write(decoded)
	return hex.EncodeToString(mac.Sum(nil))
}

func (r *relay) execute(method string, data []byte) (any, error) {
	var req executorCall
	if err := json.Unmarshal(data, &req); err != nil {
		return nil, fail(400, "Invalid CPA ACP executor envelope")
	}
	if !nativeHTTP(req.SourceFormat, req.Model, req.Headers, req.Metadata) || req.Alt != "" || req.Stream != (method == pluginabi.MethodExecutorExecuteStream) {
		return nil, fail(400, "ACP native executor supports HTTP Responses only")
	}
	id, _ := req.Metadata["request_id"].(string)
	if id == "" || (req.Stream && req.StreamID == "") {
		return nil, fail(503, "CPA ACP execution lifecycle is unavailable")
	}
	var body, original map[string]json.RawMessage
	if len(req.Payload) > maxEvent || json.Unmarshal(req.Payload, &body) != nil || body == nil ||
		len(req.OriginalRequest) > maxEvent || json.Unmarshal(req.OriginalRequest, &original) != nil || original == nil {
		return nil, fail(400, "Invalid ACP native request")
	}
	// Do not replay original input over host-side request interception. Check
	// that critical continuation data survived the host's format negotiation.
	for _, field := range []string{"input", "previous_response_id"} {
		if len(original[field]) > 0 && len(body[field]) == 0 {
			return nil, fail(400, "CPA dropped a field required for ACP continuation")
		}
	}
	body["model"], _ = json.Marshal(req.Model)
	body["stream"], _ = json.Marshal(req.Stream)
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, fail(400, "Invalid ACP native request")
	}
	r.mu.Lock()
	cfg := r.config
	if !cfg.Enabled || r.paused {
		r.mu.Unlock()
		return nil, fail(503, "ACP native executor is disabled")
	}
	if len(r.active) >= maxActive || r.active[id] != nil {
		r.mu.Unlock()
		return nil, fail(429, "ACP executor already active or busy")
	}
	ctx, cancel := context.WithTimeout(context.Background(), ipcTimeout)
	r.active[id] = cancel
	r.mu.Unlock()
	cleanup := func() { cancel(); r.mu.Lock(); delete(r.active, id); r.mu.Unlock() }
	handoff := false
	defer func() {
		if !handoff {
			cleanup()
		}
	}()
	url, key, err := endpoint(cfg.BridgeProfile)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(encoded))
	if err != nil {
		return nil, fail(503, "ACP bridge endpoint is unavailable")
	}
	request.Header.Set("Authorization", "Bearer "+key)
	if scope := bridgeCallerScope(req.Metadata, key); scope != "" {
		request.Header.Set("X-Ecpa-Acp-Caller-Scope", scope)
	}
	request.Header.Set("Content-Type", "application/json")
	request.GetBody = nil // A transport failure is not permission to replay a turn.
	res, err := r.ipc.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, fail(504, "ACP bridge timed out; request was not retried")
		}
		return nil, fail(502, "ACP bridge request ended; request was not retried")
	}
	if res.StatusCode != 200 || !req.Stream {
		defer res.Body.Close()
		payload, err := bounded(res.Body, maxEvent)
		if err != nil {
			return nil, fail(502, "Could not read the ACP bridge response")
		}
		if res.StatusCode != 200 {
			return nil, upstreamFailure(res.StatusCode, payload)
		}
		return pluginapi.ExecutorResponse{Payload: payload, Headers: http.Header{"Content-Type": {"application/json"}}}, nil
	}
	if res.Header.Get("Content-Type") != "text/event-stream" {
		res.Body.Close()
		return nil, fail(502, "ACP bridge did not return SSE")
	}
	go func() { defer cleanup(); defer res.Body.Close(); r.forward(req.StreamID, res.Body) }()
	handoff = true
	return map[string]any{"headers": http.Header{"Content-Type": {"text/event-stream"}}}, nil
}

func (r *relay) forward(id string, reader io.Reader) {
	terminal := false
	defer func() {
		close := map[string]any{"stream_id": id}
		if !terminal {
			close["error_detail"] = map[string]any{"code": "stream_truncated", "message": "ACP bridge stream ended before a terminal event", "http_status": 502}
		}
		_ = r.invoke(pluginabi.MethodHostStreamClose, close)
	}()
	input := bufio.NewReader(reader)
	var frame []byte
	for {
		fragment, err := input.ReadSlice('\n')
		frame = append(frame, fragment...)
		if len(frame) > maxEvent {
			return
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			return
		}
		if !bytes.HasSuffix(frame, []byte("\n\n")) {
			continue
		}
		if err := r.invoke(pluginabi.MethodHostStreamEmit, map[string]any{"stream_id": id, "payload": frame}); err != nil {
			return
		}
		if bytes.HasPrefix(frame, []byte("event: response.completed\n")) || bytes.HasPrefix(frame, []byte("event: error\n")) {
			terminal = true
			return
		}
		frame = frame[:0]
	}
}
