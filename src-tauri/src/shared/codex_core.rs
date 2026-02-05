use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::oneshot::error::TryRecvError;
use tokio::sync::{oneshot, Mutex};
use tokio::time::timeout;
use tokio::time::Instant;

use crate::backend::app_server::WorkspaceSession;
use crate::codex::config as codex_config;
use crate::codex::home::{resolve_default_codex_home, resolve_workspace_codex_home};
use crate::files::io::read_text_file_within;
use crate::files::ops::write_with_policy;
use crate::files::policy::{policy_for, FileKind, FileScope};
use crate::rules;
use crate::shared::account::{build_account_response, read_auth_account};
use crate::types::WorkspaceEntry;

const LOGIN_START_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) enum CodexLoginCancelState {
    PendingStart(oneshot::Sender<()>),
    LoginId(String),
}

async fn get_session_clone(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: &str,
) -> Result<Arc<WorkspaceSession>, String> {
    let sessions = sessions.lock().await;
    sessions
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| "workspace not connected".to_string())
}

async fn resolve_workspace_and_parent(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
) -> Result<(WorkspaceEntry, Option<WorkspaceEntry>), String> {
    let workspaces = workspaces.lock().await;
    let entry = workspaces
        .get(workspace_id)
        .cloned()
        .ok_or_else(|| "workspace not found".to_string())?;
    let parent_entry = entry
        .parent_id
        .as_ref()
        .and_then(|parent_id| workspaces.get(parent_id))
        .cloned();
    Ok((entry, parent_entry))
}

async fn resolve_codex_home_for_workspace_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: &str,
) -> Result<PathBuf, String> {
    let (entry, parent_entry) = resolve_workspace_and_parent(workspaces, workspace_id).await?;
    resolve_workspace_codex_home(&entry, parent_entry.as_ref())
        .or_else(resolve_default_codex_home)
        .ok_or_else(|| "Unable to resolve CODEX_HOME".to_string())
}

pub(crate) async fn start_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({
        "cwd": session.entry.path,
        "approvalPolicy": "on-request"
    });
    session.send_request("thread/start", params).await
}

pub(crate) async fn resume_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id });
    session.send_request("thread/resume", params).await
}

pub(crate) async fn fork_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id });
    session.send_request("thread/fork", params).await
}

pub(crate) async fn list_threads_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "cursor": cursor, "limit": limit });
    session.send_request("thread/list", params).await
}

pub(crate) async fn list_mcp_server_status_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "cursor": cursor, "limit": limit });
    session.send_request("mcpServerStatus/list", params).await
}

pub(crate) async fn mcp_server_reload_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    session
        .send_request("config/mcpServer/reload", json!({}))
        .await
}

pub(crate) async fn mcp_server_oauth_login_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    server_name: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({
        "name": server_name,
        "serverName": server_name,
    });
    session.send_request("mcpServer/oauth/login", params).await
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerConfigEntry {
    pub(crate) name: String,
    pub(crate) enabled: bool,
}

fn parse_mcp_server_section_header(line: &str) -> Option<String> {
    // Accept:
    // - [mcp_servers.foo]
    // - [mcp_servers."foo bar"]
    let trimmed = line.trim();
    if !(trimmed.starts_with("[mcp_servers.") && trimmed.ends_with(']')) {
        return None;
    }
    let inner = trimmed
        .trim_start_matches("[mcp_servers.")
        .trim_end_matches(']');
    let inner = inner.trim();
    if inner.starts_with('"') && inner.ends_with('"') && inner.len() >= 2 {
        return Some(inner[1..inner.len() - 1].to_string());
    }
    if inner.is_empty() {
        return None;
    }
    Some(inner.to_string())
}

