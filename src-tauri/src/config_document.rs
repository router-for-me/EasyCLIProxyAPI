use super::{
    check_revision, check_status, config_etag, Profile, RemoteCpaState, RemoteError, Selection,
    Target, TargetRemarks,
};
use crate::{CoreProcessState, GuiConfigState};
use reqwest::{header, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_norway::Value;
use tauri::Manager;

const CONFIG_ROUTE: &str = "config.yaml";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct KeyRemark {
    key: String,
    remark: String,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum DocumentError {
    StartCore,
    RestartRequired,
    TargetChanged,
    Unavailable,
    Unsupported,
    ReadOnly,
    Rejected,
    Conflict,
    VerifyRequired,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Document {
    pub(crate) yaml: String,
    pub(crate) etag: Option<String>,
    remarks: Vec<KeyRemark>,
    remarks_unavailable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveResult {
    document: Option<Document>,
    restart_required: bool,
    sync_failed: bool,
    remarks_failed: bool,
    readback_changed: bool,
}

fn selected_target(
    app: &tauri::AppHandle,
    selection: &mut Selection,
    revision: u32,
) -> Result<(Target, Option<u32>), DocumentError> {
    check_revision(selection, revision).map_err(|_| DocumentError::TargetChanged)?;
    match &selection.profile {
        Ok(Profile::Remote { endpoint, key }) => Target::new(endpoint, key)
            .map(|target| (target, None))
            .map_err(|_| DocumentError::Unavailable),
        Ok(Profile::Local) => {
            let gui = app
                .try_state::<GuiConfigState>()
                .ok_or(DocumentError::StartCore)?;
            let process = app
                .try_state::<CoreProcessState>()
                .ok_or(DocumentError::StartCore)?;
            let config = gui.snapshot().map_err(|_| DocumentError::Unavailable)?;
            if let Some(pending_pid) = selection.config_listener_restart_pid {
                let status = crate::current_core_status(Some(process.inner()), None)
                    .map_err(|_| DocumentError::Unavailable)?;
                if status.process_id == Some(pending_pid) {
                    return Err(DocumentError::RestartRequired);
                }
                selection.config_listener_restart_pid = None;
            }
            let pid = crate::current_core_status(Some(process.inner()), Some(config.port))
                .ok()
                .filter(|status| status.ready)
                .and_then(|status| status.process_id)
                .ok_or(DocumentError::StartCore)?;
            let key =
                crate::management_plaintext_key(&config).map_err(|_| DocumentError::Unavailable)?;
            let endpoint =
                crate::management_endpoint(&config, "").map_err(|_| DocumentError::Unavailable)?;
            let origin = endpoint
                .strip_suffix("/v8/management/")
                .ok_or(DocumentError::Unavailable)?;
            Target::new(origin, key)
                .map(|target| (target, Some(pid)))
                .map_err(|_| DocumentError::Unavailable)
        }
        Err(_) => Err(DocumentError::Unavailable),
    }
}

pub(crate) async fn read_yaml(target: &Target) -> Result<Document, DocumentError> {
    let response = target
        .send(Method::GET, CONFIG_ROUTE, None)
        .await
        .map_err(|_| DocumentError::Unavailable)?;
    check_status(response.status()).map_err(|error| match error {
        RemoteError::Unsupported => DocumentError::Unsupported,
        _ => DocumentError::Unavailable,
    })?;
    let etag = config_etag(&response)
        .ok()
        .and_then(|value| value.to_str().ok().map(str::to_owned));
    let bytes = response
        .bytes()
        .await
        .map_err(|_| DocumentError::Unavailable)?;
    let yaml = String::from_utf8(bytes.to_vec()).map_err(|_| DocumentError::Unsupported)?;
    Ok(Document {
        yaml,
        etag,
        remarks: Vec::new(),
        remarks_unavailable: false,
    })
}

fn remarks_path(state: &RemoteCpaState, target: &Target) -> Result<std::path::PathBuf, String> {
    Ok(state
        .path
        .as_ref()
        .ok_or("Missing target path")?
        .with_file_name(format!("remote-remarks-{}.json", target.usage_id())))
}

fn read_remarks(
    app: &tauri::AppHandle,
    state: &RemoteCpaState,
    target: &Target,
    local: bool,
    document: &Document,
) -> Result<Vec<KeyRemark>, String> {
    if local {
        let gui = app.state::<GuiConfigState>().snapshot()?;
        return Ok(gui
            .api_keys
            .into_iter()
            .filter(|entry| !entry.remark.is_empty())
            .map(|entry| KeyRemark {
                key: entry.key,
                remark: entry.remark,
            })
            .collect());
    }
    let remarks = TargetRemarks::load(&remarks_path(state, target)?)?;
    let settings = parse_settings(&document.yaml)?;
    Ok(settings
        .api_keys
        .into_iter()
        .filter_map(|key| {
            let remark = remarks
                .client_keys
                .get(&crate::sha256_bytes(key.as_bytes()))?
                .clone();
            Some(KeyRemark { key, remark })
        })
        .collect())
}

fn populate_remarks(
    app: &tauri::AppHandle,
    state: &RemoteCpaState,
    target: &Target,
    local: bool,
    document: &mut Document,
) {
    match read_remarks(app, state, target, local, document) {
        Ok(remarks) => document.remarks = remarks,
        Err(_) => document.remarks_unavailable = true,
    }
}

fn parse_settings(yaml: &str) -> Result<crate::CoreConfigSettings, String> {
    let value = serde_norway::from_str(yaml).map_err(|_| "Invalid configuration YAML")?;
    crate::core_config_settings_from_value(&value)
}

fn save_remarks(
    app: &tauri::AppHandle,
    state: &RemoteCpaState,
    target: &Target,
    local: bool,
    keys: &[String],
    updates: &[KeyRemark],
) -> Result<(), String> {
    let updates: Vec<_> = updates
        .iter()
        .filter(|entry| keys.contains(&entry.key))
        .collect();
    if updates.is_empty() {
        return Ok(());
    }
    for entry in &updates {
        crate::validate_api_key_remark(&entry.remark)?;
    }
    if local {
        app.state::<GuiConfigState>().update(|config| {
            if updates
                .iter()
                .any(|update| !config.api_keys.iter().any(|entry| entry.key == update.key))
            {
                return Err("Client key metadata is out of date".into());
            }
            for entry in &mut config.api_keys {
                if let Some(update) = updates.iter().find(|update| entry.key == update.key) {
                    entry.remark.clone_from(&update.remark);
                }
            }
            Ok(())
        })?;
    } else {
        let path = remarks_path(state, target)?;
        let mut remarks = TargetRemarks::load(&path)?;
        for entry in updates {
            let hash = crate::sha256_bytes(entry.key.as_bytes());
            if entry.remark.is_empty() {
                remarks.client_keys.remove(&hash);
            } else {
                remarks.client_keys.insert(hash, entry.remark.clone());
            }
        }
        remarks.save(&path)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn read_cpa_config_document(
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteCpaState>,
    revision: u32,
) -> Result<Document, DocumentError> {
    let mut selection = state.selection.lock().await;
    let (target, local_pid) = selected_target(&app, &mut selection, revision)?;
    let mut document = read_yaml(&target).await?;
    populate_remarks(&app, &state, &target, local_pid.is_some(), &mut document);
    selection.config_verification_revision = None;
    Ok(document)
}

fn local_changes(before: &str, after: &str) -> Result<(bool, Option<String>), DocumentError> {
    let before: Value = serde_norway::from_str(before).map_err(|_| DocumentError::Rejected)?;
    let after: Value = serde_norway::from_str(after).map_err(|_| DocumentError::Rejected)?;
    let (before, after) = (
        before.as_mapping().ok_or(DocumentError::Rejected)?,
        after.as_mapping().ok_or(DocumentError::Rejected)?,
    );
    let field_changed = |path: &[&str], legacy: &[&str]| {
        crate::nested_yaml_value(before, path).or_else(|| crate::nested_yaml_value(before, legacy))
            != crate::nested_yaml_value(after, path)
                .or_else(|| crate::nested_yaml_value(after, legacy))
    };
    let restart = field_changed(&["server", "host"], &["host"])
        || field_changed(&["server", "port"], &["port"])
        || field_changed(&["server", "tls"], &["tls"])
        || field_changed(&["server", "commercial-mode"], &["commercial-mode"]);
    let before_key =
        crate::extract_core_management_secret_key(before).map_err(|_| DocumentError::Rejected)?;
    let after_key =
        crate::extract_core_management_secret_key(after).map_err(|_| DocumentError::Rejected)?;
    let key_override = (before_key != after_key).then(|| {
        after_key
            .filter(|key| !crate::is_hashed_management_secret_key(key))
            .unwrap_or_default()
    });
    Ok((restart, key_override))
}

pub(crate) async fn put_yaml(
    target: &Target,
    etag: &str,
    yaml: String,
) -> Result<Option<header::HeaderValue>, DocumentError> {
    let response = target
        .request(Method::PUT, CONFIG_ROUTE)
        .map_err(|_| DocumentError::Unavailable)?
        .header(header::IF_MATCH, etag)
        .header(header::CONTENT_TYPE, "application/yaml")
        .body(yaml)
        .send()
        .await
        .map_err(|_| DocumentError::VerifyRequired)?;
    match response.status() {
        StatusCode::OK | StatusCode::NO_CONTENT => Ok(config_etag(&response).ok()),
        StatusCode::PRECONDITION_FAILED => Err(DocumentError::Conflict),
        StatusCode::BAD_REQUEST
        | StatusCode::UNPROCESSABLE_ENTITY
        | StatusCode::PAYLOAD_TOO_LARGE => Err(DocumentError::Rejected),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => {
            Err(DocumentError::Unavailable)
        }
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED => Err(DocumentError::Unsupported),
        _ => Err(DocumentError::VerifyRequired),
    }
}

#[tauri::command]
pub(crate) async fn save_cpa_config_document(
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteCpaState>,
    revision: u32,
    etag: String,
    yaml: String,
    remarks: Vec<KeyRemark>,
) -> Result<SaveResult, DocumentError> {
    let mut selection = state.selection.lock().await;
    let (target, local_pid) = selected_target(&app, &mut selection, revision)?;
    let local = local_pid.is_some();
    if selection.config_verification_revision == Some(revision) {
        return Err(DocumentError::VerifyRequired);
    }
    let before = read_yaml(&target).await?;
    let current_etag = before.etag.as_deref().ok_or(DocumentError::ReadOnly)?;
    if current_etag != etag {
        return Err(DocumentError::Conflict);
    }
    let changed = before.yaml != yaml;
    let (restart_required, key_override) = if changed && local {
        local_changes(&before.yaml, &yaml)?
    } else {
        (false, None)
    };
    if let Some(key) = key_override.as_deref().filter(|key| !key.is_empty()) {
        crate::validate_strong_management_secret_key(key).map_err(|_| DocumentError::Rejected)?;
    }
    let mut sync_failed = false;
    let mut readback_changed = false;
    let mut document = if changed {
        let saved_etag = match put_yaml(&target, current_etag, yaml).await {
            Ok(saved_etag) => saved_etag,
            Err(error) => {
                if matches!(error, DocumentError::VerifyRequired) {
                    selection.config_verification_revision = Some(revision);
                }
                return Err(error);
            }
        };
        selection.keys_etag = None;
        if restart_required {
            selection.config_listener_restart_pid = local_pid;
        }
        let replacement = key_override
            .as_deref()
            .filter(|key| !key.is_empty())
            .and_then(|key| Target::new(target.endpoint.as_str(), key).ok());
        let mut readback = read_yaml(replacement.as_ref().unwrap_or(&target))
            .await
            .ok();
        let replacement_verified = replacement.is_some() && readback.is_some();
        if readback.is_none() && replacement.is_some() {
            readback = read_yaml(&target).await.ok();
        }
        readback_changed = saved_etag
            .as_ref()
            .and_then(|value| value.to_str().ok())
            .zip(readback.as_ref().and_then(|value| value.etag.as_deref()))
            .is_some_and(|(saved, read)| saved != read);
        if local {
            let settings = match &readback {
                Some(value) => parse_settings(&value.yaml),
                None => crate::read_installed_core_config_settings(),
            };
            sync_failed = settings
                .and_then(|settings| {
                    let key_override =
                        if readback_changed && key_override.is_some() && !replacement_verified {
                            match settings.management_secret_key.as_deref() {
                                Some(key) if !crate::is_hashed_management_secret_key(key) => None,
                                _ => Some(""),
                            }
                        } else {
                            key_override.as_deref()
                        };
                    app.state::<GuiConfigState>().sync_core_settings_internal(
                        &settings,
                        None,
                        true,
                        true,
                        key_override,
                    )
                })
                .is_err();
            if let Some(cache) = app.try_state::<crate::AgentConfigStatusCache>() {
                sync_failed |= cache.clear().is_err();
            }
        }
        if readback.is_none() {
            selection.config_verification_revision = Some(revision);
        }
        readback
    } else {
        Some(before)
    };
    let remarks_failed = !remarks.is_empty()
        && match &document {
            _ if readback_changed => true,
            Some(value) => parse_settings(&value.yaml)
                .and_then(|settings| {
                    save_remarks(&app, &state, &target, local, &settings.api_keys, &remarks)
                })
                .is_err(),
            None if local => crate::read_installed_core_config_settings()
                .and_then(|settings| {
                    save_remarks(&app, &state, &target, local, &settings.api_keys, &remarks)
                })
                .is_err(),
            None => true,
        };
    if let Some(value) = &mut document {
        populate_remarks(&app, &state, &target, local, value);
    }
    Ok(SaveResult {
        document,
        restart_required,
        sync_failed,
        remarks_failed,
        readback_changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn local_connection_changes_keep_or_replace_the_cached_plaintext() {
        let previous = "server: {port: 8317}\nmanagement: {secret-key: '$2a$old'}\n";
        assert_eq!(local_changes(previous, previous).unwrap(), (false, None));
        assert_eq!(
            local_changes(previous, &previous.replace("8317", "8318")).unwrap(),
            (true, None)
        );
        assert_eq!(
            local_changes(previous, &previous.replace("$2a$old", "new-plaintext")).unwrap(),
            (false, Some("new-plaintext".into()))
        );
        assert_eq!(
            local_changes(previous, &previous.replace("$2a$old", "$2b$new")).unwrap(),
            (false, Some(String::new()))
        );
        assert_eq!(
            local_changes(previous, "server: {port: 8317}\n").unwrap(),
            (false, Some(String::new()))
        );
    }

    #[tokio::test]
    async fn weak_etag_is_read_only_and_interrupted_write_is_uncertain() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = Target::new(
            &format!("http://{}/prefix/", listener.local_addr().unwrap()),
            "test-key",
        )
        .unwrap();
        let strong = format!("\"{}\"", "a".repeat(64));
        let expected = strong.clone();
        let server = tokio::spawn(async move {
            for expected_method in ["GET", "PUT"] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                loop {
                    let mut chunk = [0; 1024];
                    let size = socket.read(&mut chunk).await.unwrap();
                    assert_ne!(size, 0);
                    request.extend_from_slice(&chunk[..size]);
                    if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.starts_with(&format!(
                    "{expected_method} /prefix/v8/management/config.yaml "
                )));
                assert!(request.contains("authorization: Bearer test-key\r\n"));
                if expected_method == "GET" {
                    let response = format!("HTTP/1.1 200 OK\r\nConnection: close\r\nETag: W/{expected}\r\nContent-Length: 3\r\n\r\n{{}}\n");
                    socket.write_all(response.as_bytes()).await.unwrap();
                } else {
                    assert!(request.contains(&format!("if-match: {expected}\r\n")));
                    assert!(request.contains("content-type: application/yaml\r\n"));
                }
            }
        });
        let document = read_yaml(&target).await.unwrap();
        assert_eq!(document.yaml, "{}\n");
        assert!(document.etag.is_none());
        assert_eq!(
            put_yaml(&target, &strong, "{}\n".into()).await,
            Err(DocumentError::VerifyRequired)
        );
        server.await.unwrap();
    }
}
