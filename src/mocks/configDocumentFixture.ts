export const initialMockConfigYaml = `# Browser preview: this document is not connected to a CPA instance.
config-version: 8
server:
  host: 127.0.0.1
  port: 8317 # Local listener
  tls:
    enable: false
oauth:
  auth-dir: ~/.cli-proxy-api
access:
  api-keys: [preview-client]
routing:
  strategy: round-robin
  retry:
    request-retry: 3
observability:
  logs:
    debug: false
    logging-to-file: false
preview-extension:
  keep-this: true # Not represented in the visual editor
`;