fn list_configured_mcp_servers_from_toml(contents: &str) -> Vec<McpServerConfigEntry> {
    // Time: O(N) lines, Space: O(S) servers.
    let mut result = Vec::new();
    let mut current: Option<String> = None;
    let mut enabled: Option<bool> = None;

    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if let Some(name) = current.take() {
                result.push(McpServerConfigEntry {
                    name,
                    enabled: enabled.unwrap_or(true),
                });
            }
            enabled = None;
            current = parse_mcp_server_section_header(trimmed);
            continue;
        }
        if current.is_none() || trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            if key.trim() != "enabled" {
                continue;
            }
            let value = value.split('#').next().unwrap_or("").trim();
            enabled = match value {
                "true" => Some(true),
                "false" => Some(false),
                _ => enabled,
            };
        }
    }
    if let Some(name) = current.take() {
        result.push(McpServerConfigEntry {
            name,
            enabled: enabled.unwrap_or(true),
        });
    }

    result.sort_by(|a, b| a.name.cmp(&b.name));
    result
}

fn normalize_mcp_server_header_name(name: &str) -> String {
    // Use quoted key to support arbitrary server names.
    format!("[mcp_servers.\"{}\"]", name.replace('"', "\\\""))
}

fn upsert_mcp_server_enabled(contents: &str, server_name: &str, enabled: bool) -> String {
    // Single-pass string patching.
    // Time: O(N) lines, Space: O(N).
    let header = normalize_mcp_server_header_name(server_name);
    let enabled_line = format!("enabled = {}", if enabled { "true" } else { "false" });

    let mut lines: Vec<String> = contents.lines().map(|l| l.to_string()).collect();
    let mut section_start: Option<usize> = None;
    let mut section_end: usize = lines.len();

    for (idx, line) in lines.iter().enumerate() {
        if line.trim() == header {
            section_start = Some(idx);
            // Find end (next table)
            for j in (idx + 1)..lines.len() {
                let t = lines[j].trim();
                if t.starts_with('[') && t.ends_with(']') {
                    section_end = j;
                    break;
                }
            }
            break;
        }
    }

    if let Some(start) = section_start {
        // Replace existing enabled line or insert near the top of the section.
        for i in (start + 1)..section_end {
            let t = lines[i].trim();
            if t.starts_with("enabled") {
                if let Some((key, _)) = t.split_once('=') {
                    if key.trim() == "enabled" {
                        lines[i] = enabled_line;
                        return lines.join("\n") + "\n";
                    }
                }
            }
        }
        lines.insert(start + 1, enabled_line);
        return lines.join("\n") + "\n";
    }

    // Append new section.
    if !lines.is_empty() && !lines.last().unwrap_or(&"".to_string()).trim().is_empty() {
        lines.push(String::new());
    }
    lines.push(header);
    lines.push(enabled_line);
    lines.join("\n") + "\n"
}

fn config_policy() -> Result<crate::files::policy::FilePolicy, String> {
    policy_for(FileScope::Global, FileKind::Config)
}

fn read_config_contents_from_root(root: &PathBuf) -> Result<Option<String>, String> {
    let policy = config_policy()?;
    let response = read_text_file_within(
        root,
        policy.filename,
        policy.root_may_be_missing,
        policy.root_context,
        policy.filename,
        policy.allow_external_symlink_target,
    )?;
    if response.exists {
        Ok(Some(response.content))
    } else {
        Ok(None)
    }
}

fn write_config_contents_to_root(root: &PathBuf, contents: &str) -> Result<(), String> {
    let policy = config_policy()?;
    write_with_policy(root, policy, contents)
}

pub(crate) async fn list_configured_mcp_servers_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
) -> Result<Vec<McpServerConfigEntry>, String> {
    let codex_home = resolve_codex_home_for_workspace_core(workspaces, &workspace_id).await?;
    let contents = read_config_contents_from_root(&codex_home)?.unwrap_or_default();
    Ok(list_configured_mcp_servers_from_toml(&contents))
}

pub(crate) async fn set_mcp_server_enabled_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    server_name: String,
    enabled: bool,
) -> Result<(), String> {
    let codex_home = resolve_codex_home_for_workspace_core(workspaces, &workspace_id).await?;
    let contents = read_config_contents_from_root(&codex_home)?.unwrap_or_default();
    let updated = upsert_mcp_server_enabled(&contents, &server_name, enabled);
    write_config_contents_to_root(&codex_home, &updated)
}

