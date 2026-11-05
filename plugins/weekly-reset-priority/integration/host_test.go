package integration

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

const testModel = "gpt-5.6-terra"

func TestActualCoreABI(t *testing.T) {
	core, library := os.Getenv("WEEKLY_CORE"), os.Getenv("WEEKLY_PLUGIN")
	if core == "" || library == "" {
		t.Skip("run ../test-host.sh to build and load the actual core ABI")
	}
	root := t.TempDir()
	t.Cleanup(func() {
		if destination := os.Getenv("WEEKLY_LOG_DIR"); destination != "" {
			entries, _ := filepath.Glob(filepath.Join(root, "core-*.log"))
			for _, path := range entries {
				raw, err := os.ReadFile(path)
				if err == nil {
					mustWrite(t, filepath.Join(destination, filepath.Base(path)), raw)
				}
			}
		}
	})
	var mu sync.Mutex
	resets := map[string]int64{"a": 7200, "b": 3600}
	missing := false
	quotaCalls := map[string]int{}
	blocked := map[string]int{}
	selected := make(chan string, 256)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "chatgpt.com"}, DNSNames: []string{"chatgpt.com"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	cert, err := tls.X509KeyPair(certPEM, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}))
	if err != nil {
		t.Fatal(err)
	}
	certPath := filepath.Join(root, "ca.pem")
	mustWrite(t, certPath, certPEM)
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(writer http.ResponseWriter, req *http.Request) {
		id := strings.TrimPrefix(req.Header.Get("Authorization"), "Bearer token-")
		if id != "a" && id != "b" {
			http.Error(writer, "unexpected test credential", 401)
			return
		}
		if req.URL.Path == "/backend-api/wham/usage" {
			mu.Lock()
			quotaCalls[id]++
			offset, noQuota := resets[id], missing
			mu.Unlock()
			if noQuota {
				http.Error(writer, "quota unavailable", 503)
				return
			}
			writer.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(writer, `{"rate_limit":{"allowed":true,"primary_window":{"limit_window_seconds":18000,"used_percent":10},"secondary_window":{"limit_window_seconds":604800,"used_percent":20,"reset_at":%d}}}`, time.Now().Unix()+offset)
			return
		}
		if strings.HasSuffix(req.URL.Path, "/responses") {
			selected <- id
			writer.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprintf(writer, "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_test\",\"object\":\"response\",\"status\":\"completed\",\"model\":%q,\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1,\"total_tokens\":2}}}\n\n", testModel)
			return
		}
		http.Error(writer, "unexpected upstream path", 404)
	}))
	upstream.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	upstream.StartTLS()
	defer upstream.Close()
	var tunnelMu sync.Mutex
	var tunnels []net.Conn
	proxy := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, req *http.Request) {
		if req.Method != "CONNECT" || req.Host != "chatgpt.com:443" {
			mu.Lock()
			blocked[req.Host]++
			mu.Unlock()
			http.Error(writer, "external network blocked", 502)
			return
		}
		remote, err := net.DialTimeout("tcp", upstream.Listener.Addr().String(), time.Second)
		if err != nil {
			http.Error(writer, "mock unavailable", 502)
			return
		}
		local, buffer, err := writer.(http.Hijacker).Hijack()
		if err != nil {
			_ = remote.Close()
			return
		}
		tunnelMu.Lock()
		tunnels = append(tunnels, local, remote)
		tunnelMu.Unlock()
		_, _ = buffer.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = buffer.Flush()
		go func() { _, _ = io.Copy(remote, local); _ = remote.Close() }()
		go func() { _, _ = io.Copy(local, remote); _ = local.Close() }()
	}))
	defer proxy.Close()
	defer func() {
		tunnelMu.Lock()
		defer tunnelMu.Unlock()
		for _, connection := range tunnels {
			_ = connection.Close()
		}
	}()
	pluginDir := filepath.Join(root, "plugins", runtime.GOOS, runtime.GOARCH)
	if err := os.MkdirAll(pluginDir, 0700); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(library)
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(pluginDir, filepath.Base(library)), raw)
	authDir := filepath.Join(root, "auths")
	if err := os.Mkdir(authDir, 0700); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b"} {
		mustWrite(t, filepath.Join(authDir, id+".json"), []byte(fmt.Sprintf(`{"type":"codex","access_token":"token-%s","account_id":"%s","expired":"2099-01-01T00:00:00Z","plan_type":"pro"}`, id, id)))
	}
	start := func(enabled bool) (string, func()) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := listener.Addr().(*net.TCPAddr).Port
		_ = listener.Close()
		config := fmt.Sprintf("host: 127.0.0.1\nport: %d\nauth-dir: %q\napi-keys: [test-key]\nproxy-url: %q\nrequest-retry: 0\nrouting:\n  strategy: fill-first\nremote-management:\n  disable-control-panel: true\nplugins:\n  enabled: true\n  dir: %q\n  configs:\n    weekly-reset-priority:\n      enabled: %t\n      priority: 0\n      providers: [codex]\n      refresh_seconds: 1\n      freshness_seconds: 2\n      timeout_seconds: 2\n", port, authDir, proxy.URL, filepath.Join(root, "plugins"), enabled)
		configPath := filepath.Join(root, "config.yaml")
		mustWrite(t, configPath, []byte(config))
		logPath := filepath.Join(root, fmt.Sprintf("core-%t.log", enabled))
		log, err := os.Create(logPath)
		if err != nil {
			t.Fatal(err)
		}
		command := exec.Command(core, "-config", configPath, "-local-model")
		command.Dir = root
		command.Env = []string{"PATH=" + os.Getenv("PATH"), "HOME=" + root, "XDG_CONFIG_HOME=" + root, "SSL_CERT_FILE=" + certPath,
			"HTTP_PROXY=" + proxy.URL, "HTTPS_PROXY=" + proxy.URL, "ALL_PROXY=" + proxy.URL,
			"http_proxy=" + proxy.URL, "https_proxy=" + proxy.URL, "all_proxy=" + proxy.URL,
			"NO_PROXY=127.0.0.1,localhost", "no_proxy=127.0.0.1,localhost"}
		command.Stdout = log
		command.Stderr = log
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		stopped := make(chan error, 1)
		go func() { stopped <- command.Wait() }()
		var once sync.Once
		stop := func() {
			once.Do(func() {
				_ = command.Process.Signal(os.Interrupt)
				select {
				case <-stopped:
				case <-time.After(8 * time.Second):
					_ = command.Process.Kill()
					<-stopped
				}
				_ = log.Close()
			})
		}
		t.Cleanup(stop)
		base := fmt.Sprintf("http://127.0.0.1:%d", port)
		client := &http.Client{Timeout: time.Second}
		deadline := time.Now().Add(45 * time.Second)
		for time.Now().Before(deadline) {
			req, _ := http.NewRequest("GET", base+"/v1/models", nil)
			req.Header.Set("Authorization", "Bearer test-key")
			response, err := client.Do(req)
			if err == nil {
				var catalog struct {
					Data []struct {
						ID string `json:"id"`
					} `json:"data"`
				}
				decodeErr := json.NewDecoder(response.Body).Decode(&catalog)
				_ = response.Body.Close()
				if response.StatusCode == 200 && decodeErr == nil {
					for _, model := range catalog.Data {
						if model.ID == testModel {
							return base, stop
						}
					}
				}
			}
			time.Sleep(100 * time.Millisecond)
		}
		stop()
		logs, _ := os.ReadFile(logPath)
		t.Fatalf("core did not start:\n%s", logs)
		return "", stop
	}
	call := func(base string) string {
		for len(selected) > 0 {
			<-selected
		}
		req, _ := http.NewRequest("POST", base+"/v1/responses", bytes.NewBufferString(fmt.Sprintf(`{"model":%q,"input":"test","stream":false}`, testModel)))
		req.Header.Set("Authorization", "Bearer test-key")
		req.Header.Set("Content-Type", "application/json")
		response, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if response.StatusCode != 200 {
			logs, _ := os.ReadFile(filepath.Join(root, "core-true.log"))
			t.Fatalf("request status %d: %s\n%s", response.StatusCode, body, logs)
		}
		select {
		case id := <-selected:
			return id
		case <-time.After(time.Second):
			t.Fatal("no real upstream request")
			return ""
		}
	}
	base, stop := start(true)
	expect := func(id, phase string) {
		deadline := time.Now().Add(12 * time.Second)
		consecutive := 0
		for time.Now().Before(deadline) {
			if got := call(base); got == id {
				consecutive++
				if consecutive == 3 {
					t.Logf("%s: selected account %s.json on three consecutive requests", phase, id)
					return
				}
			} else {
				consecutive = 0
			}
			time.Sleep(200 * time.Millisecond)
		}
		logs, _ := os.ReadFile(filepath.Join(root, "core-true.log"))
		t.Fatalf("%s: never selected %s\n%s", phase, id, logs)
	}
	expect("b", "weekly b sooner")
	mu.Lock()
	resets["a"] = 1800
	mu.Unlock()
	expect("a", "weekly a sooner")
	mu.Lock()
	resets["a"] = 7200
	mu.Unlock()
	expect("b", "weekly b sooner again")
	mu.Lock()
	missing = true
	mu.Unlock()
	expect("a", "missing quota restores fill-first")
	stop()
	mu.Lock()
	beforeDisabled := quotaCalls["a"] + quotaCalls["b"]
	if quotaCalls["a"] == 0 || quotaCalls["b"] == 0 {
		t.Error("both fixture accounts must be queried through real host quota callbacks")
	}
	mu.Unlock()
	base, stop = start(false)
	defer stop()
	for count := 0; count < 3; count++ {
		if got := call(base); got != "a" {
			t.Fatalf("disabled plugin selected %s instead of ordinary a", got)
		}
	}
	t.Log("disabled plugin: ordinary fill-first selects a.json")
	stop()
	mu.Lock()
	defer mu.Unlock()
	if after := quotaCalls["a"] + quotaCalls["b"]; after != beforeDisabled {
		t.Errorf("disabled plugin queried quota: before=%d after=%d", beforeDisabled, after)
	}
	t.Logf("local quota calls: %v; incidental external requests denied locally: %v", quotaCalls, blocked)
}

func mustWrite(t *testing.T, path string, raw []byte) {
	t.Helper()
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestManifest(t *testing.T) {
	raw, err := os.ReadFile("../manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		ID     string `json:"id"`
		SDK    string `json:"sdk_version"`
		Across bool   `json:"scheduler_across_priorities"`
	}
	if json.Unmarshal(raw, &manifest) != nil || manifest.ID != "weekly-reset-priority" || manifest.SDK != "v8.0.48" || manifest.Across {
		t.Fatal("invalid distribution manifest")
	}
}
