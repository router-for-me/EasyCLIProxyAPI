use axum::{
    body::{to_bytes, Body},
    http::{header, HeaderName, HeaderValue, Request, Response, StatusCode},
    response::IntoResponse,
};
use ecpa_core::AppHandle as CoreAppHandle;
use std::{sync::LazyLock, time::Duration};

const MAX_PROXY_REQUEST_BODY: usize = 64 * 1024 * 1024;
const PLUGIN_BOOTSTRAP_SCRIPT: &str = r#"<script>(function(){try{var a=JSON.parse(localStorage.getItem('cli-proxy-auth')||'{}');if(!a||typeof a!=='object'||Array.isArray(a))a={};if(!a.state||typeof a.state!=='object'||Array.isArray(a.state))a.state={};if(!a.state.managementKey)a.state.managementKey='webui-session';localStorage.setItem('cli-proxy-auth',JSON.stringify(a));}catch(e){}})();</script>"#;

static CORE_PROXY_CLIENT: LazyLock<Result<reqwest::Client, String>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| format!("Failed to initialize local core proxy client: {error}"))
});

pub fn is_hop_by_hop_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

pub async fn proxy_to_local_core(
    core_app: &CoreAppHandle,
    req: Request<Body>,
    inject_plugin_html_bootstrap: bool,
) -> Response<Body> {
    let (origin, auth_header, _tls) = match ecpa_core::local_core_proxy_target(core_app) {
        Ok(target) => target,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Local CPA core is unavailable: {error}"),
            )
                .into_response();
        }
    };
    let client = match CORE_PROXY_CLIENT.as_ref() {
        Ok(client) => client,
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, error.clone()).into_response();
        }
    };

    let method = req.method().clone();
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let target_url = format!("{}{}", origin.trim_end_matches('/'), path_and_query);

    let (parts, body) = req.into_parts();
    let body_bytes = match to_bytes(body, MAX_PROXY_REQUEST_BODY).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("Request body too large or unreadable: {error}"),
            )
                .into_response();
        }
    };

    let reqwest_method = match reqwest::Method::from_bytes(method.as_str().as_bytes()) {
        Ok(m) => m,
        Err(_) => return (StatusCode::METHOD_NOT_ALLOWED, "Unsupported method").into_response(),
    };
    let mut upstream_req = client.request(reqwest_method, &target_url);

    for (name, value) in &parts.headers {
        let lower = name.as_str().to_ascii_lowercase();
        if is_hop_by_hop_header(&lower)
            || matches!(
                lower.as_str(),
                "host"
                    | "cookie"
                    | "authorization"
                    | "x-ecpa-client"
                    | "accept-encoding"
                    | "content-length"
            )
        {
            continue;
        }
        if let Ok(header_name) = reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes())
        {
            if let Ok(header_val) = reqwest::header::HeaderValue::from_bytes(value.as_bytes()) {
                upstream_req = upstream_req.header(header_name, header_val);
            }
        }
    }

    if let Some(auth) = auth_header {
        upstream_req = upstream_req.header(reqwest::header::AUTHORIZATION, auth);
    }

    if !body_bytes.is_empty() {
        upstream_req = upstream_req.body(body_bytes);
    }

    let upstream_resp = match upstream_req.send().await {
        Ok(resp) => resp,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Failed to reach local CPA core at {target_url}: {error}"),
            )
                .into_response();
        }
    };

    let status = StatusCode::from_u16(upstream_resp.status().as_u16())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let upstream_headers = upstream_resp.headers().clone();
    let is_html = upstream_headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|ct| ct.to_ascii_lowercase().contains("text/html"));

    let mut resp_builder = Response::builder().status(status);
    for (name, value) in &upstream_headers {
        let lower = name.as_str().to_ascii_lowercase();
        if is_hop_by_hop_header(&lower)
            || matches!(
                lower.as_str(),
                "content-length" | "content-encoding" | "x-frame-options" | "set-cookie"
            )
        {
            continue;
        }
        // Allow same-origin iframe embedding for plugin pages.
        if lower == "content-security-policy" && inject_plugin_html_bootstrap {
            continue;
        }
        if let (Ok(h_name), Ok(h_val)) = (
            HeaderName::from_bytes(name.as_str().as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) {
            resp_builder = resp_builder.header(h_name, h_val);
        }
    }

    if inject_plugin_html_bootstrap && is_html {
        let html = match upstream_resp.text().await {
            Ok(text) => inject_bootstrap_into_html(&text),
            Err(error) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    format!("Failed to read plugin page HTML: {error}"),
                )
                    .into_response();
            }
        };
        resp_builder = resp_builder.header(header::CACHE_CONTROL, "no-store");
        return resp_builder
            .body(Body::from(html))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    let bytes = match upstream_resp.bytes().await {
        Ok(b) => b,
        Err(error) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Failed to read local CPA core response: {error}"),
            )
                .into_response();
        }
    };
    resp_builder
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

pub fn inject_bootstrap_into_html(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    if let Some(head_idx) = lower.find("<head") {
        if let Some(close_rel) = lower[head_idx..].find('>') {
            let insert_at = head_idx + close_rel + 1;
            let mut out = String::with_capacity(html.len() + PLUGIN_BOOTSTRAP_SCRIPT.len());
            out.push_str(&html[..insert_at]);
            out.push_str(PLUGIN_BOOTSTRAP_SCRIPT);
            out.push_str(&html[insert_at..]);
            return out;
        }
    }
    format!("{PLUGIN_BOOTSTRAP_SCRIPT}{html}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_plugin_bootstrap_right_after_head_tag() {
        let input = "<!doctype html><html><HEAD lang=\"en\"><title>Plugin</title></HEAD><body></body></html>";
        let output = inject_bootstrap_into_html(input);
        assert!(output.contains("<HEAD lang=\"en\"><script>"));
        assert!(output.contains("cli-proxy-auth"));
        assert!(!output.contains("Bearer"));
    }
}