pub(crate) async fn archive_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id });
    session.send_request("thread/archive", params).await
}

pub(crate) async fn set_thread_name_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
    name: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id, "name": name });
    session.send_request("thread/name/set", params).await
}

pub(crate) async fn send_user_message_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
    text: String,
    model: Option<String>,
    effort: Option<String>,
    access_mode: Option<String>,
    images: Option<Vec<String>>,
    collaboration_mode: Option<Value>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let access_mode = access_mode.unwrap_or_else(|| "current".to_string());
    let sandbox_policy = match access_mode.as_str() {
        "full-access" => json!({ "type": "dangerFullAccess" }),
        "read-only" => json!({ "type": "readOnly" }),
        _ => json!({
            "type": "workspaceWrite",
            "writableRoots": [session.entry.path],
            "networkAccess": true
        }),
    };

    let approval_policy = if access_mode == "full-access" {
        "never"
    } else {
        "onRequest"
    };

    let trimmed_text = text.trim();
    let mut input: Vec<Value> = Vec::new();
    if !trimmed_text.is_empty() {
        input.push(json!({ "type": "text", "text": trimmed_text }));
    }
    if let Some(paths) = images {
        for path in paths {
            let trimmed = path.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed.starts_with("data:")
                || trimmed.starts_with("http://")
                || trimmed.starts_with("https://")
            {
                input.push(json!({ "type": "image", "url": trimmed }));
            } else {
                input.push(json!({ "type": "localImage", "path": trimmed }));
            }
        }
    }
    if input.is_empty() {
        return Err("empty user message".to_string());
    }

    let mut params = Map::new();
    params.insert("threadId".to_string(), json!(thread_id));
    params.insert("input".to_string(), json!(input));
    params.insert("cwd".to_string(), json!(session.entry.path));
    params.insert("approvalPolicy".to_string(), json!(approval_policy));
    params.insert("sandboxPolicy".to_string(), json!(sandbox_policy));
    params.insert("model".to_string(), json!(model));
    params.insert("effort".to_string(), json!(effort));
    if let Some(mode) = collaboration_mode {
        if !mode.is_null() {
            params.insert("collaborationMode".to_string(), mode);
        }
    }
    session
        .send_request("turn/start", Value::Object(params))
        .await
}

pub(crate) async fn collaboration_mode_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    session
        .send_request("collaborationMode/list", json!({}))
        .await
}

pub(crate) async fn turn_interrupt_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
    turn_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id, "turnId": turn_id });
    session.send_request("turn/interrupt", params).await
}

pub(crate) async fn start_review_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
    target: Value,
    delivery: Option<String>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let mut params = Map::new();
    params.insert("threadId".to_string(), json!(thread_id));
    params.insert("target".to_string(), target);
    if let Some(delivery) = delivery {
        params.insert("delivery".to_string(), json!(delivery));
    }
    session
        .send_request("review/start", Value::Object(params))
        .await
}

pub(crate) async fn model_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let mut response = session.send_request("model/list", json!({})).await?;
    if let Ok(codex_home) = resolve_codex_home_for_workspace_core(workspaces, &workspace_id).await {
        if let Some(cache_models) = read_models_cache_entries(&codex_home) {
            merge_model_cache_entries(&mut response, cache_models);
        }
    }
    Ok(response)
}

