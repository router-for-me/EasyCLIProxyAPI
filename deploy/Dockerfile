# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14-slim AS frontend-builder
WORKDIR /app
COPY package.json bun.lock index.html vite.config.js tsconfig.json ./
COPY src ./src
RUN bun install --frozen-lockfile && bun run build

FROM rust:1.97-bookworm AS rust-builder
WORKDIR /app
COPY core-version.txt ./
COPY plugins ./plugins
COPY src/services/deepSeekHarnessSchema.json ./src/services/deepSeekHarnessSchema.json
COPY src/services/claudeDesktopModelRules.json ./src/services/claudeDesktopModelRules.json
COPY src-tauri ./src-tauri
COPY --from=frontend-builder /app/dist ./dist
RUN cargo build --manifest-path src-tauri/Cargo.toml -p ecpa-web --release \
 && ! ldd src-tauri/target/release/ecpa-web | grep -iE 'libwebkit|libgtk|libgdk|libdbus|libappindicator|libayatana'

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --home-dir /data --shell /usr/sbin/nologin ecpa \
 && mkdir -p /opt/ecpa /data \
 && chown -R ecpa:ecpa /opt/ecpa /data

WORKDIR /opt/ecpa
COPY --from=rust-builder /app/src-tauri/target/release/ecpa-web /opt/ecpa/EasyCLIProxyAPI-web
COPY --from=rust-builder /app/core-version.txt /opt/ecpa/core-version.txt
RUN chmod +x /opt/ecpa/EasyCLIProxyAPI-web

USER ecpa
VOLUME ["/data"]

ENV ECPA_DATA_DIR=/data
ENV ECPA_WEB_HOST=0.0.0.0
ENV ECPA_WEB_PORT=9317

# 9317: EasyCLIProxyAPI Headless WebUI
# 8317: Managed CLIProxyAPI proxy endpoint
EXPOSE 9317 8317

ENTRYPOINT ["/opt/ecpa/EasyCLIProxyAPI-web"]
