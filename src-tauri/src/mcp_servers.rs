use super::*;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServer {
    pub id: String,
    pub name: String,
    pub transport: String, /* "stdio" | "sse" | "http" */
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportResult {
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

fn mcp_servers_file_path() -> Result<PathBuf, String> {
    let dir = core_base_dir()?;
    Ok(dir.join("mcp-servers.json"))
}

pub(crate) fn read_servers_from_path(path: &Path) -> Result<Vec<McpServer>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(path).map_err(|e| format!("Failed to read MCP servers file: {e}"))?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str::<Vec<McpServer>>(trimmed)
        .map_err(|e| format!("Corrupt MCP servers file: {e}"))
}

pub(crate) fn write_servers_to_path(path: &Path, servers: &[McpServer]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(servers)
        .map_err(|e| format!("Failed to serialize MCP servers: {e}"))?;
    write_bytes_atomically(path, &bytes)
}

pub(crate) fn read_servers() -> Result<Vec<McpServer>, String> {
    let path = mcp_servers_file_path()?;
    read_servers_from_path(&path)
}

pub(crate) fn write_servers(servers: &[McpServer]) -> Result<(), String> {
    let path = mcp_servers_file_path()?;
    write_servers_to_path(&path, servers)
}

pub(crate) fn generate_slug(name: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    let cleaned = if trimmed.is_empty() { "server" } else { trimmed };
    let mut base = format!("mcp-{}", cleaned);
    if base.len() > 48 {
        base.truncate(48);
        base = base.trim_end_matches('-').to_string();
    }
    base
}

pub(crate) fn deduplicate_id(base: &str, existing_ids: &[String]) -> String {
    if !existing_ids.iter().any(|id| id == base) {
        return base.to_string();
    }
    let mut counter = 2;
    loop {
        let candidate = format!("{}-{}", base, counter);
        if !existing_ids.iter().any(|id| id == &candidate) {
            return candidate;
        }
        counter += 1;
    }
}

pub(crate) fn validate_server(server: &McpServer, existing_servers: &[McpServer]) -> Result<(), String> {
    if server.name.is_empty() {
        return Err("Server name cannot be empty".to_string());
    }
    if server.name.chars().count() > 80 {
        return Err("Server name cannot exceed 80 characters".to_string());
    }

    let is_update = existing_servers.iter().any(|s| s.id == server.id);
    if !is_update && existing_servers.len() >= 200 {
        return Err("Cannot exceed 200 MCP servers".to_string());
    }

    if existing_servers.iter().any(|s| s.id != server.id && s.name.eq_ignore_ascii_case(&server.name)) {
        return Err(format!("Server name '{}' already exists", server.name));
    }

    match server.transport.as_str() {
        "stdio" => {
            match &server.command {
                Some(cmd) if !cmd.trim().is_empty() => {}
                _ => return Err("stdio transport requires a command".to_string()),
            }
        }
        "sse" | "http" => {
            match &server.url {
                Some(url) if !url.trim().is_empty() => {}
                _ => return Err(format!("{} transport requires a url", server.transport)),
            }
        }
        other => {
            return Err(format!("Unsupported transport: '{other}'. Expected stdio, sse, or http"));
        }
    }

    if server.args.len() > 100 {
        return Err("Cannot exceed 100 args".to_string());
    }
    if server.env.len() > 50 {
        return Err("Cannot exceed 50 env entries".to_string());
    }
    if server.headers.len() > 50 {
        return Err("Cannot exceed 50 header entries".to_string());
    }

    for (k, v) in &server.env {
        if k.len() > 8192 || v.len() > 8192 {
            return Err("Env key or value exceeds 8192 characters".to_string());
        }
    }
    for (k, v) in &server.headers {
        if k.len() > 8192 || v.len() > 8192 {
            return Err("Header key or value exceeds 8192 characters".to_string());
        }
    }

    Ok(())
}

fn sanitize_server(mut server: McpServer) -> McpServer {
    server.name = server.name.trim().to_string();
    server.id = server.id.trim().to_string();
    server.transport = server.transport.trim().to_lowercase();
    server.command = server.command.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    server.url = server.url.map(|u| u.trim().to_string()).filter(|u| !u.is_empty());
    server.description = server.description.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    server
}

pub(crate) fn save_mcp_server_to_path(path: &Path, server: McpServer) -> Result<McpServer, String> {
    let mut servers = read_servers_from_path(path)?;
    let mut sanitized = sanitize_server(server);

    if sanitized.id.is_empty() {
        let slug = generate_slug(&sanitized.name);
        let existing_ids: Vec<String> = servers.iter().map(|s| s.id.clone()).collect();
        sanitized.id = deduplicate_id(&slug, &existing_ids);
    }

    validate_server(&sanitized, &servers)?;

    if let Some(pos) = servers.iter().position(|s| s.id == sanitized.id) {
        servers[pos] = sanitized.clone();
    } else {
        servers.push(sanitized.clone());
    }

    write_servers_to_path(path, &servers)?;
    Ok(sanitized)
}

#[tauri::command]
pub(crate) fn list_mcp_servers() -> Result<Vec<McpServer>, String> {
    let path = mcp_servers_file_path()?;
    list_mcp_servers_from_path(&path)
}

pub(crate) fn list_mcp_servers_from_path(path: &Path) -> Result<Vec<McpServer>, String> {
    let mut servers = read_servers_from_path(path)?;
    servers.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(servers)
}

#[tauri::command]
pub(crate) fn save_mcp_server(server: McpServer) -> Result<McpServer, String> {
    let path = mcp_servers_file_path()?;
    save_mcp_server_to_path(&path, server)
}

#[allow(dead_code)]
pub(crate) fn delete_mcp_server_from_path(path: &Path, id: &str) -> Result<(), String> {
    let mut servers = read_servers_from_path(path)?;
    let initial_len = servers.len();
    servers.retain(|s| s.id != id);
    if servers.len() == initial_len {
        return Err(format!("MCP server with id '{id}' not found"));
    }
    write_servers_to_path(path, &servers)
}

#[tauri::command]
pub(crate) fn delete_mcp_server(id: String) -> Result<(), String> {
    let mut servers = read_servers()?;
    let initial_len = servers.len();
    servers.retain(|s| s.id != id);
    if servers.len() == initial_len {
        return Err(format!("MCP server with id '{id}' not found"));
    }
    write_servers(&servers)
}

#[allow(dead_code)]
pub(crate) fn set_mcp_server_enabled_at_path(path: &Path, id: &str, enabled: bool) -> Result<McpServer, String> {
    let mut servers = read_servers_from_path(path)?;
    let server = servers
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("MCP server with id '{id}' not found"))?;
    server.enabled = enabled;
    let updated = server.clone();
    write_servers_to_path(path, &servers)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn set_mcp_server_enabled(id: String, enabled: bool) -> Result<McpServer, String> {
    let mut servers = read_servers()?;
    let server = servers
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("MCP server with id '{id}' not found"))?;
    server.enabled = enabled;
    let updated = server.clone();
    write_servers(&servers)?;
    Ok(updated)
}

