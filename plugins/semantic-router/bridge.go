package main

/*
#include <stdint.h>
#include <stdlib.h>
typedef struct { void *ptr; size_t len; } buffer;
typedef int (*host_call)(void*, const char*, const uint8_t*, size_t, buffer*);
typedef void (*free_call)(void*, size_t);
typedef struct { uint32_t abi_version; void *host_ctx; host_call call; free_call free_buffer; } host_api;
typedef int (*plugin_call)(char*, uint8_t*, size_t, buffer*);
typedef void (*shutdown_call)(void);
typedef struct { uint32_t abi_version; plugin_call call; free_call free_buffer; shutdown_call shutdown; } plugin_api;
extern int routeCall(char*, uint8_t*, size_t, buffer*);
extern void routeFree(void*, size_t);
extern void routeShutdown(void);
static host_api host;
static void initialize(host_api *api, plugin_api *plugin) {
    host = *api;
    plugin->abi_version = 1;
    plugin->call = routeCall;
    plugin->free_buffer = routeFree;
    plugin->shutdown = routeShutdown;
}
static int invoke(char *method, uint8_t *data, size_t length, buffer *result) {
    return host.call(host.host_ctx, method, data, length, result);
}
static void release(buffer result) { if (result.ptr) host.free_buffer(result.ptr, result.len); }
*/
import "C"

import (
	"encoding/json"
	"errors"
	"unsafe"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginabi"
)

const maxBuffer = 16 << 20

var service = newRouter(invokeHost)

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.host_api, plugin *C.plugin_api) C.int {
	if host == nil || plugin == nil || host.abi_version != 1 || host.call == nil || host.free_buffer == nil {
		return 1
	}
	C.initialize(host, plugin)
	return 0
}

//export routeCall
func routeCall(method *C.char, data *C.uint8_t, length C.size_t, result *C.buffer) (code C.int) {
	if result == nil {
		return 1
	}
	result.ptr, result.len = nil, 0
	defer func() {
		if recover() != nil {
			code = 1
			writeBuffer(result, []byte(`{"ok":false,"error":{"code":"internal","message":"plugin failure"}}`))
		}
	}()
	if method == nil || length > maxBuffer || (length > 0 && data == nil) {
		return 1
	}
	value, err := service.dispatch(C.GoString(method), C.GoBytes(unsafe.Pointer(data), C.int(length)))
	var encoded []byte
	if err != nil {
		encoded, _ = pluginabi.NewErrorEnvelope("semantic_router", err.Error())
		code = 1
	} else {
		payload, marshalErr := json.Marshal(value)
		if marshalErr != nil {
			return 1
		}
		encoded, _ = json.Marshal(pluginabi.Envelope{OK: true, Result: payload})
	}
	writeBuffer(result, encoded)
	return code
}

func writeBuffer(result *C.buffer, data []byte) {
	result.ptr, result.len = C.CBytes(data), C.size_t(len(data))
}

//export routeFree
func routeFree(pointer unsafe.Pointer, length C.size_t) { C.free(pointer) }

//export routeShutdown
func routeShutdown() { service.stop() }

func invokeHost(method string, payload []byte) ([]byte, error) {
	name := C.CString(method)
	defer C.free(unsafe.Pointer(name))
	data := C.CBytes(payload)
	defer C.free(data)
	var result C.buffer
	code := C.invoke(name, (*C.uint8_t)(data), C.size_t(len(payload)), &result)
	defer C.release(result)
	if result.ptr == nil || result.len > maxBuffer {
		return nil, errors.New("invalid host response")
	}
	var envelope pluginabi.Envelope
	if err := json.Unmarshal(C.GoBytes(result.ptr, C.int(result.len)), &envelope); err != nil {
		return nil, err
	}
	if code != 0 || !envelope.OK {
		return nil, errors.New("host call failed")
	}
	return envelope.Result, nil
}
