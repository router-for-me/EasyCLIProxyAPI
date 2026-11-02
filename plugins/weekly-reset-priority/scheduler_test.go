package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

var testNow = time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)

func usage(stamp string, duration int, used string) []byte {
	return []byte(fmt.Sprintf(`{"rate_limit":{"allowed":true,"primary_window":{"limit_window_seconds":18000,"used_percent":10},"secondary_window":{"limit_window_seconds":%d,"used_percent":%s,"reset_at":%s}}}`, duration, used, stamp))
}

func TestParseWeeklyQuota(t *testing.T) {
	future := testNow.Add(time.Hour)
	for _, test := range []struct {
		name, stamp, used string
		duration          int
		valid             bool
	}{
		{"seconds", fmt.Sprint(future.Unix()), "20", 604800, true},
		{"milliseconds", fmt.Sprint(future.UnixMilli()), "20", 604800, true},
		{"numeric string", fmt.Sprintf(`"%d"`, future.Unix()), "20", 604800, true},
		{"ISO", fmt.Sprintf(`%q`, future.Format(time.RFC3339)), "0", 604800, true},
		{"missing remaining", fmt.Sprint(future.Unix()), "null", 604800, false},
		{"zero remaining", fmt.Sprint(future.Unix()), "100", 604800, false},
		{"malformed", `"tomorrow"`, "20", 604800, false},
		{"past", fmt.Sprint(testNow.Add(-time.Hour).Unix()), "20", 604800, false},
		{"reset now", fmt.Sprint(testNow.Unix()), "20", 604800, false},
		{"daily", fmt.Sprint(future.Unix()), "20", 86400, false},
		{"five hour", fmt.Sprint(future.Unix()), "20", 18000, false},
		{"far future", fmt.Sprint(testNow.Add(30 * 24 * time.Hour).Unix()), "20", 604800, false},
		{"invalid percent", fmt.Sprint(future.Unix()), "-1", 604800, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := parseQuota(usage(test.stamp, test.duration, test.used), testNow)
			if result.Valid != test.valid {
				t.Fatalf("valid=%v want %v", result.Valid, test.valid)
			}
			if result.Valid && !result.Reset.Equal(future) {
				t.Fatalf("reset=%s", result.Reset)
			}
		})
	}
	for _, raw := range []string{`{}`, `broken`, `{"expires_at":1793700000}`, `{"seven_day":{"resets_at":"2026-11-03T12:00:00Z"}}`, `{"rate_limit":{"limit_reached":true}}`} {
		if parseQuota([]byte(raw), testNow).Valid {
			t.Fatalf("accepted %s", raw)
		}
	}
	shortExhausted := []byte(fmt.Sprintf(`{"rate_limit":{"primary_window":{"limit_window_seconds":18000,"used_percent":100},"secondary_window":{"limit_window_seconds":604800,"used_percent":20,"reset_at":%d}}}`, future.Unix()))
	if parseQuota(shortExhausted, testNow).Valid {
		t.Fatal("exhausted short window promoted")
	}
}

func testEngine(t *testing.T) *engine {
	t.Helper()
	cfg, _ := parseConfig(nil)
	worker := newEngine(cfg, nil)
	worker.now = func() time.Time { return testNow }
	t.Cleanup(worker.stop)
	for index, id := range []string{"a", "b"} {
		worker.cache[id] = cacheEntry{quota{testNow.Add(time.Duration(index+1) * time.Hour), testNow, true}, testNow}
	}
	return worker
}

func request() pluginapi.SchedulerPickRequest {
	return pluginapi.SchedulerPickRequest{Provider: "codex", Model: "gpt-5", Candidates: []pluginapi.SchedulerAuthCandidate{
		{ID: "b", Provider: "codex", Status: "active"}, {ID: "a", Provider: "codex", Status: "active"},
	}}
}

func TestPickNearestAndPriority(t *testing.T) {
	worker := testEngine(t)
	req := request()
	if got := worker.pick(req); !got.Handled || got.AuthID != "a" {
		t.Fatal(got)
	}
	req.Candidates[0].Priority = 10
	if got := worker.pick(req); got.AuthID != "b" {
		t.Fatal("manual priority lost", got)
	}
	worker.cache["b"] = cacheEntry{}
	if got := worker.pick(req); got.Handled {
		t.Fatal("lower priority chosen on missing higher data", got)
	}
}

