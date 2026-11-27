use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
};

pub const DEFAULT_WEB_HOST: &str = "127.0.0.1";
pub const DEFAULT_WEB_PORT: u16 = 9317;
pub const DEFAULT_SESSION_TTL_HOURS: u64 = 168;
pub const WEBUI_CONFIG_FILE: &str = "webui.toml";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct WebUiFileConfig {
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub trust_proxy: Option<bool>,
    #[serde(default)]
    pub tls_cert: Option<String>,
    #[serde(default)]
    pub tls_key: Option<String>,
    #[serde(default)]
    pub static_dir: Option<String>,
    #[serde(default)]
    pub password_hash: Option<String>,
    #[serde(default)]
    pub session_secret: Option<String>,
    #[serde(default)]
    pub session_version: Option<u64>,
    #[serde(default)]
    pub session_ttl_hours: Option<u64>,
}

#[derive(Clone, Debug, Default)]
pub struct CliArgs {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub data_dir: Option<PathBuf>,
    pub password: Option<String>,
    pub no_auth: bool,
    pub trust_proxy: Option<bool>,
    pub tls_cert: Option<PathBuf>,
    pub tls_key: Option<PathBuf>,
    pub static_dir: Option<PathBuf>,
    pub show_help: bool,
    pub show_version: bool,
}

#[derive(Clone, Debug)]
pub struct WebServerConfig {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub password_override: Option<String>,
    pub no_auth: bool,
    pub trust_proxy: bool,
    pub tls_cert: Option<PathBuf>,
    pub tls_key: Option<PathBuf>,
    pub static_dir: Option<PathBuf>,
    pub session_ttl_hours: u64,
    pub file_config: WebUiFileConfig,
}

impl WebServerConfig {
    pub fn socket_addr(&self) -> Result<SocketAddr, String> {
        let ip: IpAddr = if self.host.eq_ignore_ascii_case("localhost") {
            IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
        } else {
            self.host.parse::<IpAddr>().map_err(|error| {
                format!(
                    "Invalid listen host '{}': {error}. Expected an IP address such as 127.0.0.1, ::1, or 0.0.0.0",
                    self.host
                )
            })?
        };
        Ok(SocketAddr::new(ip, self.port))
    }

    pub fn tls_enabled(&self) -> bool {
        self.tls_cert.is_some() && self.tls_key.is_some()
    }

    pub fn config_path(&self) -> PathBuf {
        self.data_dir.join(WEBUI_CONFIG_FILE)
    }

    pub fn display_url(&self) -> String {
        let scheme = if self.tls_enabled() { "https" } else { "http" };
        let host = if self.host.contains(':') && !self.host.starts_with('[') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        format!("{scheme}://{host}:{}", self.port)
    }
}

pub fn is_loopback_host(host: &str) -> bool {
    let trimmed = host.trim().trim_matches(|c| c == '[' || c == ']');
    if trimmed.eq_ignore_ascii_case("localhost") {
        return true;
    }
    trimmed
        .parse::<IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

pub fn usage_text() -> &'static str {
    concat!(
        "EasyCLIProxyAPI Headless WebUI (ecpa-web)\n\n",
        "USAGE:\n",
        "  ecpa-web [OPTIONS]\n\n",
        "OPTIONS:\n",
        "  --host <ADDR>         Listen IP address (default: 127.0.0.1, env: ECPA_WEB_HOST)\n",
        "  --port <PORT>         Listen TCP port (default: 9317, env: ECPA_WEB_PORT)\n",
        "  --data-dir <PATH>     Data directory for config/DB/credentials (env: ECPA_DATA_DIR)\n",
        "  --password <PASS>     Set/rotate WebUI login password (env: ECPA_WEB_PASSWORD)\n",
        "  --no-auth             Disable WebUI auth (loopback only, env: ECPA_WEB_NO_AUTH=1)\n",
        "  --trust-proxy         Trust X-Forwarded-Proto/Host/For from reverse proxy (env: ECPA_WEB_TRUST_PROXY=1)\n",
        "  --tls-cert <PATH>     PEM certificate chain for built-in HTTPS (env: ECPA_WEB_TLS_CERT)\n",
        "  --tls-key <PATH>      PEM private key for built-in HTTPS (env: ECPA_WEB_TLS_KEY)\n",
        "  --static-dir <PATH>   Serve frontend assets from directory instead of embedded dist (env: ECPA_WEB_STATIC_DIR)\n",
        "  -h, --help            Print this help message\n",
        "  -V, --version         Print version information\n"
    )
}

