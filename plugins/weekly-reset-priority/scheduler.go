package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"gopkg.in/yaml.v3"
)

type config struct {
	Enabled          bool     `yaml:"enabled"`
	Priority         int      `yaml:"priority"`
	Providers        []string `yaml:"providers"`
	RefreshSeconds   int      `yaml:"refresh_seconds"`
	FreshnessSeconds int      `yaml:"freshness_seconds"`
	TimeoutSeconds   int      `yaml:"timeout_seconds"`
}

func parseConfig(raw []byte) (config, error) {
	cfg := config{Enabled: true, Providers: []string{"codex"}, RefreshSeconds: 60, FreshnessSeconds: 180, TimeoutSeconds: 10}
	decoder := yaml.NewDecoder(bytes.NewReader(raw))
	decoder.KnownFields(true)
	if len(raw) > 0 {
		var document yaml.Node
		if err := yaml.Unmarshal(raw, &document); err != nil {
			return cfg, err
		}
		if len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
			return cfg, errors.New("config must be a mapping")
		}
		fields := document.Content[0].Content
		for index := 0; index < len(fields); index += 2 {
			name, value := fields[index].Value, fields[index+1]
			if name == "enabled" && value.Tag != "!!bool" {
				return cfg, errors.New("boolean enabled value required")
			}
			if name == "providers" {
				if value.Kind != yaml.SequenceNode {
					return cfg, errors.New("providers must be an array")
				}
				for _, provider := range value.Content {
					if provider.Tag != "!!str" {
						return cfg, errors.New("provider names must be strings")
					}
				}
			}
			if (name == "priority" || name == "refresh_seconds" || name == "freshness_seconds" || name == "timeout_seconds") && value.Tag != "!!int" {
				return cfg, errors.New("integer configuration value required")
			}
		}
		if err := decoder.Decode(&cfg); err != nil {
			return cfg, err
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF {
			return cfg, errors.New("config must contain exactly one document")
		}
	}
	if cfg.RefreshSeconds < 1 || cfg.RefreshSeconds > 3600 || cfg.FreshnessSeconds < cfg.RefreshSeconds || cfg.FreshnessSeconds > 7200 || cfg.TimeoutSeconds < 1 || cfg.TimeoutSeconds > 30 {
		return cfg, errors.New("invalid refresh/freshness/timeout bounds")
	}
	for _, provider := range cfg.Providers {
		if provider != "codex" {
			return cfg, errors.New("only codex quota is supported")
		}
	}
	return cfg, nil
}

type quota struct {
	Reset    time.Time
	Observed time.Time
	Valid    bool
}
type cacheEntry struct {
	quota
	Attempt time.Time
}
type hostCall func(string, any, any) error
type engine struct {
	mu      sync.Mutex
	cfg     config
	cache   map[string]cacheEntry
	pending map[string]bool
	turns   map[string]uint64
	queue   chan string
	ctx     context.Context
	cancel  context.CancelFunc
	done    chan struct{}
	call    hostCall
	now     func() time.Time
}

func newEngine(cfg config, call hostCall) *engine {
	ctx, cancel := context.WithCancel(context.Background())
	worker := &engine{cfg: cfg, cache: map[string]cacheEntry{}, pending: map[string]bool{}, turns: map[string]uint64{}, queue: make(chan string, 256), ctx: ctx, cancel: cancel, done: make(chan struct{}), call: call, now: time.Now}
	go worker.run()
	return worker
}

func (worker *engine) stop() { worker.cancel(); <-worker.done }

func (worker *engine) run() {
	defer close(worker.done)
	for {
		select {
		case <-worker.ctx.Done():
			return
		case id := <-worker.queue:
			if worker.ctx.Err() != nil {
				return
			}
			ctx, cancel := context.WithTimeout(worker.ctx, time.Duration(worker.cfg.TimeoutSeconds)*time.Second)
			result := fetchQuota(ctx, worker.call, id, worker.now())
			cancel()
			worker.mu.Lock()
			if _, exists := worker.cache[id]; !exists && len(worker.cache) >= 1024 {
				for key := range worker.cache {
					delete(worker.cache, key)
					break
				}
			}
			worker.cache[id] = cacheEntry{result, worker.now()}
			delete(worker.pending, id)
			worker.mu.Unlock()
		}
	}
}