pub(crate) fn export_mcp_servers_from_list(servers: &[McpServer]) -> Result<String, String> {
    let mut mcp_servers_map = serde_json::Map::new();
    for server in servers {
        let mut entry = serde_json::Map::new();
        entry.insert("type".to_string(), Value::String(server.transport.clone()));
        if let Some(cmd) = &server.command {
            if !cmd.trim().is_empty() {
                entry.insert("command".to_string(), Value::String(cmd.clone()));
            }
        }
        if !server.args.is_empty() {
            entry.insert("args".to_string(), serde_json::to_value(&server.args).map_err(|e| e.to_string())?);
        }
        if !server.env.is_empty() {
            entry.insert("env".to_string(), serde_json::to_value(&server.env).map_err(|e| e.to_string())?);
        }
        if let Some(url) = &server.url {
            if !url.trim().is_empty() {
                entry.insert("url".to_string(), Value::String(url.clone()));
            }
        }
        if !server.headers.is_empty() {
            entry.insert("headers".to_string(), serde_json::to_value(&server.headers).map_err(|e| e.to_string())?);
        }
        mcp_servers_map.insert(server.name.clone(), Value::Object(entry));
    }

    let mut root = serde_json::Map::new();
    root.insert("mcpServers".to_string(), Value::Object(mcp_servers_map));
    serde_json::to_string_pretty(&root).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn export_mcp_servers_json() -> Result<String, String> {
    let servers = read_servers()?;
    export_mcp_servers_from_list(&servers)
}

pub(crate) fn import_mcp_servers_json_to_path(path: &Path, raw: String) -> Result<ImportResult, String> {
    if raw.len() > 1024 * 1024 {
        return Err("Payload exceeds 1 MiB limit".to_string());
    }

    let parsed: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse JSON: {e}"))?;

    let mut entries: Vec<(String, Value)> = Vec::new();

    if let Some(root_obj) = parsed.as_object() {
        if let Some(mcp_servers_val) = root_obj.get("mcpServers") {
            if let Some(mcp_obj) = mcp_servers_val.as_object() {
                for (name, val) in mcp_obj {
                    entries.push((name.clone(), val.clone()));
                }
            } else if let Some(mcp_arr) = mcp_servers_val.as_array() {
                for val in mcp_arr {
                    let name = val.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    entries.push((name, val.clone()));
                }
            }
        } else {
            // bare map name -> config
            for (name, val) in root_obj {
                entries.push((name.clone(), val.clone()));
            }
        }
    } else if let Some(arr) = parsed.as_array() {
        for val in arr {
            let name = val.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            entries.push((name, val.clone()));
        }
    } else {
        return Err("JSON payload must be an object or array".to_string());
    }

    let mut servers = read_servers_from_path(path)?;
    let mut result = ImportResult::default();

    for (fallback_name, val) in entries {
        let obj = match val.as_object() {
            Some(o) => o,
            None => {
                let name = if fallback_name.is_empty() { "unnamed" } else { &fallback_name };
                result.skipped += 1;
                result.errors.push(format!("{name}: entry must be a JSON object"));
                continue;
            }
        };

        let explicit_name = obj.get("name").and_then(|n| n.as_str()).map(|s| s.to_string());
        let name = explicit_name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(fallback_name)
            .trim()
            .to_string();

        let transport = obj
            .get("type")
            .or_else(|| obj.get("transport"))
            .and_then(|v| v.as_str())
            .unwrap_or("stdio")
            .trim()
            .to_lowercase();

        let command = obj.get("command").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let url = obj.get("url").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let description = obj.get("description").and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let enabled = obj.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);

        let mut args = Vec::new();
        if let Some(args_val) = obj.get("args") {
            if let Some(args_arr) = args_val.as_array() {
                for a in args_arr {
                    if let Some(s) = a.as_str() {
                        args.push(s.to_string());
                    }
                }
            }
        }

        let mut env = BTreeMap::new();
        if let Some(env_val) = obj.get("env") {
            if let Some(env_obj) = env_val.as_object() {
                for (k, v) in env_obj {
                    let val_str = if let Some(s) = v.as_str() {
                        s.to_string()
                    } else if v.is_null() {
                        String::new()
                    } else {
                        v.to_string()
                    };
                    env.insert(k.clone(), val_str);
                }
            }
        }

        let mut headers = BTreeMap::new();
        if let Some(headers_val) = obj.get("headers") {
            if let Some(headers_obj) = headers_val.as_object() {
                for (k, v) in headers_obj {
                    let val_str = if let Some(s) = v.as_str() {
                        s.to_string()
                    } else if v.is_null() {
                        String::new()
                    } else {
                        v.to_string()
                    };
                    headers.insert(k.clone(), val_str);
                }
            }
        }

        let existing_index = servers.iter().position(|s| s.name.eq_ignore_ascii_case(&name));
        let id = match existing_index {
            Some(idx) => servers[idx].id.clone(),
            None => {
                let slug = generate_slug(&name);
                let existing_ids: Vec<String> = servers.iter().map(|s| s.id.clone()).collect();
                deduplicate_id(&slug, &existing_ids)
            }
        };

        let candidate = McpServer {
            id,
            name: name.clone(),
            transport,
            command,
            args,
            env,
            url,
            headers,
            enabled,
            description,
        };

        if let Err(reason) = validate_server(&candidate, &servers) {
            let label = if name.is_empty() { "unnamed" } else { &name };
            result.skipped += 1;
            result.errors.push(format!("{label}: {reason}"));
            continue;
        }

        match existing_index {
            Some(idx) => {
                servers[idx] = candidate;
                result.updated += 1;
            }
            None => {
                servers.push(candidate);
                result.added += 1;
            }
        }
    }

    write_servers_to_path(path, &servers)?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn import_mcp_servers_json(raw: String) -> Result<ImportResult, String> {
    let path = mcp_servers_file_path()?;
    import_mcp_servers_json_to_path(&path, raw)
}

#[tauri::command]
pub(crate) fn open_mcp_skills_directory() -> Result<(), String> {
    let path = core_base_dir()?;
    fs::create_dir_all(&path).map_err(|e| format!("Failed to create core directory: {e}"))?;
    super::management_api::open_directory_in_file_manager(&path)
}

fn home_directory() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn read_openclaw_config(path: &Path) -> Result<serde_json::Map<String, Value>, String> {
    if !path.exists() {
        return Ok(serde_json::Map::new());
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read OpenClaw config file: {e}"))?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(serde_json::Map::new());
    }
    let parsed: Value = serde_json::from_str(trimmed)
        .or_else(|_| json5::from_str(trimmed))
        .map_err(|e| format!("Corrupt OpenClaw configuration file: {e}"))?;
    match parsed {
        Value::Object(map) => Ok(map),
        _ => Err("Corrupt OpenClaw configuration file: root must be an object".to_string()),
    }
}

fn write_openclaw_config(path: &Path, root: &serde_json::Map<String, Value>) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(&Value::Object(root.clone()))
        .map_err(|e| format!("Failed to serialize OpenClaw configuration: {e}"))?;
    write_bytes_atomically(path, &bytes)
}

