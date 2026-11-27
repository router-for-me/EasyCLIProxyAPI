use super::super::types::{now_secs, AccountRecord, LocalCredentialPreview};
use std::time::Duration;

pub(crate) fn build_http_client(proxy_url: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .connect_timeout(Duration::from_secs(12))
        .user_agent("EasyCLIProxyAPI/AccountSwitch");
    if let Some(proxy) = proxy_url.map(str::trim).filter(|v| !v.is_empty()) {
        if let Ok(p) = reqwest::Proxy::all(proxy) {
            builder = builder.proxy(p);
        }
    }
    builder
        .build()
        .map_err(|error| format!("Failed to initialize HTTP client: {error}"))
}

pub(crate) fn token_needs_refresh(record: &AccountRecord, lead_seconds: i64) -> bool {
    let has_refresh = record
        .credentials
        .refresh_token
        .as_deref()
        .is_some_and(|v| !v.trim().is_empty());
    if !has_refresh {
        return false;
    }
    let has_access = record
        .credentials
        .access_token
        .as_deref()
        .is_some_and(|v| !v.trim().is_empty());
    if !has_access {
        return true;
    }
    match record.credentials.expires_at {
        Some(exp) => {
            let exp_secs = if exp > 1_000_000_000_000 {
                exp / 1000
            } else {
                exp
            };
            exp_secs <= now_secs() + lead_seconds
        }
        None => false,
    }
}

pub(crate) fn preview_from_record(
    record: Option<AccountRecord>,
    existing: &[AccountRecord],
) -> LocalCredentialPreview {
    let Some(local) = record else {
        return LocalCredentialPreview::default();
    };
    let matched_id = existing
        .iter()
        .find(|item| !local.fingerprint.is_empty() && item.fingerprint == local.fingerprint)
        .map(|item| item.id.clone());
    LocalCredentialPreview {
        detected: true,
        label: Some(local.label),
        email: local.email,
        account_id: local.account_id,
        fingerprint: Some(local.fingerprint),
        matched_account_id: matched_id,
    }
}

/// Minimal protobuf varint/length-delimited helpers for Antigravity legacy `state.vscdb`.
pub(crate) mod proto {
    pub(crate) fn encode_varint(mut value: u64, out: &mut Vec<u8>) {
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                break;
            }
            out.push(byte | 0x80);
        }
    }

    pub(crate) fn encode_bytes_field(field_number: u32, data: &[u8], out: &mut Vec<u8>) {
        encode_varint(((field_number as u64) << 3) | 2, out);
        encode_varint(data.len() as u64, out);
        out.extend_from_slice(data);
    }

    pub(crate) fn encode_string_field(field_number: u32, value: &str, out: &mut Vec<u8>) {
        encode_bytes_field(field_number, value.as_bytes(), out);
    }

    pub(crate) fn encode_varint_field(field_number: u32, value: u64, out: &mut Vec<u8>) {
        encode_varint((field_number as u64) << 3, out);
        encode_varint(value, out);
    }

    /// Encode Antigravity `OAuthTokenInfo` inside `Topic { data["oauthTokenInfo"] = Row { value = base64(OAuthTokenInfo) } }`.
    pub(crate) fn encode_antigravity_oauth_topic(
        access_token: &str,
        refresh_token: &str,
        expiry_secs: i64,
    ) -> Vec<u8> {
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

        // OAuthTokenInfo: 1=access_token, 2=token_type("Bearer"), 3=refresh_token, 4=Timestamp{1=seconds}
        let mut ts = Vec::new();
        if expiry_secs > 0 {
            encode_varint_field(1, expiry_secs as u64, &mut ts);
        }
        let mut token_info = Vec::new();
        encode_string_field(1, access_token, &mut token_info);
        encode_string_field(2, "Bearer", &mut token_info);
        if !refresh_token.is_empty() {
            encode_string_field(3, refresh_token, &mut token_info);
        }
        if !ts.is_empty() {
            encode_bytes_field(4, &ts, &mut token_info);
        }

        // Row: 1=value (base64 of OAuthTokenInfo)
        let mut row = Vec::new();
        encode_string_field(1, &BASE64.encode(&token_info), &mut row);

        // MapEntry: 1=key("oauthTokenInfo"), 2=Row
        let mut entry = Vec::new();
        encode_string_field(1, "oauthTokenInfo", &mut entry);
        encode_bytes_field(2, &row, &mut entry);

        // Topic: 1=map<string, Row>
        let mut topic = Vec::new();
        encode_bytes_field(1, &entry, &mut topic);
        topic
    }
}
