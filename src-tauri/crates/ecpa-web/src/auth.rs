use crate::config::{save_file_config, WebServerConfig, WebUiFileConfig};
use axum::http::{header, HeaderMap};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    net::IpAddr,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const SESSION_COOKIE_NAME: &str = "ecpa_session";
pub const CLIENT_HEADER_NAME: &str = "x-ecpa-client";
pub const CLIENT_HEADER_VALUE: &str = "webui";

const PBKDF2_PREFIX: &str = "pbkdf2-sha256";
const PBKDF2_ITERATIONS: u32 = 600_000;
const MIN_PASSWORD_LEN: usize = 8;
const MAX_LOGIN_FAILURES: usize = 10;
const LOGIN_WINDOW: Duration = Duration::from_secs(300);

#[derive(Clone, Debug)]
pub struct AuthBootstrap {
    pub auth: AuthManager,
    pub generated_password: Option<String>,
}

struct AuthInner {
    password_hash: Option<String>,
    session_secret: Vec<u8>,
    session_version: u64,
    file_config: WebUiFileConfig,
}

pub struct AuthManager {
    no_auth: bool,
    trust_proxy: bool,
    tls_enabled: bool,
    session_ttl_secs: u64,
    config_path: PathBuf,
    inner: Mutex<AuthInner>,
    failures: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl Clone for AuthManager {
    fn clone(&self) -> Self {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        Self {
            no_auth: self.no_auth,
            trust_proxy: self.trust_proxy,
            tls_enabled: self.tls_enabled,
            session_ttl_secs: self.session_ttl_secs,
            config_path: self.config_path.clone(),
            inner: Mutex::new(AuthInner {
                password_hash: inner.password_hash.clone(),
                session_secret: inner.session_secret.clone(),
                session_version: inner.session_version,
                file_config: inner.file_config.clone(),
            }),
            failures: Mutex::new(HashMap::new()),
        }
    }
}

impl std::fmt::Debug for AuthManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthManager")
            .field("no_auth", &self.no_auth)
            .field("trust_proxy", &self.trust_proxy)
            .field("tls_enabled", &self.tls_enabled)
            .finish()
    }
}

#[derive(Serialize, Deserialize)]
struct SessionClaims {
    exp: u64,
    ver: u64,
}

impl AuthManager {
    pub fn initialize(config: &WebServerConfig) -> Result<AuthBootstrap, String> {
        let mut file_config = config.file_config.clone();
        let mut dirty = false;

        let session_secret = match file_config
            .session_secret
            .as_deref()
            .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
            .filter(|bytes| bytes.len() >= 32)
        {
            Some(bytes) => bytes,
            None => {
                let bytes = random_bytes(32)?;
                file_config.session_secret = Some(URL_SAFE_NO_PAD.encode(&bytes));
                dirty = true;
                bytes
            }
        };

        let mut session_version = file_config.session_version.unwrap_or(1).max(1);
        let mut generated_password = None;

        if !config.no_auth {
            if let Some(override_password) = config.password_override.as_deref() {
                let needs_update = file_config
                    .password_hash
                    .as_deref()
                    .is_none_or(|hash| !verify_password(override_password, hash));
                if needs_update {
                    file_config.password_hash = Some(hash_password(override_password)?);
                    session_version = session_version.saturating_add(1);
                    file_config.session_version = Some(session_version);
                    dirty = true;
                }
            } else if file_config.password_hash.as_deref().is_none_or(|s| s.trim().is_empty()) {
                let generated = generate_random_password(24)?;
                file_config.password_hash = Some(hash_password(&generated)?);
                file_config.session_version = Some(session_version);
                generated_password = Some(generated);
                dirty = true;
            }
        }

        if dirty {
            save_file_config(&config.config_path(), &file_config)?;
        }

        let password_hash = file_config.password_hash.clone();
        let auth = Self {
            no_auth: config.no_auth,
            trust_proxy: config.trust_proxy,
            tls_enabled: config.tls_enabled(),
            session_ttl_secs: config.session_ttl_hours.saturating_mul(3600),
            config_path: config.config_path(),
            inner: Mutex::new(AuthInner {
                password_hash,
                session_secret,
                session_version,
                file_config,
            }),
            failures: Mutex::new(HashMap::new()),
        };

        Ok(AuthBootstrap {
            auth,
            generated_password,
        })
    }

    pub fn auth_required(&self) -> bool {
        !self.no_auth
    }