pub fn parse_cli_args<I, S>(iter: I) -> Result<CliArgs, String>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut args = CliArgs::default();
    let mut it = iter.into_iter().map(Into::into);
    while let Some(arg) = it.next() {
        let (flag, inline_value) = match arg.split_once('=') {
            Some((k, v)) if k.starts_with("--") => (k.to_string(), Some(v.to_string())),
            _ => (arg, None),
        };
        let next_val = |flag_name: &str, inline: Option<String>, it: &mut dyn Iterator<Item = String>| -> Result<String, String> {
            inline
                .or_else(|| it.next())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| format!("Option {flag_name} requires a value"))
        };
        match flag.as_str() {
            "-h" | "--help" => args.show_help = true,
            "-V" | "--version" => args.show_version = true,
            "--host" => args.host = Some(next_val("--host", inline_value, &mut it)?),
            "--port" => {
                let raw = next_val("--port", inline_value, &mut it)?;
                let port = raw
                    .parse::<u16>()
                    .map_err(|_| format!("Invalid --port value: {raw}"))?;
                if port == 0 {
                    return Err("Option --port must be between 1 and 65535".to_string());
                }
                args.port = Some(port);
            }
            "--data-dir" => {
                args.data_dir = Some(PathBuf::from(next_val("--data-dir", inline_value, &mut it)?));
            }
            "--password" => {
                args.password = Some(next_val("--password", inline_value, &mut it)?);
            }
            "--no-auth" => args.no_auth = true,
            "--trust-proxy" => args.trust_proxy = Some(true),
            "--tls-cert" => {
                args.tls_cert = Some(PathBuf::from(next_val("--tls-cert", inline_value, &mut it)?));
            }
            "--tls-key" => {
                args.tls_key = Some(PathBuf::from(next_val("--tls-key", inline_value, &mut it)?));
            }
            "--static-dir" => {
                args.static_dir =
                    Some(PathBuf::from(next_val("--static-dir", inline_value, &mut it)?));
            }
            "--preserve-core" | "--autostart" => {}
            other => {
                return Err(format!("Unknown argument: {other}\n\n{}", usage_text()));
            }
        }
    }
    Ok(args)
}