fn read_models_cache_entries(codex_home: &Path) -> Option<Vec<Value>> {
    let cache_path = codex_home.join("models_cache.json");
    let contents = std::fs::read_to_string(cache_path).ok()?;
    let parsed: Value = serde_json::from_str(&contents).ok()?;
    let models = parsed.get("models")?.as_array()?;
    let mut entries = Vec::with_capacity(models.len());
    for model in models {
        if model.get("visibility").and_then(|value| value.as_str()) != Some("list") {
            continue;
        }
        let slug = model.get("slug")?.as_str()?.trim();
        if slug.is_empty() {
            continue;
        }
        let display_name = model
            .get("display_name")
            .and_then(|value| value.as_str())
            .unwrap_or(slug);
        let description = model
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let supported_levels = model
            .get("supported_reasoning_levels")
            .and_then(|value| value.as_array())
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(|level| {
                        let effort = level.get("effort")?.as_str()?.trim();
                        if effort.is_empty() {
                            return None;
                        }
                        Some(json!({
                            "reasoning_effort": effort,
                            "description": level
                                .get("description")
                                .and_then(|value| value.as_str())
                                .unwrap_or("")
                        }))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let default_effort = model
            .get("default_reasoning_level")
            .and_then(|value| value.as_str())
            .map(|value| value.trim())
            .filter(|value| !value.is_empty());

        let mut entry = Map::new();
        entry.insert("id".to_string(), json!(slug));
        entry.insert("model".to_string(), json!(slug));
        entry.insert("displayName".to_string(), json!(display_name));
        entry.insert("description".to_string(), json!(description));
        entry.insert(
            "supported_reasoning_efforts".to_string(),
            json!(supported_levels),
        );
        if let Some(default_effort) = default_effort {
            entry.insert(
                "default_reasoning_effort".to_string(),
                json!(default_effort),
            );
        }
        entries.push(Value::Object(entry));
    }
    Some(entries)
}

fn merge_model_cache_entries(response: &mut Value, cache_entries: Vec<Value>) {
    let list_value = match response {
        Value::Object(map) => {
            if let Some(result) = map.get_mut("result") {
                match result {
                    Value::Object(result_map) => result_map.get_mut("data"),
                    _ => None,
                }
            } else {
                map.get_mut("data")
            }
        }
        _ => None,
    };
    let Some(Value::Array(list)) = list_value else {
        return;
    };

    let mut known_ids = std::collections::HashSet::with_capacity(list.len());
    for item in list.iter() {
        if let Some(id) = model_id_from_value(item) {
            known_ids.insert(id);
        }
    }

    for entry in cache_entries {
        let Some(id) = model_id_from_value(&entry) else {
            continue;
        };
        if known_ids.contains(&id) {
            continue;
        }
        known_ids.insert(id);
        list.push(entry);
    }
}

fn model_id_from_value(value: &Value) -> Option<String> {
    let obj = value.as_object()?;
    let candidate = obj
        .get("id")
        .and_then(|value| value.as_str())
        .or_else(|| obj.get("model").and_then(|value| value.as_str()))
        .or_else(|| obj.get("slug").and_then(|value| value.as_str()))?;
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) async fn account_rate_limits_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    session
        .send_request("account/rateLimits/read", Value::Null)
        .await
}

pub(crate) async fn account_read_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = {
        let sessions = sessions.lock().await;
        sessions.get(&workspace_id).cloned()
    };
    let response = if let Some(session) = session {
        session.send_request("account/read", Value::Null).await.ok()
    } else {
        None
    };

    let (entry, parent_entry) = resolve_workspace_and_parent(workspaces, &workspace_id).await?;
    let codex_home = resolve_workspace_codex_home(&entry, parent_entry.as_ref())
        .or_else(resolve_default_codex_home);
    let fallback = read_auth_account(codex_home);

    Ok(build_account_response(response, fallback))
}