func TestTiesStableFairAndIsolated(t *testing.T) {
	worker := testEngine(t)
	worker.cache["b"] = worker.cache["a"]
	req := request()
	for _, want := range []string{"a", "b", "a", "b"} {
		if got := worker.pick(req); got.AuthID != want {
			t.Fatalf("got %s want %s", got.AuthID, want)
		}
	}
	worker.pick(req)
	worker.cache["c"] = cacheEntry{quota{testNow.Add(3 * time.Hour), testNow, true}, testNow}
	expanded := req
	expanded.Candidates = append(append([]pluginapi.SchedulerAuthCandidate{}, req.Candidates...), pluginapi.SchedulerAuthCandidate{ID: "c", Provider: "codex", Status: "active"})
	if got := worker.pick(expanded); got.AuthID != "a" {
		t.Fatal("candidate set turn leaked", got)
	}
	req.Model = "other-model"
	if got := worker.pick(req); got.AuthID != "a" {
		t.Fatal("model turn leaked", got)
	}
	req.Stream = true
	if got := worker.pick(req); got.AuthID != "a" {
		t.Fatal("stream turn leaked", got)
	}
	req.Provider = "claude"
	req.Providers = nil
	if worker.pick(req).Handled {
		t.Fatal("provider isolation failed")
	}
	req = request()
	req.Candidates = req.Candidates[:1]
	if got := worker.pick(req); got.AuthID != "b" {
		t.Fatal("selected absent ID", got)
	}
}

func TestFallbacks(t *testing.T) {
	for _, kind := range []string{"missing", "stale", "past", "future observation", "disabled", "unavailable", "other provider", "disabled config", "empty scope"} {
		t.Run(kind, func(t *testing.T) {
			worker := testEngine(t)
			req := request()
			entry := worker.cache["a"]
			switch kind {
			case "missing":
				entry.Valid = false
			case "stale":
				entry.Observed = testNow.Add(-4 * time.Minute)
			case "past":
				entry.Reset = testNow.Add(-time.Second)
			case "future observation":
				entry.Observed = testNow.Add(time.Second)
			case "disabled", "unavailable":
				req.Candidates[1].Status = kind
			case "other provider":
				req.Candidates[1].Provider = "claude"
			case "disabled config":
				worker.cfg.Enabled = false
			case "empty scope":
				worker.cfg.Providers = nil
			}
			worker.cache["a"] = entry
			if worker.pick(req).Handled {
				t.Fatal("must delegate")
			}
		})
	}
}

func TestConfigValidation(t *testing.T) {
	for _, raw := range []string{"providers: [claude]", "refresh_seconds: 0", "refresh_seconds: 181", "freshness_seconds: 7201", "timeout_seconds: 31", "unknown: true", "refresh_seconds: 1.5", "enabled: null", "enabled: 'true'", "providers: null", "providers: [1]", "enabled: true\n---\nenabled: false"} {
		if _, err := parseConfig([]byte(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	if _, err := parseConfig([]byte("enabled: true\npriority: 2\nproviders: [codex]\n")); err != nil {
		t.Fatal(err)
	}
}

func TestConcurrentPicksAndDisable(t *testing.T) {
	worker := testEngine(t)
	var group sync.WaitGroup
	for count := 0; count < 32; count++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for turn := 0; turn < 100; turn++ {
				worker.pick(request())
			}
		}()
	}
	worker.cancel()
	group.Wait()
	if worker.pick(request()).Handled {
		t.Fatal("disabled engine selected")
	}
}

func TestFetchUsesHostInterfacesAndCancels(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{})
	canceled := make(chan struct{})
	call := func(method string, req any, out any) error {
		var value any
		switch method {
		case pluginabi.MethodHostAuthList:
			value = map[string]any{"files": []pluginapi.HostAuthFileEntry{{ID: "a", Provider: "codex", AuthIndex: "idx"}}}
		case pluginabi.MethodHostAuthGet:
			value = pluginapi.HostAuthGetResponse{JSON: json.RawMessage(`{"access_token":"test-only","account_id":"test-account"}`)}
		case pluginabi.MethodHostHTTPOperationOpen:
			value = map[string]string{"operation_id": "operation"}
		case pluginabi.MethodHostHTTPDo:
			if req.(map[string]any)["url"] != quotaURL {
				t.Error("unexpected quota service")
			}
			close(started)
			<-canceled
			return context.Canceled
		case pluginabi.MethodHostHTTPCancel:
			close(canceled)
			return nil
		default:
			t.Errorf("unexpected callback %s", method)
		}
		raw, _ := json.Marshal(value)
		return json.Unmarshal(raw, out)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		if fetchQuota(ctx, call, "a", testNow).Valid {
			t.Error("canceled fetch valid")
		}
	}()
	<-started
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("HTTP cancellation hung")
	}
}