    pub fn is_authenticated(&self, headers: &HeaderMap) -> bool {
        if self.no_auth {
            return true;
        }
        let Some(token) = extract_session_cookie(headers) else {
            return false;
        };
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        verify_session_token(&token, &inner.session_secret, inner.session_version)
    }

    pub fn check_csrf(&self, headers: &HeaderMap) -> Result<(), &'static str> {
        let client = headers
            .get(CLIENT_HEADER_NAME)
            .and_then(|v| v.to_str().ok())
            .map(str::trim);
        if client != Some(CLIENT_HEADER_VALUE) {
            return Err("Missing or invalid X-ECPA-Client header");
        }
        if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
            let expected_host = self.effective_host(headers).ok_or("Missing Host header")?;
            let origin_host = extract_origin_host_port(origin).ok_or("Invalid Origin header")?;
            if !hosts_match(&origin_host, &expected_host) {
                return Err("Cross-origin request rejected");
            }
        }
        Ok(())
    }

    pub fn effective_host(&self, headers: &HeaderMap) -> Option<String> {
        if self.trust_proxy {
            if let Some(forwarded) = headers
                .get("x-forwarded-host")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                return Some(forwarded.to_string());
            }
        }
        headers
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(ToString::to_string)
    }

    pub fn client_key(&self, peer: IpAddr, headers: &HeaderMap) -> String {
        if self.trust_proxy {
            if let Some(forwarded) = headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                return forwarded.to_string();
            }
        }
        peer.to_string()
    }

    pub fn check_rate_limit(&self, client_key: &str) -> Result<(), u64> {
        let now = Instant::now();
        let mut failures = self
            .failures
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let queue = failures.entry(client_key.to_string()).or_default();
        while queue
            .front()
            .is_some_and(|ts| now.duration_since(*ts) >= LOGIN_WINDOW)
        {
            queue.pop_front();
        }
        if queue.len() >= MAX_LOGIN_FAILURES {
            let oldest = *queue.front().unwrap();
            let retry_after = LOGIN_WINDOW
                .saturating_sub(now.duration_since(oldest))
                .as_secs()
                .max(1);
            return Err(retry_after);
        }
        Ok(())
    }

    pub fn record_login_failure(&self, client_key: &str) {
        let now = Instant::now();
        let mut failures = self
            .failures
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let queue = failures.entry(client_key.to_string()).or_default();
        while queue
            .front()
            .is_some_and(|ts| now.duration_since(*ts) >= LOGIN_WINDOW)
        {
            queue.pop_front();
        }
        queue.push_back(now);
    }

    pub fn clear_login_failures(&self, client_key: &str) {
        let mut failures = self
            .failures
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        failures.remove(client_key);
    }

    pub fn verify_login(&self, password: &str) -> Result<String, &'static str> {
        if self.no_auth {
            return self.issue_session_token().map_err(|_| "Session error");
        }
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let hash = inner
            .password_hash
            .as_deref()
            .ok_or("WebUI password is not configured")?;
        if !verify_password(password, hash) {
            return Err("Invalid password");
        }
        sign_session_token(
            &inner.session_secret,
            inner.session_version,
            self.session_ttl_secs,
        )
        .map_err(|_| "Failed to create session")
    }

    pub fn change_password(
        &self,
        current_password: &str,
        new_password: &str,
    ) -> Result<String, String> {
        if self.no_auth {
            return Err("Cannot change password when --no-auth is enabled".to_string());
        }
        if new_password.len() < MIN_PASSWORD_LEN {
            return Err(format!(
                "New password must be at least {MIN_PASSWORD_LEN} characters long"
            ));
        }
        let new_hash = hash_password(new_password)?;
        let mut inner = self
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let existing_hash = inner
            .password_hash
            .as_deref()
            .ok_or_else(|| "WebUI password is not configured".to_string())?;
        if !verify_password(current_password, existing_hash) {
            return Err("Current password is incorrect".to_string());
        }

        let next_version = inner.session_version.saturating_add(1);
        let mut next_file_config = inner.file_config.clone();
        next_file_config.password_hash = Some(new_hash.clone());
        next_file_config.session_version = Some(next_version);
        save_file_config(&self.config_path, &next_file_config)?;

        inner.password_hash = Some(new_hash);
        inner.session_version = next_version;
        inner.file_config = next_file_config;

        sign_session_token(
            &inner.session_secret,
            inner.session_version,
            self.session_ttl_secs,
        )
    }

    pub fn issue_session_token(&self) -> Result<String, String> {
        let inner = self
            .inner
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        sign_session_token(
            &inner.session_secret,
            inner.session_version,
            self.session_ttl_secs,
        )
    }

    pub fn build_session_cookie(&self, token: &str, headers: &HeaderMap) -> String {
        let secure = self.is_https_request(headers);
        let mut cookie = format!(
            "{SESSION_COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
            self.session_ttl_secs
        );
        if secure {
            cookie.push_str("; Secure");
        }
        cookie
    }

    pub fn build_logout_cookie(&self, headers: &HeaderMap) -> String {
        let mut cookie = format!(
            "{SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"
        );
        if self.is_https_request(headers) {
            cookie.push_str("; Secure");
        }
        cookie
    }

    fn is_https_request(&self, headers: &HeaderMap) -> bool {
        if self.tls_enabled {
            return true;
        }
        if !self.trust_proxy {
            return false;
        }
        headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .is_some_and(|proto| proto.trim().eq_ignore_ascii_case("https"))
    }
}