pub(crate) async fn codex_login_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    codex_login_cancels: &Mutex<HashMap<String, CodexLoginCancelState>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    {
        let mut cancels = codex_login_cancels.lock().await;
        if let Some(existing) = cancels.remove(&workspace_id) {
            match existing {
                CodexLoginCancelState::PendingStart(tx) => {
                    let _ = tx.send(());
                }
                CodexLoginCancelState::LoginId(_) => {}
            }
        }
        cancels.insert(
            workspace_id.clone(),
            CodexLoginCancelState::PendingStart(cancel_tx),
        );
    }

    let start = Instant::now();
    let mut cancel_rx = cancel_rx;
    let mut login_request: Pin<Box<_>> =
        Box::pin(session.send_request("account/login/start", json!({ "type": "chatgpt" })));

    let response = loop {
        match cancel_rx.try_recv() {
            Ok(_) => {
                let mut cancels = codex_login_cancels.lock().await;
                cancels.remove(&workspace_id);
                return Err("Codex login canceled.".to_string());
            }
            Err(TryRecvError::Closed) => {
                let mut cancels = codex_login_cancels.lock().await;
                cancels.remove(&workspace_id);
                return Err("Codex login canceled.".to_string());
            }
            Err(TryRecvError::Empty) => {}
        }

        let elapsed = start.elapsed();
        if elapsed >= LOGIN_START_TIMEOUT {
            let mut cancels = codex_login_cancels.lock().await;
            cancels.remove(&workspace_id);
            return Err("Codex login start timed out.".to_string());
        }

        let tick = Duration::from_millis(150);
        let remaining = LOGIN_START_TIMEOUT.saturating_sub(elapsed);
        let wait_for = remaining.min(tick);

        match timeout(wait_for, &mut login_request).await {
            Ok(result) => break result?,
            Err(_elapsed) => continue,
        }
    };

    let payload = response.get("result").unwrap_or(&response);
    let login_id = payload
        .get("loginId")
        .or_else(|| payload.get("login_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "missing login id in account/login/start response".to_string())?;
    let auth_url = payload
        .get("authUrl")
        .or_else(|| payload.get("auth_url"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "missing auth url in account/login/start response".to_string())?;

    {
        let mut cancels = codex_login_cancels.lock().await;
        cancels.insert(
            workspace_id,
            CodexLoginCancelState::LoginId(login_id.clone()),
        );
    }

    Ok(json!({
        "loginId": login_id,
        "authUrl": auth_url,
        "raw": response,
    }))
}

pub(crate) async fn codex_login_cancel_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    codex_login_cancels: &Mutex<HashMap<String, CodexLoginCancelState>>,
    workspace_id: String,
) -> Result<Value, String> {
    let cancel_state = {
        let mut cancels = codex_login_cancels.lock().await;
        cancels.remove(&workspace_id)
    };

    let Some(cancel_state) = cancel_state else {
        return Ok(json!({ "canceled": false }));
    };

    match cancel_state {
        CodexLoginCancelState::PendingStart(cancel_tx) => {
            let _ = cancel_tx.send(());
            return Ok(json!({
                "canceled": true,
                "status": "canceled",
            }));
        }
        CodexLoginCancelState::LoginId(login_id) => {
            let session = get_session_clone(sessions, &workspace_id).await?;
            let response = session
                .send_request(
                    "account/login/cancel",
                    json!({
                        "loginId": login_id,
                    }),
                )
                .await?;

            let payload = response.get("result").unwrap_or(&response);
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let canceled = status.eq_ignore_ascii_case("canceled");

            Ok(json!({
                "canceled": canceled,
                "status": status,
                "raw": response,
            }))
        }
    }
}

pub(crate) async fn skills_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "cwd": session.entry.path });
    session.send_request("skills/list", params).await
}

pub(crate) async fn apps_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "cursor": cursor, "limit": limit });
    session.send_request("app/list", params).await
}

pub(crate) async fn respond_to_server_request_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    request_id: Value,
    result: Value,
) -> Result<(), String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    session.send_response(request_id, result).await
}

pub(crate) async fn remember_approval_rule_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
    command: Vec<String>,
) -> Result<Value, String> {
    let command = command
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    if command.is_empty() {
        return Err("empty command".to_string());
    }

    let codex_home = resolve_codex_home_for_workspace_core(workspaces, &workspace_id).await?;
    let rules_path = rules::default_rules_path(&codex_home);
    rules::append_prefix_rule(&rules_path, &command)?;

    Ok(json!({
        "ok": true,
        "rulesPath": rules_path,
    }))
}

pub(crate) async fn get_config_model_core(
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    workspace_id: String,
) -> Result<Value, String> {
    let codex_home = resolve_codex_home_for_workspace_core(workspaces, &workspace_id).await?;
    let model = codex_config::read_config_model(Some(codex_home))?;
    Ok(json!({ "model": model }))
}