func TestCacheCapacityRefreshAndInsert(t *testing.T) {
	for _, id := range []string{"account-0", "new-account"} {
		t.Run(id, func(t *testing.T) {
			cfg, _ := parseConfig(nil)
			worker := newEngine(cfg, nil)
			t.Cleanup(worker.stop)
			worker.mu.Lock()
			for index := 0; index < 1024; index++ {
				worker.cache[fmt.Sprintf("account-%d", index)] = cacheEntry{}
			}
			worker.mu.Unlock()
			for attempt := 0; attempt < 3; attempt++ {
				worker.mu.Lock()
				worker.pending[id] = true
				worker.queue <- id
				worker.mu.Unlock()
				deadline := time.Now().Add(time.Second)
				for {
					worker.mu.Lock()
					pending := worker.pending[id]
					count := len(worker.cache)
					_, exists := worker.cache[id]
					worker.mu.Unlock()
					if !pending {
						if count != 1024 || !exists {
							t.Fatalf("cache size=%d refreshed account present=%v", count, exists)
						}
						break
					}
					if time.Now().After(deadline) {
						t.Fatal("background refresh did not finish")
					}
					time.Sleep(time.Millisecond)
				}
			}
		})
	}
}

func TestBackgroundRefreshAndFailure(t *testing.T) {
	var calls atomic.Int32
	var fail atomic.Bool
	call := func(method string, req any, out any) error {
		var value any
		switch method {
		case pluginabi.MethodHostAuthList:
			value = map[string]any{"files": []pluginapi.HostAuthFileEntry{{ID: "a", Provider: "codex", AuthIndex: "idx"}}}
		case pluginabi.MethodHostAuthGet:
			value = pluginapi.HostAuthGetResponse{JSON: json.RawMessage(`{"access_token":"test-only"}`)}
		case pluginabi.MethodHostHTTPOperationOpen:
			value = map[string]string{"operation_id": "operation"}
		case pluginabi.MethodHostHTTPDo:
			calls.Add(1)
			status := 200
			if fail.Load() {
				status = 503
			}
			value = pluginapi.HTTPResponse{StatusCode: status, Body: usage(fmt.Sprint(testNow.Add(time.Hour).Unix()), 604800, "10")}
		default:
			return fmt.Errorf("unexpected callback %s", method)
		}
		raw, _ := json.Marshal(value)
		return json.Unmarshal(raw, out)
	}
	cfg, _ := parseConfig(nil)
	worker := newEngine(cfg, call)
	worker.now = func() time.Time { return testNow }
	t.Cleanup(worker.stop)
	req := request()
	req.Candidates = req.Candidates[1:]
	if worker.pick(req).Handled {
		t.Fatal("cold cache must delegate without waiting for quota")
	}
	waitRefresh := func() {
		t.Helper()
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) {
			worker.mu.Lock()
			pending := worker.pending["a"]
			worker.mu.Unlock()
			if !pending {
				return
			}
			time.Sleep(time.Millisecond)
		}
		t.Fatal("background refresh did not finish")
	}
	waitRefresh()
	for count := 0; count < 100; count++ {
		if got := worker.pick(req); got.AuthID != "a" {
			t.Fatal("fresh host quota not used", got)
		}
	}
	if calls.Load() != 1 {
		t.Fatal("refresh interval did not bound callback requests", calls.Load())
	}
	fail.Store(true)
	worker.mu.Lock()
	entry := worker.cache["a"]
	entry.Attempt = testNow.Add(-time.Minute)
	worker.cache["a"] = entry
	worker.mu.Unlock()
	worker.pick(req)
	waitRefresh()
	if worker.pick(req).Handled || calls.Load() != 2 {
		t.Fatal("failed refresh must invalidate old quota and remain rate limited")
	}
}

func TestLifecycleAndInvalidReconfigure(t *testing.T) {
	defer shutdown()
	if _, err := dispatch(pluginabi.MethodPluginRegister, []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	previous := runtimeState.worker
	raw, _ := json.Marshal(map[string]any{"config_yaml": []byte("refresh_seconds: 0")})
	if _, err := dispatch(pluginabi.MethodPluginReconfigure, raw); err == nil {
		t.Fatal("invalid reconfigure accepted")
	}
	if runtimeState.worker != previous || previous.ctx.Err() != nil {
		t.Fatal("invalid reconfigure replaced the active worker")
	}
	raw, _ = json.Marshal(map[string]any{"config_yaml": []byte("enabled: false")})
	if _, err := dispatch(pluginabi.MethodPluginReconfigure, raw); err != nil {
		t.Fatal(err)
	}
	if previous.ctx.Err() == nil || runtimeState.worker.pick(request()).Handled {
		t.Fatal("disable did not stop old worker and restore ordinary scheduling")
	}
	if _, err := dispatch(pluginabi.MethodPluginQuiesce, nil); err != nil {
		t.Fatal(err)
	}
	result, err := dispatch(pluginabi.MethodSchedulerPick, []byte(`{}`))
	if err != nil || result.(pluginapi.SchedulerPickResponse).Handled || runtimeState.worker != nil {
		t.Fatal("quiesced plugin must delegate", result, err)
	}
}
