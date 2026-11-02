package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

const validConfig = `enabled: true
alias: semantic-auto
classifier: {provider: local, model: classifier}
fallback: {provider: local, model: general}
timeout_ms: 100
candidates:
  - {provider: local, model: coder, description: 编程任务}
  - {provider: local, model: writer, description: 文学写作}
`

func configured(t *testing.T, call hostCaller) *router {
	t.Helper()
	router := newRouter(call)
	data, _ := json.Marshal(map[string]any{"schema_version": 6, "config_yaml": []byte(validConfig)})
	if _, err := router.dispatch(pluginabi.MethodPluginRegister, data); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(router.stop)
	return router
}

func catalogBytes(models ...string) []byte {
	data, _ := json.Marshal(pluginapi.HostAuthModelsResponse{Credentials: []pluginapi.HostAuthModels{{Provider: "local", Models: models}}})
	return data
}

func completion(answer string) []byte {
	body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": answer}}}})
	data, _ := json.Marshal(pluginapi.HostModelExecutionResponse{StatusCode: 200, Body: body})
	return data
}

func request(text string) pluginapi.ModelRouteRequest {
	body, _ := json.Marshal(map[string]any{"model": "semantic-auto", "messages": []any{map[string]any{"role": "user", "content": text}}, "stream": true, "temperature": 0.7, "tools": []any{map[string]any{"type": "function", "function": map[string]any{"name": "run"}}}, "tool_choice": "auto"})
	return pluginapi.ModelRouteRequest{RequestedModel: "semantic-auto", Body: body, AvailableProviders: []string{"local"}, Stream: true}
}

func TestContentSelectionAndPayloadPreservation(t *testing.T) {
	router := configured(t, func(method string, data []byte) ([]byte, error) {
		if method == pluginabi.MethodHostAuthModels {
			return catalogBytes("classifier", "general", "coder", "writer"), nil
		}
		var call struct {
			pluginapi.HostModelExecutionRequest
			CallbackID string `json:"host_callback_id"`
		}
		if err := json.Unmarshal(data, &call); err != nil {
			t.Fatal(err)
		}
		if call.Model != "classifier" || call.Stream || call.CallbackID != "scope" || call.ForcedProvider != "local" {
			t.Errorf("unsafe classifier request: %+v", call)
		}
		if bytes.Contains(call.Body, []byte(`"tools"`)) {
			t.Error("tools leaked to classifier")
		}
		if bytes.Contains(call.Body, []byte("诗")) {
			return completion("2"), nil
		}
		return completion("1"), nil
	})
	for _, test := range []struct{ text, model string }{{"请修复这段程序", "coder"}, {"请写一首诗", "writer"}} {
		input := request(test.text)
		original, _ := json.Marshal(input)
		result := router.route(input, "scope")
		if !result.Handled || result.TargetModel != test.model {
			t.Fatalf("%s: %+v", test.text, result)
		}
		after, _ := json.Marshal(input)
		if !bytes.Equal(original, after) {
			t.Fatal("request changed (stream/tools/parameters/messages)")
		}
	}
}

func TestExplicitBypassAndRecursionPrevention(t *testing.T) {
	var calls atomic.Int32
	router := configured(t, func(string, []byte) ([]byte, error) { calls.Add(1); return nil, errors.New("must not call") })
	for _, model := range []string{"coder", "classifier", "AUTO", "auto-extra", ""} {
		input := request("hello")
		input.RequestedModel = model
		if router.route(input, "scope").Handled {
			t.Fatal("explicit model intercepted")
		}
	}
	if calls.Load() != 0 {
		t.Fatal("bypass invoked host")
	}
	if _, err := parseConfiguration([]byte(strings.Replace(validConfig, "model: classifier", "model: semantic-auto", 1))); err == nil {
		t.Fatal("recursive classifier accepted")
	}
	if _, err := parseConfiguration([]byte(strings.Replace(validConfig, "model: general", "model: semantic-auto", 1))); err == nil {
		t.Fatal("recursive fallback accepted")
	}
}

func TestFallbackPaths(t *testing.T) {
	for _, mode := range []string{"error", "bad-json", "out-of-range", "none", "words", "unavailable", "missing-context", "http-error", "disappeared"} {
		t.Run(mode, func(t *testing.T) {
			var catalogs atomic.Int32
			router := configured(t, func(method string, data []byte) ([]byte, error) {
				if method == pluginabi.MethodHostAuthModels {
					count := catalogs.Add(1)
					if mode == "catalog-error" {
						return nil, errors.New("no catalog")
					}
					if mode == "unavailable" || (mode == "disappeared" && count > 1) {
						return catalogBytes("classifier", "general"), nil
					}
					return catalogBytes("classifier", "general", "coder", "writer"), nil
				}
				switch mode {
				case "error":
					return nil, errors.New("failed")
				case "bad-json":
					return []byte(`no`), nil
				case "http-error":
					return []byte(`{"status_code":503}`), nil
				case "out-of-range":
					return completion("3"), nil
				case "none":
					return completion("0"), nil
				case "words":
					return completion("pick 1"), nil
				default:
					return completion("1"), nil
				}
			})
			contextID := "scope"
			if mode == "missing-context" {
				contextID = ""
			}
			result := router.route(request("test"), contextID)
			if !result.Handled || result.TargetModel != "general" {
				t.Fatalf("unexpected fallback: %+v", result)
			}
		})
	}
}