fn extract_session_cookie(headers: &HeaderMap) -> Option<String> {
    for value in headers.get_all(header::COOKIE) {
        let Ok(raw) = value.to_str() else {
            continue;
        };
        for pair in raw.split(';') {
            let Some((k, v)) = pair.trim().split_once('=') else {
                continue;
            };
            if k.trim() == SESSION_COOKIE_NAME {
                let token = v.trim();
                if !token.is_empty() {
                    return Some(token.to_string());
                }
            }
        }
    }
    None
}

fn extract_origin_host_port(origin: &str) -> Option<String> {
    let url = reqwest::Url::parse(origin).ok()?;
    let host = url.host_str()?;
    match url.port() {
        Some(port) => Some(format!("{host}:{port}")),
        None => Some(host.to_string()),
    }
}

fn hosts_match(origin_host: &str, request_host: &str) -> bool {
    let normalize = |value: &str| {
        let lower = value.trim().to_ascii_lowercase();
        lower
            .strip_suffix(":80")
            .or_else(|| lower.strip_suffix(":443"))
            .unwrap_or(&lower)
            .to_string()
    };
    origin_host.eq_ignore_ascii_case(request_host.trim())
        || normalize(origin_host) == normalize(request_host)
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn sign_session_token(secret: &[u8], version: u64, ttl_secs: u64) -> Result<String, String> {
    let claims = SessionClaims {
        exp: unix_now_secs().saturating_add(ttl_secs),
        ver: version,
    };
    let payload = serde_json::to_vec(&claims).map_err(|error| error.to_string())?;
    let encoded_payload = URL_SAFE_NO_PAD.encode(payload);
    let mac = hmac_sha256(secret, encoded_payload.as_bytes());
    let encoded_sig = URL_SAFE_NO_PAD.encode(mac);
    Ok(format!("{encoded_payload}.{encoded_sig}"))
}

fn verify_session_token(token: &str, secret: &[u8], expected_version: u64) -> bool {
    let Some((encoded_payload, encoded_sig)) = token.split_once('.') else {
        return false;
    };
    let Ok(provided_sig) = URL_SAFE_NO_PAD.decode(encoded_sig) else {
        return false;
    };
    let expected_sig = hmac_sha256(secret, encoded_payload.as_bytes());
    if !ct_eq(&provided_sig, &expected_sig) {
        return false;
    }
    let Ok(payload_bytes) = URL_SAFE_NO_PAD.decode(encoded_payload) else {
        return false;
    };
    let Ok(claims) = serde_json::from_slice::<SessionClaims>(&payload_bytes) else {
        return false;
    };
    claims.ver == expected_version && claims.exp > unix_now_secs()
}

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = random_bytes(16)?;
    let derived = pbkdf2_hmac_sha256(password.as_bytes(), &salt, PBKDF2_ITERATIONS);
    Ok(format!(
        "{PBKDF2_PREFIX}${PBKDF2_ITERATIONS}${}${}",
        URL_SAFE_NO_PAD.encode(salt),
        URL_SAFE_NO_PAD.encode(derived)
    ))
}