pub(crate) fn sync_mcp_server_to_openclaw_config(
    server: &McpServer,
    config_path: &Path,
) -> Result<String, String> {
    let sanitized_name = server.name.trim();
    if sanitized_name.is_empty() {
        return Err("Server name cannot be empty".to_string());
    }
    if sanitized_name == "__proto__" {
        return Err("Server name cannot be '__proto__'".to_string());
    }

    let transport = server.transport.trim().to_lowercase();
    let mut server_obj = serde_json::Map::new();

    match transport.as_str() {
        "stdio" => {
            let command = match &server.command {
                Some(cmd) if !cmd.trim().is_empty() => cmd.trim().to_string(),
                _ => return Err("stdio transport requires a command".to_string()),
            };
            server_obj.insert("command".to_string(), Value::String(command));
            server_obj.insert(
                "args".to_string(),
                serde_json::to_value(&server.args).map_err(|e| e.to_string())?,
            );
            server_obj.insert(
                "env".to_string(),
                serde_json::to_value(&server.env).map_err(|e| e.to_string())?,
            );
            server_obj.insert("enabled".to_string(), Value::Bool(server.enabled));
        }
        "http" | "sse" => {
            let url = match &server.url {
                Some(u) if !u.trim().is_empty() => u.trim().to_string(),
                _ => return Err(format!("{transport} transport requires a url")),
            };
            let mapped_transport = if transport == "http" {
                "streamable-http"
            } else {
                "sse"
            };
            server_obj.insert("url".to_string(), Value::String(url));
            server_obj.insert(
                "transport".to_string(),
                Value::String(mapped_transport.to_string()),
            );
            server_obj.insert(
                "headers".to_string(),
                serde_json::to_value(&server.headers).map_err(|e| e.to_string())?,
            );
            server_obj.insert("enabled".to_string(), Value::Bool(server.enabled));
        }
        other => {
            return Err(format!(
                "Unsupported transport: '{other}'. Expected stdio, sse, or http"
            ));
        }
    }

    let mut root = read_openclaw_config(config_path)?;
    let mcp = ensure_json_object_entry(&mut root, "mcp");
    let servers = ensure_json_object_entry(mcp, "servers");
    servers.insert(sanitized_name.to_string(), Value::Object(server_obj));

    write_openclaw_config(config_path, &root)?;
    Ok(config_path.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn sync_mcp_server_to_openclaw(id: String) -> Result<String, String> {
    let servers = read_servers()?;
    let server = servers
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("MCP server with id '{id}' not found"))?;

    let home = home_directory().ok_or_else(|| "Failed to resolve home directory".to_string())?;
    let config_path = openclaw_agent_config_path(&home);
    sync_mcp_server_to_openclaw_config(&server, &config_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_test_dir(name: &str) -> PathBuf {
        let unique = format!("cpa_test_mcp_{}_{}", name, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let dir = std::env::temp_dir().join(unique);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn slug_generation() {
        assert_eq!(generate_slug("My Server"), "mcp-my-server");
        assert_eq!(generate_slug("Special @#$ Chars!!"), "mcp-special-chars");
        assert_eq!(generate_slug("collapse---repeats"), "mcp-collapse-repeats");
        assert_eq!(generate_slug(""), "mcp-server");

        let long_name = "a".repeat(100);
        let long_slug = generate_slug(&long_name);
        assert!(long_slug.len() <= 48);
        assert!(long_slug.starts_with("mcp-"));

        let existing = vec!["mcp-server".to_string(), "mcp-server-2".to_string()];
        let dedup = deduplicate_id("mcp-server", &existing);
        assert_eq!(dedup, "mcp-server-3");
    }

    #[test]
    fn stdio_missing_command_error() {
        let dir = temp_test_dir("stdio_missing_cmd");
        let file_path = dir.join("mcp-servers.json");

        let server = McpServer {
            id: String::new(),
            name: "Test stdio".to_string(),
            transport: "stdio".to_string(),
            command: None,
            args: vec![],
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            enabled: true,
            description: None,
        };

        let err = save_mcp_server_to_path(&file_path, server).unwrap_err();
        assert!(err.contains("stdio transport requires a command"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn http_missing_url_error() {
        let dir = temp_test_dir("http_missing_url");
        let file_path = dir.join("mcp-servers.json");

        let server = McpServer {
            id: String::new(),
            name: "Test http".to_string(),
            transport: "http".to_string(),
            command: None,
            args: vec![],
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            enabled: true,
            description: None,
        };

        let err = save_mcp_server_to_path(&file_path, server).unwrap_err();
        assert!(err.contains("http transport requires a url"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_name_rejection() {
        let dir = temp_test_dir("dup_name");
        let file_path = dir.join("mcp-servers.json");

        let server1 = McpServer {
            id: "id-1".to_string(),
            name: "Same Name".to_string(),
            transport: "stdio".to_string(),
            command: Some("echo".to_string()),
            args: vec![],
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            enabled: true,
            description: None,
        };

        let res1 = save_mcp_server_to_path(&file_path, server1);
        assert!(res1.is_ok());

        let server2 = McpServer {
            id: "id-2".to_string(),
            name: "Same Name".to_string(),
            transport: "stdio".to_string(),
            command: Some("echo".to_string()),
            args: vec![],
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            enabled: true,
            description: None,
        };

        let err = save_mcp_server_to_path(&file_path, server2).unwrap_err();
        assert!(err.contains("already exists"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_from_claude_desktop_map_shape() {
        let dir = temp_test_dir("claude_map");
        let file_path = dir.join("mcp-servers.json");

        let json = r#"{
            "mcpServers": {
                "filesystem": {
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem"],
                    "env": { "DIR": "/test" }
                },
                "remote-server": {
                    "type": "sse",
                    "url": "https://example.com/sse",
                    "headers": { "Authorization": "Bearer token" }
                }
            }
        }"#;

        let result = import_mcp_servers_json_to_path(&file_path, json.to_string()).unwrap();
        assert_eq!(result.added, 2);
        assert_eq!(result.updated, 0);
        assert_eq!(result.skipped, 0);
        assert!(result.errors.is_empty());

        let loaded = read_servers_from_path(&file_path).unwrap();
        assert_eq!(loaded.len(), 2);

        let fs_srv = loaded.iter().find(|s| s.name == "filesystem").unwrap();
        assert_eq!(fs_srv.transport, "stdio");
        assert_eq!(fs_srv.command, Some("npx".to_string()));
        assert_eq!(fs_srv.args, vec!["-y", "@modelcontextprotocol/server-filesystem"]);
        assert_eq!(fs_srv.env.get("DIR").map(|s| s.as_str()), Some("/test"));

        let remote_srv = loaded.iter().find(|s| s.name == "remote-server").unwrap();
        assert_eq!(remote_srv.transport, "sse");
        assert_eq!(remote_srv.url, Some("https://example.com/sse".to_string()));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_from_array_with_one_invalid_entry_counted_as_skipped() {
        let dir = temp_test_dir("array_invalid_entry");
        let file_path = dir.join("mcp-servers.json");

        let json = r#"[
            {
                "name": "valid-stdio",
                "type": "stdio",
                "command": "echo"
            },
            {
                "name": "invalid-stdio",
                "type": "stdio"
            },
            {
                "name": "valid-http",
                "type": "http",
                "url": "https://api.example.com"
            }
        ]"#;

        let result = import_mcp_servers_json_to_path(&file_path, json.to_string()).unwrap();
        assert_eq!(result.added, 2);
        assert_eq!(result.updated, 0);
        assert_eq!(result.skipped, 1);
        assert_eq!(result.errors.len(), 1);
        assert!(result.errors[0].contains("invalid-stdio"));
        assert!(result.errors[0].contains("stdio transport requires a command"));

        let loaded = read_servers_from_path(&file_path).unwrap();
        assert_eq!(loaded.len(), 2);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_round_trip_re_importable() {
        let dir = temp_test_dir("export_round_trip");
        let file_path = dir.join("mcp-servers.json");

        let s1 = McpServer {
            id: "mcp-local".to_string(),
            name: "Local Service".to_string(),
            transport: "stdio".to_string(),
            command: Some("run-server".to_string()),
            args: vec!["--port".to_string(), "8080".to_string()],
            env: BTreeMap::from([("KEY".to_string(), "VAL".to_string())]),
            url: None,
            headers: BTreeMap::new(),
            enabled: true,
            description: Some("Description here".to_string()),
        };

        let s2 = McpServer {
            id: "mcp-remote".to_string(),
            name: "Remote API".to_string(),
            transport: "http".to_string(),
            command: None,
            args: vec![],
            env: BTreeMap::new(),
            url: Some("https://example.com/mcp".to_string()),
            headers: BTreeMap::from([("X-Token".to_string(), "secret".to_string())]),
            enabled: true,
            description: None,
        };

        write_servers_to_path(&file_path, &[s1.clone(), s2.clone()]).unwrap();
        let loaded_for_export = read_servers_from_path(&file_path).unwrap();
        let exported_json = export_mcp_servers_from_list(&loaded_for_export).unwrap();

        let dir2 = temp_test_dir("export_round_trip_target");
        let file_path2 = dir2.join("mcp-servers.json");

        let import_res = import_mcp_servers_json_to_path(&file_path2, exported_json).unwrap();
        assert_eq!(import_res.added, 2);
        assert_eq!(import_res.updated, 0);
        assert_eq!(import_res.skipped, 0);
        assert!(import_res.errors.is_empty());

        let imported = read_servers_from_path(&file_path2).unwrap();
        assert_eq!(imported.len(), 2);

        let local = imported.iter().find(|s| s.name == "Local Service").unwrap();
        assert_eq!(local.transport, "stdio");
        assert_eq!(local.command, Some("run-server".to_string()));
        assert_eq!(local.args, vec!["--port", "8080"]);
        assert_eq!(local.env.get("KEY").map(|s| s.as_str()), Some("VAL"));

        let remote = imported.iter().find(|s| s.name == "Remote API").unwrap();
        assert_eq!(remote.transport, "http");
        assert_eq!(remote.url, Some("https://example.com/mcp".to_string()));
        assert_eq!(remote.headers.get("X-Token").map(|s| s.as_str()), Some("secret"));

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&dir2);
    }

    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct TempHomeGuard {
        home_dir: PathBuf,
        prev_home: Option<std::ffi::OsString>,
        prev_userprofile: Option<std::ffi::OsString>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl TempHomeGuard {
        fn new(name: &str) -> Self {
            let lock = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let dir = temp_test_dir(name);
            let prev_home = std::env::var_os("HOME");
            let prev_userprofile = std::env::var_os("USERPROFILE");
            std::env::set_var("HOME", &dir);
            std::env::set_var("USERPROFILE", &dir);
            Self {
                home_dir: dir,
                prev_home,
                prev_userprofile,
                _lock: lock,
            }
        }
    }

    impl Drop for TempHomeGuard {
        fn drop(&mut self) {
            match &self.prev_home {
                Some(val) => std::env::set_var("HOME", val),
                None => std::env::remove_var("HOME"),
            }
            match &self.prev_userprofile {
                Some(val) => std::env::set_var("USERPROFILE", val),
                None => std::env::remove_var("USERPROFILE"),
            }
            let _ = fs::remove_dir_all(&self.home_dir);
        }
    }

    #[test]
    fn sync_creates_mcp_servers_without_dropping_unrelated_keys() {
        let guard = TempHomeGuard::new("sync_preserves_keys");
        let openclaw_dir = guard.home_dir.join(".openclaw");
        fs::create_dir_all(&openclaw_dir).unwrap();
        let config_file = openclaw_dir.join("openclaw.json");

        let initial_json = r#"{
            "unrelated_root": 42,
            "mcp": {
                "unrelated_mcp_key": "persisted",
                "servers": {
                    "existing_server": {
                        "command": "cat",
                        "args": ["-n"],
                        "env": {"TEST_VAR": "true"},
                        "enabled": true
                    }
                }
            }
        }"#;
        fs::write(&config_file, initial_json).unwrap();

        let stdio_server = McpServer {
            id: "mcp-test-stdio".to_string(),
            name: "test-stdio".to_string(),
            transport: "stdio".to_string(),
            command: Some("npx".to_string()),
            args: vec!["-y".to_string(), "test-pkg".to_string()],
            env: BTreeMap::from([("ENV_KEY".to_string(), "env_val".to_string())]),
            url: None,
            headers: BTreeMap::new(),
            enabled: true,
            description: None,
        };

        let resolved_path = sync_mcp_server_to_openclaw_config(&stdio_server, &config_file).unwrap();
        assert_eq!(resolved_path, config_file.to_string_lossy().to_string());

        let http_server = McpServer {
            id: "mcp-test-http".to_string(),
            name: "test-http".to_string(),
            transport: "http".to_string(),
            command: None,
            args: vec![],
            env: BTreeMap::new(),
            url: Some("https://example.com/mcp-endpoint".to_string()),
            headers: BTreeMap::from([("Authorization".to_string(), "Bearer secret".to_string())]),
            enabled: false,
            description: None,
        };
        sync_mcp_server_to_openclaw_config(&http_server, &config_file).unwrap();

        let sse_server = McpServer {
            id: "mcp-test-sse".to_string(),
            name: "test-sse".to_string(),
            transport: "sse".to_string(),
            command: None,
            args: vec![],
            env: BTreeMap::new(),
            url: Some("https://example.com/sse-endpoint".to_string()),
            headers: BTreeMap::new(),
            enabled: true,
            description: None,
        };
        sync_mcp_server_to_openclaw_config(&sse_server, &config_file).unwrap();

        let updated_content = fs::read_to_string(&config_file).unwrap();
        let parsed: Value = serde_json::from_str(&updated_content).unwrap();

        // Unrelated root and mcp keys preserved
        assert_eq!(parsed["unrelated_root"], 42);
        assert_eq!(parsed["mcp"]["unrelated_mcp_key"], "persisted");

        // Existing server entry preserved
        let existing = &parsed["mcp"]["servers"]["existing_server"];
        assert_eq!(existing["command"], "cat");
        assert_eq!(existing["args"], serde_json::json!(["-n"]));
        assert_eq!(existing["enabled"], true);

        // Stdio server properly mapped
        let stdio_entry = &parsed["mcp"]["servers"]["test-stdio"];
        assert_eq!(stdio_entry["command"], "npx");
        assert_eq!(stdio_entry["args"], serde_json::json!(["-y", "test-pkg"]));
        assert_eq!(stdio_entry["env"]["ENV_KEY"], "env_val");
        assert_eq!(stdio_entry["enabled"], true);
        assert!(stdio_entry.get("transport").is_none());

        // HTTP server mapped with "streamable-http"
        let http_entry = &parsed["mcp"]["servers"]["test-http"];
        assert_eq!(http_entry["url"], "https://example.com/mcp-endpoint");
        assert_eq!(http_entry["transport"], "streamable-http");
        assert_eq!(http_entry["headers"]["Authorization"], "Bearer secret");
        assert_eq!(http_entry["enabled"], false);

        // SSE server mapped with "sse"
        let sse_entry = &parsed["mcp"]["servers"]["test-sse"];
        assert_eq!(sse_entry["url"], "https://example.com/sse-endpoint");
        assert_eq!(sse_entry["transport"], "sse");
        assert_eq!(sse_entry["enabled"], true);
    }

    #[test]
    fn repeated_sync_replaces_rather_than_duplicates() {
        let guard = TempHomeGuard::new("sync_replaces");
        let openclaw_dir = guard.home_dir.join(".openclaw");
        fs::create_dir_all(&openclaw_dir).unwrap();
        let config_file = openclaw_dir.join("openclaw.json");

        let mut server = McpServer {
            id: "mcp-test-repeat".to_string(),
            name: "repeat-server".to_string(),
            transport: "stdio".to_string(),
            command: Some("cmd1".to_string()),
            args: vec!["--v1".to_string()],
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            enabled: false,
            description: None,
        };

        sync_mcp_server_to_openclaw_config(&server, &config_file).unwrap();

        let content_v1 = fs::read_to_string(&config_file).unwrap();
        let parsed_v1: Value = serde_json::from_str(&content_v1).unwrap();
        let servers_map_v1 = parsed_v1["mcp"]["servers"].as_object().unwrap();
        assert_eq!(servers_map_v1.len(), 1);
        assert_eq!(servers_map_v1["repeat-server"]["args"], serde_json::json!(["--v1"]));
        assert_eq!(servers_map_v1["repeat-server"]["enabled"], false);

        // Update server and sync again
        server.command = Some("cmd2".to_string());
        server.args = vec!["--v2".to_string()];
        server.enabled = true;

        sync_mcp_server_to_openclaw_config(&server, &config_file).unwrap();

        let content_v2 = fs::read_to_string(&config_file).unwrap();
        let parsed_v2: Value = serde_json::from_str(&content_v2).unwrap();
        let servers_map_v2 = parsed_v2["mcp"]["servers"].as_object().unwrap();
        assert_eq!(servers_map_v2.len(), 1);
        assert_eq!(servers_map_v2["repeat-server"]["command"], "cmd2");
        assert_eq!(servers_map_v2["repeat-server"]["args"], serde_json::json!(["--v2"]));
        assert_eq!(servers_map_v2["repeat-server"]["enabled"], true);
    }

    #[test]
    fn corrupt_config_returns_error_and_leaves_file_untouched() {
        let guard = TempHomeGuard::new("corrupt_config");
        let openclaw_dir = guard.home_dir.join(".openclaw");
        fs::create_dir_all(&openclaw_dir).unwrap();
        let config_file = openclaw_dir.join("openclaw.json");

        let corrupt_content = "{ corrupt json: [unclosed";
        fs::write(&config_file, corrupt_content).unwrap();

        let server = McpServer {
            id: "mcp-test".to_string(),
            name: "test-server".to_string(),
            transport: "stdio".to_string(),
            command: Some("echo".to_string()),
            args: vec![],
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            enabled: true,
            description: None,
        };

        let result = sync_mcp_server_to_openclaw_config(&server, &config_file);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Corrupt OpenClaw configuration"));

        let file_after = fs::read_to_string(&config_file).unwrap();
        assert_eq!(file_after, corrupt_content);
    }

    #[test]
    fn proto_and_empty_names_rejected() {
        let guard = TempHomeGuard::new("proto_rejected");
        let config_file = guard.home_dir.join(".openclaw").join("openclaw.json");

        let proto_server = McpServer {
            id: "mcp-proto".to_string(),
            name: "__proto__".to_string(),
            transport: "stdio".to_string(),
            command: Some("echo".to_string()),
            args: vec![],
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            enabled: true,
            description: None,
        };

        let err = sync_mcp_server_to_openclaw_config(&proto_server, &config_file).unwrap_err();
        assert!(err.contains("__proto__"));

        let empty_server = McpServer {
            id: "mcp-empty".to_string(),
            name: "   ".to_string(),
            transport: "stdio".to_string(),
            command: Some("echo".to_string()),
            args: vec![],
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            enabled: true,
            description: None,
        };

        let err2 = sync_mcp_server_to_openclaw_config(&empty_server, &config_file).unwrap_err();
        assert!(err2.contains("empty"));
        assert!(!config_file.exists());
    }

    #[test]
    fn sync_command_resolves_home_and_saves() {
        let guard = TempHomeGuard::new("cmd_sync");
        let openclaw_dir = guard.home_dir.join(".openclaw");
        fs::create_dir_all(&openclaw_dir).unwrap();
        let config_file = openclaw_dir.join("openclaw.json");

        let server = McpServer {
            id: "mcp-live-test".to_string(),
            name: "live-test".to_string(),
            transport: "stdio".to_string(),
            command: Some("echo".to_string()),
            args: vec!["hello".to_string()],
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            enabled: true,
            description: None,
        };

        // Save server using regular save_mcp_server
        let saved = save_mcp_server(server).unwrap();

        let resolved_path = sync_mcp_server_to_openclaw(saved.id.clone()).unwrap();
        assert_eq!(resolved_path, config_file.to_string_lossy().to_string());

        let parsed: Value = serde_json::from_str(&fs::read_to_string(&config_file).unwrap()).unwrap();
        assert_eq!(parsed["mcp"]["servers"]["live-test"]["command"], "echo");

        // Clean up stored server
        let _ = delete_mcp_server(saved.id);
    }
}
