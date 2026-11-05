package main

/*
#include <stdint.h>
#include <stdlib.h>
typedef struct { void* ptr; size_t len; } cliproxy_buffer;
typedef int (*host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*host_free_fn)(void*, size_t);
typedef struct { uint32_t abi_version; void* host_ctx; host_call_fn call; host_free_fn free_buffer; } cliproxy_host_api;
typedef int (*plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*plugin_free_fn)(void*, size_t);
typedef void (*plugin_shutdown_fn)(void);
typedef struct { uint32_t abi_version; plugin_call_fn call; plugin_free_fn free_buffer; plugin_shutdown_fn shutdown; } cliproxy_plugin_api;
extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);
static cliproxy_host_api host_api;
static void set_host(cliproxy_host_api* host) { host_api = *host; }
static int host_call(char* method, void* data, size_t len, cliproxy_buffer* out) {
 if (!host_api.call) return 1;
 return host_api.call(host_api.host_ctx, method, data, len, out);
}
static void host_free(cliproxy_buffer out) { if (out.ptr && host_api.free_buffer) host_api.free_buffer(out.ptr, out.len); }
*/
import "C"

import (
	"encoding/json"
	"errors"
	"sync"
	"unsafe"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

var runtimeState struct {
	sync.RWMutex
	worker *engine
}

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, out *C.cliproxy_plugin_api) C.int {
	if host == nil || out == nil || uint32(host.abi_version) != pluginabi.ABIVersion {
		return 1
	}
	C.set_host(host)
	out.abi_version = C.uint32_t(pluginabi.ABIVersion)
	out.call = C.plugin_call_fn(C.cliproxyPluginCall)
	out.free_buffer = C.plugin_free_fn(C.cliproxyPluginFree)
	out.shutdown = C.plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, data *C.uint8_t, size C.size_t, out *C.cliproxy_buffer) C.int {
	if out == nil {
		return 1
	}
	out.ptr = nil
	out.len = 0
	if method == nil || size > 16<<20 {
		return 1
	}
	raw := C.GoBytes(unsafe.Pointer(data), C.int(size))
	result, err := dispatch(C.GoString(method), raw)
	envelope := pluginabi.Envelope{OK: err == nil}
	if err != nil {
		envelope.Error = &pluginabi.Error{Code: "weekly_reset_config", Message: err.Error()}
	} else {
		envelope.Result, _ = json.Marshal(result)
	}
	encoded, _ := json.Marshal(envelope)
	out.ptr = C.CBytes(encoded)
	out.len = C.size_t(len(encoded))
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, size C.size_t) { C.free(ptr) }

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() { shutdown() }

func shutdown() {
	runtimeState.Lock()
	defer runtimeState.Unlock()
	if runtimeState.worker != nil {
		runtimeState.worker.stop()
		runtimeState.worker = nil
	}
}

func dispatch(method string, raw []byte) (any, error) {
	switch method {
	case pluginabi.MethodPluginRegister, pluginabi.MethodPluginReconfigure:
		var request struct {
			ConfigYAML []byte `json:"config_yaml"`
		}
		if err := json.Unmarshal(raw, &request); err != nil {
			return nil, errors.New("invalid lifecycle request")
		}
		cfg, err := parseConfig(request.ConfigYAML)
		if err != nil {
			return nil, err
		}
		runtimeState.Lock()
		defer runtimeState.Unlock()
		if runtimeState.worker != nil {
			runtimeState.worker.stop()
		}
		runtimeState.worker = newEngine(cfg, callHost)
		return registration(), nil
	case pluginabi.MethodPluginQuiesce, pluginabi.MethodPluginShutdown:
		shutdown()
		return struct{}{}, nil
	case pluginabi.MethodSchedulerPick:
		var request pluginapi.SchedulerPickRequest
		if err := json.Unmarshal(raw, &request); err != nil {
			return pluginapi.SchedulerPickResponse{}, nil
		}
		runtimeState.RLock()
		defer runtimeState.RUnlock()
		if runtimeState.worker == nil {
			return pluginapi.SchedulerPickResponse{}, nil
		}
		return runtimeState.worker.pick(request), nil
	}
	return nil, errors.New("unsupported method")
}

func callHost(method string, request any, result any) error {
	raw, err := json.Marshal(request)
	if err != nil {
		return err
	}
	name := C.CString(method)
	defer C.free(unsafe.Pointer(name))
	data := C.CBytes(raw)
	defer C.free(data)
	var out C.cliproxy_buffer
	code := C.host_call(name, data, C.size_t(len(raw)), &out)
	defer C.host_free(out)
	if code != 0 || out.ptr == nil || out.len > 16<<20 {
		return errors.New("host callback unavailable")
	}
	var envelope pluginabi.Envelope
	if json.Unmarshal(C.GoBytes(out.ptr, C.int(out.len)), &envelope) != nil || !envelope.OK {
		return errors.New("host callback failed")
	}
	if result != nil {
		return json.Unmarshal(envelope.Result, result)
	}
	return nil
}

func registration() any {
	return struct {
		Schema       uint32             `json:"schema_version"`
		Metadata     pluginapi.Metadata `json:"metadata"`
		Capabilities map[string]bool    `json:"capabilities"`
	}{pluginabi.SchemaVersion, pluginapi.Metadata{
		Name: "weekly-reset-priority", Version: "0.1.0", Author: "EasyCLIProxyAPI", GitHubRepository: "https://github.com/router-for-me/EasyCLIProxyAPI",
		ConfigFields: []pluginapi.ConfigField{
			{Name: "providers", Type: pluginapi.ConfigFieldTypeArray, Default: []string{"codex"}, Description: "仅支持 codex；空数组暂停周重置调度。保留账号手动优先级。"},
			{Name: "refresh_seconds", Type: pluginapi.ConfigFieldTypeInteger, Default: 60, Description: "后台刷新间隔（1–3600 秒），有请求时触发。"},
			{Name: "freshness_seconds", Type: pluginapi.ConfigFieldTypeInteger, Default: 180, Description: "缓存最大年龄（刷新间隔至 7200 秒）。"},
			{Name: "timeout_seconds", Type: pluginapi.ConfigFieldTypeInteger, Default: 10, Description: "单次后台配额 HTTP 请求超时（1–30 秒）。"},
		},
	}, map[string]bool{"scheduler": true, "scheduler_across_priorities": false}}
}