fn parse_env_bool(key: &str) -> Option<bool> {
    let raw = env::var(key).ok()?;
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn non_empty_env(key: &str) -> Option<String> {
    env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub fn load_file_config(path: &Path) -> Result<WebUiFileConfig, String> {
    match fs::read_to_string(path) {
        Ok(content) => toml::from_str::<WebUiFileConfig>(&content)
            .map_err(|error| format!("Failed to parse {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(WebUiFileConfig::default()),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

pub fn save_file_config(path: &Path, config: &WebUiFileConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create WebUI config directory {}: {error}",
                parent.display()
            )
        })?;
    }
    let serialized = toml::to_string_pretty(config)
        .map_err(|error| format!("Failed to serialize WebUI config: {error}"))?;
    let tmp_path = path.with_extension("toml.tmp");
    fs::write(&tmp_path, serialized.as_bytes())
        .map_err(|error| format!("Failed to write {}: {error}", tmp_path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp_path, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&tmp_path, path)
        .map_err(|error| format!("Failed to save {}: {error}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

pub fn resolve_config(cli: &CliArgs) -> Result<WebServerConfig, String> {
    let data_dir = match cli
        .data_dir
        .clone()
        .or_else(|| non_empty_env("ECPA_DATA_DIR").map(PathBuf::from))
    {
        Some(dir) => dir,
        None => ecpa_core::core_base_dir()?,
    };
    let data_dir = if data_dir.is_relative() {
        env::current_dir()
            .map_err(|error| format!("Failed to resolve current working directory: {error}"))?
            .join(data_dir)
    } else {
        data_dir
    };
    fs::create_dir_all(&data_dir).map_err(|error| {
        format!(
            "Failed to create data directory {}: {error}",
            data_dir.display()
        )
    })?;

    let file_config = load_file_config(&data_dir.join(WEBUI_CONFIG_FILE))?;

    let env_host = non_empty_env("ECPA_WEB_HOST");
    let env_port = match non_empty_env("ECPA_WEB_PORT") {
        Some(raw) => {
            let port = raw
                .parse::<u16>()
                .map_err(|_| format!("Invalid ECPA_WEB_PORT value: {raw}"))?;
            if port == 0 {
                return Err("ECPA_WEB_PORT must be between 1 and 65535".to_string());
            }
            Some(port)
        }
        None => None,
    };
    let env_password = non_empty_env("ECPA_WEB_PASSWORD");
    let env_no_auth = parse_env_bool("ECPA_WEB_NO_AUTH").unwrap_or(false);
    let env_trust_proxy = parse_env_bool("ECPA_WEB_TRUST_PROXY");
    let env_tls_cert = non_empty_env("ECPA_WEB_TLS_CERT").map(PathBuf::from);
    let env_tls_key = non_empty_env("ECPA_WEB_TLS_KEY").map(PathBuf::from);
    let env_static_dir = non_empty_env("ECPA_WEB_STATIC_DIR").map(PathBuf::from);

    let host = cli
        .host
        .clone()
        .or(env_host)
        .or_else(|| file_config.host.clone())
        .unwrap_or_else(|| DEFAULT_WEB_HOST.to_string());
    let port = cli
        .port
        .or(env_port)
        .or(file_config.port)
        .unwrap_or(DEFAULT_WEB_PORT);
    let no_auth = cli.no_auth || env_no_auth;
    let trust_proxy = cli
        .trust_proxy
        .or(env_trust_proxy)
        .or(file_config.trust_proxy)
        .unwrap_or(false);
    let tls_cert = cli
        .tls_cert
        .clone()
        .or(env_tls_cert)
        .or_else(|| file_config.tls_cert.clone().map(PathBuf::from));
    let tls_key = cli
        .tls_key
        .clone()
        .or(env_tls_key)
        .or_else(|| file_config.tls_key.clone().map(PathBuf::from));
    let static_dir = cli
        .static_dir
        .clone()
        .or(env_static_dir)
        .or_else(|| file_config.static_dir.clone().map(PathBuf::from));
    let password_override = cli.password.clone().or(env_password);
    let session_ttl_hours = file_config
        .session_ttl_hours
        .unwrap_or(DEFAULT_SESSION_TTL_HOURS)
        .clamp(1, 24 * 365);

    validate_config(&host, no_auth, tls_cert.as_deref(), tls_key.as_deref())?;

    let resolved = WebServerConfig {
        host,
        port,
        data_dir,
        password_override,
        no_auth,
        trust_proxy,
        tls_cert,
        tls_key,
        static_dir,
        session_ttl_hours,
        file_config,
    };
    let _ = resolved.socket_addr()?;
    Ok(resolved)
}

pub fn validate_config(
    host: &str,
    no_auth: bool,
    tls_cert: Option<&Path>,
    tls_key: Option<&Path>,
) -> Result<(), String> {
    if no_auth && !is_loopback_host(host) {
        return Err(format!(
            "Refusing to start with --no-auth on non-loopback host '{host}'. Authentication is required whenever binding outside 127.0.0.1 / ::1."
        ));
    }
    if tls_cert.is_some() != tls_key.is_some() {
        return Err(
            "Both --tls-cert and --tls-key must be specified together to enable built-in HTTPS"
                .to_string(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cli_flags_and_equals_syntax() {
        let parsed = parse_cli_args([
            "--host=0.0.0.0",
            "--port",
            "9400",
            "--data-dir",
            "/tmp/ecpa",
            "--trust-proxy",
            "--password=secret-pass",
        ])
        .unwrap();
        assert_eq!(parsed.host.as_deref(), Some("0.0.0.0"));
        assert_eq!(parsed.port, Some(9400));
        assert_eq!(parsed.data_dir.as_deref(), Some(Path::new("/tmp/ecpa")));
        assert_eq!(parsed.trust_proxy, Some(true));
        assert_eq!(parsed.password.as_deref(), Some("secret-pass"));
    }

    #[test]
    fn rejects_no_auth_on_non_loopback_host() {
        assert!(validate_config("127.0.0.1", true, None, None).is_ok());
        assert!(validate_config("::1", true, None, None).is_ok());
        assert!(validate_config("localhost", true, None, None).is_ok());
        assert!(validate_config("0.0.0.0", true, None, None).is_err());
        assert!(validate_config("192.168.1.10", true, None, None).is_err());
    }

    #[test]
    fn rejects_partial_tls_configuration() {
        assert!(validate_config("127.0.0.1", false, Some(Path::new("cert.pem")), None).is_err());
        assert!(validate_config("127.0.0.1", false, None, Some(Path::new("key.pem"))).is_err());
        assert!(validate_config(
            "127.0.0.1",
            false,
            Some(Path::new("cert.pem")),
            Some(Path::new("key.pem")),
        )
        .is_ok());
    }
}
