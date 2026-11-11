package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

func TestRouteOnlyMatchesRegisteredACPHTTPResponses(t *testing.T) {
	r := newRelay(nil)
	r.config.Enabled = true
	original := pluginapi.ModelRouteRequest{
		RequestedModel: "acp/example", SourceFormat: responsesFormat,
		AvailableProviders: []string{provider}, Metadata: map[string]any{"request_path": "/v1/responses"},
	}
	cases := []struct {
		name   string
		mutate func(*pluginapi.ModelRouteRequest)
		wants  bool
	}{
		{"native", func(*pluginapi.ModelRouteRequest) {}, true},
		{"chat", func(req *pluginapi.ModelRouteRequest) { req.SourceFormat = "openai" }, false},
		{"compact", func(req *pluginapi.ModelRouteRequest) {
			req.Metadata = map[string]any{"request_path": "/v1/responses/compact"}
		}, false},
		{"websocket", func(req *pluginapi.ModelRouteRequest) { req.Headers = http.Header{"Upgrade": {"websocket"}} }, false},
		{"other-provider", func(req *pluginapi.ModelRouteRequest) { req.AvailableProviders = []string{"elsewhere"} }, false},
		{"other-model", func(req *pluginapi.ModelRouteRequest) { req.RequestedModel = "elsewhere/model" }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := original
			tc.mutate(&req)
			data, _ := json.Marshal(req)
			value, err := r.dispatch(pluginabi.MethodModelRoute, data)
			if err != nil || value.(pluginapi.ModelRouteResponse).Handled != tc.wants {
				t.Fatalf("route=%v error=%v", value, err)
			}
		})
	}
}

func TestConfigurationAndPrivateProfile(t *testing.T) {
	if _, err := parseConfig([]byte("enabled: true\nbridge_profile: relative\n")); err == nil {
		t.Fatal("accepted relative path")
	}
	if _, err := parseConfig([]byte("enabled: true\nproxy_url: illegal\n")); err == nil {
		t.Fatal("accepted an unknown configuration key")
	}
	dir := t.TempDir()
	settings := filepath.Join(dir, "bridge.json")
	keyfile := filepath.Join(dir, "bridge-key.txt")
	write := func(path, value string) {
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(settings, `{"enabled":true,"port":12345}`)
	write(keyfile, "not a key")
	if _, _, err := endpoint(dir); err == nil {
		t.Fatal("accepted invalid key")
	}
	fakeKey := strings.Repeat("a", 64)
	write(keyfile, fakeKey)
	if url, key, err := endpoint(dir); err != nil || url != "http://127.0.0.1:12345/v1/responses" || key != fakeKey {
		t.Fatalf("wrong endpoint result: %v", err)
	}
	write(settings, `{"enabled":false,"port":12345}`)
	if _, _, err := endpoint(dir); err == nil {
		t.Fatal("accepted disabled bridge")
	}
}

func TestForwardSSEReportsTruncationAndOversize(t *testing.T) {
	created := "event: response.created\ndata: {}\n\n"
	completed := "event: response.completed\ndata: {}\n\n"
	for _, tc := range []struct {
		name      string
		input     io.Reader
		events    int
		truncated bool
	}{
		{"normal", strings.NewReader(created + completed), 2, false},
		{"truncated", strings.NewReader(created), 1, true},
		{"oversize", strings.NewReader(strings.Repeat("x", maxEvent+1)), 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var events int
			var truncated bool
			r := newRelay(func(method string, data []byte) ([]byte, error) {
				switch method {
				case pluginabi.MethodHostStreamEmit:
					events++
				case pluginabi.MethodHostStreamClose:
					truncated = strings.Contains(string(data), "stream_truncated")
				default:
					t.Fatalf("unexpected callback %s", method)
				}
				return nil, nil
			})
			r.forward("test", tc.input)
			if events != tc.events || truncated != tc.truncated {
				t.Fatalf("got %d events and truncated=%v", events, truncated)
			}
		})
	}
}

func TestBridgeScopeComesOnlyFromHostMetadataAndIsRekeyed(t *testing.T) {
	if bridgeCallerScope(map[string]any{"client_metadata": map[string]string{"caller_scope": strings.Repeat("b", 64)}}, "secret") != "" {
		t.Fatal("client-supplied scope was accepted")
	}
	scope := strings.Repeat("a", 64)
	meta := map[string]any{"caller_scope": scope}
	token := bridgeCallerScope(meta, "synthetic-bridge-key")
	if len(token) != 64 || token == scope || token != bridgeCallerScope(meta, "synthetic-bridge-key") || token == bridgeCallerScope(meta, "another-bridge-key") {
		t.Fatal("incorrect scope rekeying")
	}
}