pub fn verify_password(password: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.trim().split('$').collect();
    if parts.len() != 4 || parts[0] != PBKDF2_PREFIX {
        return false;
    }
    let Ok(iterations) = parts[1].parse::<u32>() else {
        return false;
    };
    if iterations < 10_000 || iterations > 5_000_000 {
        return false;
    }
    let (Ok(salt), Ok(expected)) = (
        URL_SAFE_NO_PAD.decode(parts[2]),
        URL_SAFE_NO_PAD.decode(parts[3]),
    ) else {
        return false;
    };
    if salt.len() < 8 || expected.len() != 32 {
        return false;
    }
    let derived = pbkdf2_hmac_sha256(password.as_bytes(), &salt, iterations);
    ct_eq(&derived, &expected)
}

fn generate_random_password(len: usize) -> Result<String, String> {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let mut out = String::with_capacity(len);
    while out.len() < len {
        let bytes = random_bytes(32)?;
        for byte in bytes {
            // Rejection sampling to avoid modulo bias
            let limit = 256 - (256 % ALPHABET.len());
            if usize::from(byte) < limit {
                out.push(ALPHABET[usize::from(byte) % ALPHABET.len()] as char);
                if out.len() == len {
                    break;
                }
            }
        }
    }
    Ok(out)
}

fn random_bytes(len: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; len];
    getrandom::fill(&mut buf).map_err(|error| format!("CSPRNG failed: {error}"))?;
    Ok(buf)
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK_SIZE: usize = 64;
    let mut key_block = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let digest = Sha256::digest(key);
        key_block[..32].copy_from_slice(&digest);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut ipad = [0x36u8; BLOCK_SIZE];
    let mut opad = [0x5cu8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }

    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(data);
    let inner_hash = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    outer.finalize().into()
}

fn pbkdf2_hmac_sha256(password: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut salt_block = Vec::with_capacity(salt.len() + 4);
    salt_block.extend_from_slice(salt);
    salt_block.extend_from_slice(&1u32.to_be_bytes());

    let mut u = hmac_sha256(password, &salt_block);
    let mut out = u;
    for _ in 1..iterations {
        u = hmac_sha256(password, &u);
        for i in 0..32 {
            out[i] ^= u[i];
        }
    }
    out
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{DEFAULT_SESSION_TTL_HOURS, DEFAULT_WEB_HOST, DEFAULT_WEB_PORT};
    use axum::http::HeaderValue;
    use std::fs;

    #[test]
    fn pbkdf2_hashes_and_verifies_passwords() {
        let salt = b"0123456789abcdef";
        let derived = pbkdf2_hmac_sha256(b"password", salt, 10_000);
        let stored = format!(
            "{PBKDF2_PREFIX}$10000${}${}",
            URL_SAFE_NO_PAD.encode(salt),
            URL_SAFE_NO_PAD.encode(derived)
        );
        assert!(verify_password("password", &stored));
        assert!(!verify_password("wrong", &stored));
    }

    #[test]
    fn session_tokens_respect_version_and_secret() {
        let secret = b"super-secret-32-byte-session-key!";
        let token = sign_session_token(secret, 2, 3600).unwrap();
        assert!(verify_session_token(&token, secret, 2));
        assert!(!verify_session_token(&token, secret, 3));
        assert!(!verify_session_token(&token, b"wrong-secret", 2));
    }

    #[test]
    fn csrf_checks_client_header_and_origin_match() {
        let tmp = std::env::temp_dir().join(format!(
            "ecpa-web-auth-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let cfg = WebServerConfig {
            host: DEFAULT_WEB_HOST.to_string(),
            port: DEFAULT_WEB_PORT,
            data_dir: tmp.clone(),
            password_override: Some("correct-horse-battery".to_string()),
            no_auth: false,
            trust_proxy: false,
            tls_cert: None,
            tls_key: None,
            static_dir: None,
            session_ttl_hours: DEFAULT_SESSION_TTL_HOURS,
            file_config: WebUiFileConfig::default(),
        };
        let bootstrap = AuthManager::initialize(&cfg).unwrap();
        assert!(bootstrap.generated_password.is_none());

        let mut headers = HeaderMap::new();
        assert!(bootstrap.auth.check_csrf(&headers).is_err());

        headers.insert(CLIENT_HEADER_NAME, HeaderValue::from_static("webui"));
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:9317"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:9317"),
        );
        assert!(bootstrap.auth.check_csrf(&headers).is_ok());

        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://evil.example:9317"),
        );
        assert!(bootstrap.auth.check_csrf(&headers).is_err());

        let _ = fs::remove_dir_all(&tmp);
    }
}
