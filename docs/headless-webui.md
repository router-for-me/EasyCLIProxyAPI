# EasyCLIProxyAPI 无头 Linux WebUI 部署指南 (`ecpa-web`)

`ecpa-web` 是 EasyCLIProxyAPI 的独立无头 WebUI 服务端二进制，复用完整的 Rust 核心业务（`ecpa-core`）与前端管理界面，**零 GTK / WebKit / DBus 桌面依赖**，可直接部署在无桌面环境的 Linux 服务器、VPS、Docker 容器或 ARM 设备上。

---

## 1. 快速启动

从 Release 下载对应平台的 WebUI 便携包（支持 `Linux` / `Darwin` 的 `.tar.gz` 与 `Windows` 的 `.zip`，涵盖 `amd64` 与 `aarch64`）并解压：

```bash
# Linux / macOS
tar -xzf EasyCLIProxyAPI-web-v*-Linux-amd64.tar.gz
cd EasyCLIProxyAPI-web-v*-Linux-amd64
./EasyCLIProxyAPI-web
```

```powershell
# Windows (PowerShell)
.\EasyCLIProxyAPI-web.exe
```

默认监听 `http://127.0.0.1:9317`。首次启动且未指定密码时，终端会自动生成并打印一次 24 位随机访问密码，同时将其 PBKDF2-HMAC-SHA256 哈希写入数据目录下的 `webui.toml`（权限 `0600`）。

> 建议通过 SSH 端口转发（`ssh -L 9317:127.0.0.1:9317 user@server`）或前置 HTTPS 反向代理访问。

---

## 2. 启动参数与环境变量

配置优先级：`命令行参数 > 环境变量 > <data-dir>/webui.toml > 默认值`。

| 命令行参数 | 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `--host <ADDR>` | `ECPA_WEB_HOST` | `127.0.0.1` | 监听地址（如需公网/局域网访问可设为 `0.0.0.0`） |
| `--port <PORT>` | `ECPA_WEB_PORT` | `9317` | WebUI 监听端口 |
| `--data-dir <PATH>` | `ECPA_DATA_DIR` | 二进制同级目录 | 配置、CPA 内核、凭据、SQLite 统计与 `webui.toml` 存储目录 |
| `--password <PASS>` | `ECPA_WEB_PASSWORD` | 自动生成 | 初始化或重置 WebUI 登录密码（写入哈希到 `webui.toml`） |
| `--no-auth` | `ECPA_WEB_NO_AUTH=1` | `false` | 仅允许在回环地址（`127.0.0.1` / `::1`）关闭鉴权；非回环地址强制拒绝启动 |
| `--trust-proxy` | `ECPA_WEB_TRUST_PROXY=1` | `false` | 信任反代传入的 `X-Forwarded-Proto` / `X-Forwarded-Host` / `X-Forwarded-For` |
| `--tls-cert <PATH>` | `ECPA_WEB_TLS_CERT` | 空 | 内置 HTTPS PEM 证书链（需与 `--tls-key` 同时提供） |
| `--tls-key <PATH>` | `ECPA_WEB_TLS_KEY` | 空 | 内置 HTTPS PEM 私钥 |
| `--static-dir <PATH>` | `ECPA_WEB_STATIC_DIR` | 内嵌 `dist/` | 覆盖内嵌前端资源目录（用于调试或自定义前端构建） |

---

## 3. systemd 服务部署

```bash
sudo useradd --system --home-dir /var/lib/ecpa --shell /usr/sbin/nologin ecpa
sudo mkdir -p /opt/ecpa /var/lib/ecpa
sudo cp -r EasyCLIProxyAPI-web-v*-Linux-amd64/* /opt/ecpa/
sudo chown -R ecpa:ecpa /opt/ecpa /var/lib/ecpa

# 可选：写入自定义密码或反代参数
sudo install -m 600 /dev/null /etc/ecpa-web.env
# echo 'ECPA_WEB_PASSWORD=your-strong-password' | sudo tee /etc/ecpa-web.env

sudo cp deploy/ecpa-web.service /etc/systemd/system/ecpa-web.service
sudo systemctl daemon-reload
sudo systemctl enable --now ecpa-web
sudo journalctl -u ecpa-web -f
```

---

## 4. Docker / Docker Compose 部署

```bash
cd deploy
docker compose up -d --build
docker compose logs -f ecpa-web
```

- 数据持久化目录：`/data`（映射 `./data:/data`）
- 首次启动如未设置 `ECPA_WEB_PASSWORD`，请从 `docker compose logs ecpa-web` 查看初始密码。

---

## 5. 反向代理配置（Nginx / Caddy）

### Nginx（注意为 SSE 事件流关闭缓冲）

```nginx
server {
    listen 443 ssl http2;
    server_name ecpa.example.com;

    ssl_certificate     /etc/letsencrypt/live/ecpa.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ecpa.example.com/privkey.pem;

    client_max_body_size 64m;

    location /api/events {
        proxy_pass http://127.0.0.1:9317;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:9317;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

启动 `ecpa-web` 时请附带 `--trust-proxy`（或 `ECPA_WEB_TRUST_PROXY=true`），使登录 Cookie 自动附带 `Secure` 标记并准确识别客户端来源。

### Caddy

```caddyfile
ecpa.example.com {
    reverse_proxy 127.0.0.1:9317 {
        flush_interval -1
    }
}
```

---

## 6. 远程无头 OAuth 授权说明

在无头 WebUI 模式下：
1. 点击 OAuth 登录按钮后，浏览器会自动在新标签页打开对应平台的授权链接。
2. 完成登录后，若回调地址指向无法直接访问的 `http://localhost:...`，只需从浏览器地址栏复制完整的回调 URL，粘贴到 OAuth 卡片下方的「手动提交回调」输入框提交即可完成授权。

---

## 7. 本地源码编译

```bash
# 1. 构建共享前端
bun install --frozen-lockfile
bun run build

# 2. 仅编译无头 WebUI 后端（不拉取 Tauri/GTK/WebKit）
cargo build --manifest-path src-tauri/Cargo.toml -p ecpa-web --release
```

开发联调时可以同时运行 `ecpa-web --no-auth`（默认 `127.0.0.1:9317`）和 `bun run dev`（`vite.config.js` 已自动将 `/api`、`/v0`、`/v8` 代理到 `http://127.0.0.1:9317`）。