func (worker *engine) pick(req pluginapi.SchedulerPickRequest) pluginapi.SchedulerPickResponse {
	worker.mu.Lock()
	defer worker.mu.Unlock()
	fallback := pluginapi.SchedulerPickResponse{}
	if worker.ctx.Err() != nil || !worker.cfg.Enabled || len(worker.cfg.Providers) == 0 || len(req.Candidates) == 0 {
		return fallback
	}
	now := worker.now()
	priority := req.Candidates[0].Priority
	for _, candidate := range req.Candidates {
		if candidate.Priority > priority {
			priority = candidate.Priority
		}
	}
	var ids []string
	var candidateIDs []string
	var earliest time.Time
	missing := false
	for _, candidate := range req.Candidates {
		if candidate.Priority != priority {
			continue
		}
		if candidate.Provider != "codex" || (req.Provider != "codex" && !contains(req.Providers, "codex")) {
			return fallback
		}
		if candidate.ID == "" || (candidate.Status != "" && candidate.Status != "active") {
			return fallback
		}
		if !contains(candidateIDs, candidate.ID) {
			candidateIDs = append(candidateIDs, candidate.ID)
		}
		entry := worker.cache[candidate.ID]
		if now.Sub(entry.Attempt) >= time.Duration(worker.cfg.RefreshSeconds)*time.Second && !worker.pending[candidate.ID] {
			select {
			case worker.queue <- candidate.ID:
				worker.pending[candidate.ID] = true
			default:
			}
		}
		if !entry.Valid || !entry.Reset.After(now) || now.Before(entry.Observed) || now.Sub(entry.Observed) > time.Duration(worker.cfg.FreshnessSeconds)*time.Second {
			missing = true
			continue
		}
		if earliest.IsZero() || entry.Reset.Before(earliest) {
			earliest = entry.Reset
			ids = []string{candidate.ID}
		} else if entry.Reset.Equal(earliest) && !contains(ids, candidate.ID) {
			ids = append(ids, candidate.ID)
		}
	}
	if missing || len(ids) == 0 {
		return fallback
	}
	sort.Strings(ids)
	sort.Strings(candidateIDs)
	key := req.Provider + "\x00" + req.Model + "\x00" + strconv.FormatBool(req.Stream) + "\x00" + strings.Join(candidateIDs, "\x00")
	if len(worker.turns) >= 1024 {
		clear(worker.turns)
	}
	index := worker.turns[key] % uint64(len(ids))
	worker.turns[key]++
	return pluginapi.SchedulerPickResponse{AuthID: ids[index], Handled: true}
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func resetTime(value json.RawMessage) time.Time {
	var text string
	if json.Unmarshal(value, &text) == nil {
		if stamp, err := time.Parse(time.RFC3339Nano, text); err == nil {
			return stamp
		}
	} else {
		text = string(value)
	}
	number, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
		return time.Time{}
	}
	if number >= 1e12 {
		number /= 1000
	}
	if number < 1e9 || number > 1e11 {
		return time.Time{}
	}
	seconds, fraction := math.Modf(number)
	return time.Unix(int64(seconds), int64(fraction*1e9))
}

func parseQuota(raw []byte, now time.Time) quota {
	var payload struct {
		RateLimit struct {
			Allowed   *bool           `json:"allowed"`
			Reached   bool            `json:"limit_reached"`
			Primary   json.RawMessage `json:"primary_window"`
			Secondary json.RawMessage `json:"secondary_window"`
		} `json:"rate_limit"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.RateLimit.Reached || (payload.RateLimit.Allowed != nil && !*payload.RateLimit.Allowed) {
		return quota{}
	}
	var result quota
	for _, rawWindow := range []json.RawMessage{payload.RateLimit.Primary, payload.RateLimit.Secondary} {
		var window struct {
			Duration int             `json:"limit_window_seconds"`
			Used     *float64        `json:"used_percent"`
			Reset    json.RawMessage `json:"reset_at"`
		}
		if json.Unmarshal(rawWindow, &window) != nil {
			continue
		}
		if window.Used != nil && (*window.Used < 0 || *window.Used >= 100 || math.IsNaN(*window.Used)) {
			return quota{}
		}
		if window.Duration != 604800 {
			continue
		}
		stamp := resetTime(window.Reset)
		if window.Used == nil || !stamp.After(now) || stamp.After(now.Add(7*24*time.Hour+5*time.Minute)) {
			return quota{}
		}
		result = quota{stamp, now, true}
	}
	return result
}