func TestTimeoutAndBoundedWork(t *testing.T) {
	blocked := make(chan struct{})
	var active atomic.Int32
	router := configured(t, func(method string, data []byte) ([]byte, error) {
		if method == pluginabi.MethodHostAuthModels {
			return catalogBytes("classifier", "general", "coder"), nil
		}
		active.Add(1)
		<-blocked
		return completion("1"), nil
	})
	defer close(blocked)
	for index := 0; index < 10; index++ {
		start := time.Now()
		result := router.route(request("test"), "scope")
		if (index < 7 && result.TargetModel != "general") || (index >= 7 && result.Handled) || time.Since(start) > time.Second {
			t.Fatal("timeout failed")
		}
	}
	if active.Load() != 8 {
		t.Fatalf("expected bounded 8 callbacks, got %d", active.Load())
	}
}

func TestConfigurationValidationAndAtomicReload(t *testing.T) {
	for _, invalid := range []string{
		"enabled: true", "timeout_ms: 0", "timeout_ms: 30001", "alias: ''", "alias: auto",
		strings.Replace(validConfig, "description: 编程任务", "description: ''", 1),
		strings.Replace(validConfig, "model: writer", "model: coder", 1),
	} {
		if _, err := parseConfiguration([]byte(invalid)); err == nil {
			t.Fatalf("accepted %s", invalid)
		}
	}
	router := configured(t, nil)
	data, _ := json.Marshal(map[string]any{"schema_version": 6, "config_yaml": []byte("enabled: true")})
	if _, err := router.dispatch(pluginabi.MethodPluginReconfigure, data); err == nil {
		t.Fatal("invalid reload accepted")
	}
	if router.config.Classifier.Model != "classifier" {
		t.Fatal("invalid reload replaced active config")
	}
	if config, err := parseConfiguration(nil); err != nil || config.Enabled {
		t.Fatal("installation should be inert")
	}
}

func TestTextFormats(t *testing.T) {
	for _, body := range []string{
		`{"messages":[{"role":"user","content":"hello"}]}`,
		`{"messages":[{"role":"user","content":[{"type":"text","text":"hello"},{"type":"image_url","image_url":"private"}]}]}`,
		`{"input":"hello"}`,
		`{"input":[{"role":"user","content":[{"type":"input_text","text":"hello"}]}]}`,
	} {
		if text := requestText([]byte(body)); !strings.Contains(text, "hello") || strings.Contains(text, "private") {
			t.Fatalf("bad text %s", text)
		}
	}
}

func TestQuiesceCanResumeButShutdownCannot(t *testing.T) {
	router := configured(t, func(method string, data []byte) ([]byte, error) {
		if method == pluginabi.MethodHostAuthModels {
			return catalogBytes("classifier", "general", "coder"), nil
		}
		return completion("1"), nil
	})
	if _, err := router.dispatch(pluginabi.MethodPluginQuiesce, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	if router.route(request("test"), "scope").Handled {
		t.Fatal("quiesced plugin routed")
	}
	data, _ := json.Marshal(map[string]any{"schema_version": 6, "config_yaml": []byte(validConfig)})
	if _, err := router.dispatch(pluginabi.MethodPluginReconfigure, data); err != nil {
		t.Fatal(err)
	}
	if !router.route(request("test"), "scope").Handled {
		t.Fatal("plugin did not resume after rollback")
	}
	router.stop()
	if _, err := router.dispatch(pluginabi.MethodPluginReconfigure, data); err == nil {
		t.Fatal("shutdown resumed")
	}
}

func TestMissingFallbackFailsClosed(t *testing.T) {
	router := configured(t, func(method string, data []byte) ([]byte, error) { return catalogBytes("classifier", "coder"), nil })
	if router.route(request("test"), "scope").Handled {
		t.Fatal("missing fallback must not route to arbitrary model")
	}
	input := request("test")
	input.AvailableProviders = nil
	if decision(router.config.Fallback, input.AvailableProviders, "fallback").Handled {
		t.Fatal("missing provider routed")
	}
}

func TestFallbackRechecksCatalog(t *testing.T) {
	for _, mode := range []string{"initial-error", "recheck-error", "removed", "removed-selection", "timeout-removed", "panic-removed"} {
		t.Run(mode, func(t *testing.T) {
			blocked := make(chan struct{})
			defer close(blocked)
			var catalogs atomic.Int32
			router := configured(t, func(method string, data []byte) ([]byte, error) {
				if method == pluginabi.MethodHostAuthModels {
					count := catalogs.Add(1)
					if mode == "initial-error" || (mode == "recheck-error" && count > 1) {
						return nil, errors.New("catalog unavailable")
					}
					if count > 1 {
						return catalogBytes("classifier"), nil
					}
					return catalogBytes("classifier", "general", "coder"), nil
				}
				switch mode {
				case "timeout-removed":
					<-blocked
				case "panic-removed":
					panic("classifier failed")
				case "removed-selection":
					return completion("1"), nil
				}
				return completion("0"), nil
			})
			if result := router.route(request("test"), "scope"); result.Handled {
				t.Fatalf("unverified fallback routed: %+v", result)
			}
		})
	}
}

func TestMissingFallbackWithBlockedCatalogAndSaturation(t *testing.T) {
	blocked := make(chan struct{})
	defer close(blocked)
	var calls atomic.Int32
	router := configured(t, func(method string, data []byte) ([]byte, error) {
		calls.Add(1)
		<-blocked
		return catalogBytes("classifier", "coder"), nil
	})
	for index := 0; index < 10; index++ {
		started := time.Now()
		if result := router.route(request("test"), "scope"); result.Handled {
			t.Fatalf("missing fallback routed on timeout or saturation: %+v", result)
		}
		if time.Since(started) > time.Second {
			t.Fatal("route exceeded bounded timeout")
		}
	}
	if calls.Load() != 8 {
		t.Fatalf("expected eight outstanding catalog calls, got %d", calls.Load())
	}
}
