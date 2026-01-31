use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::sync::{Mutex, oneshot};
use tokio::time::timeout;

#[cfg(target_os = "windows")]
use tokio::process::Command;

use crate::backend::app_server::{build_codex_command_with_bin, WorkspaceSession};
use crate::codex::args::{apply_codex_args, resolve_workspace_codex_args};
use crate::codex::config as codex_config;
use crate::codex::home::{resolve_default_codex_home, resolve_workspace_codex_home};
use crate::rules;
use crate::shared::account::{build_account_response, read_auth_account};
use crate::types::{AppSettings, WorkspaceEntry};

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
        "approvalPolicy": "onRequest"
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

pub(crate) async fn archive_thread_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "threadId": thread_id });
    session.send_request("thread/archive", params).await
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
        if model
            .get("visibility")
            .and_then(|value| value.as_str())
            != Some("list")
        {
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
    workspaces: &Mutex<HashMap<String, WorkspaceEntry>>,
    app_settings: &Mutex<AppSettings>,
    codex_login_cancels: &Mutex<HashMap<String, oneshot::Sender<()>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let (entry, parent_entry, settings) = {
        let workspaces = workspaces.lock().await;
        let entry = workspaces
            .get(&workspace_id)
            .ok_or_else(|| "workspace not found".to_string())?
            .clone();
        let parent_entry = entry
            .parent_id
            .as_ref()
            .and_then(|parent_id| workspaces.get(parent_id))
            .cloned();
        let settings = app_settings.lock().await.clone();
        (entry, parent_entry, settings)
    };

    let codex_bin = entry
        .codex_bin
        .clone()
        .filter(|value| !value.trim().is_empty())
        .or(settings.codex_bin.clone());
    let codex_args = resolve_workspace_codex_args(&entry, parent_entry.as_ref(), Some(&settings));
    let codex_home = resolve_workspace_codex_home(&entry, parent_entry.as_ref())
        .or_else(resolve_default_codex_home);

    let mut command = build_codex_command_with_bin(codex_bin);
    if let Some(ref codex_home) = codex_home {
        command.env("CODEX_HOME", codex_home);
    }
    apply_codex_args(&mut command, codex_args.as_deref())?;
    command.arg("login");
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
    {
        let mut cancels = codex_login_cancels.lock().await;
        if let Some(existing) = cancels.remove(&workspace_id) {
            let _ = existing.send(());
        }
        cancels.insert(workspace_id.clone(), cancel_tx);
    }
    let pid = child.id();
    let canceled = Arc::new(AtomicBool::new(false));
    let canceled_for_task = Arc::clone(&canceled);
    let cancel_task = tokio::spawn(async move {
        if cancel_rx.await.is_ok() {
            canceled_for_task.store(true, Ordering::Relaxed);
            if let Some(pid) = pid {
                #[cfg(not(target_os = "windows"))]
                unsafe {
                    libc::kill(pid as i32, libc::SIGKILL);
                }
                #[cfg(target_os = "windows")]
                {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .status()
                        .await;
                }
            }
        }
    });
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        if let Some(mut stdout) = stdout_pipe {
            let _ = stdout.read_to_end(&mut buffer).await;
        }
        buffer
    });
    let stderr_task = tokio::spawn(async move {
        let mut buffer = Vec::new();
        if let Some(mut stderr) = stderr_pipe {
            let _ = stderr.read_to_end(&mut buffer).await;
        }
        buffer
    });

    let status = match timeout(Duration::from_secs(120), child.wait()).await {
        Ok(result) => result.map_err(|error| error.to_string())?,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            cancel_task.abort();
            {
                let mut cancels = codex_login_cancels.lock().await;
                cancels.remove(&workspace_id);
            }
            return Err("Codex login timed out.".to_string());
        }
    };

    cancel_task.abort();
    {
        let mut cancels = codex_login_cancels.lock().await;
        cancels.remove(&workspace_id);
    }

    if canceled.load(Ordering::Relaxed) {
        return Err("Codex login canceled.".to_string());
    }

    let stdout_bytes = match stdout_task.await {
        Ok(bytes) => bytes,
        Err(_) => Vec::new(),
    };
    let stderr_bytes = match stderr_task.await {
        Ok(bytes) => bytes,
        Err(_) => Vec::new(),
    };

    let stdout = String::from_utf8_lossy(&stdout_bytes);
    let stderr = String::from_utf8_lossy(&stderr_bytes);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    let combined = if stdout.trim().is_empty() {
        stderr.trim().to_string()
    } else if stderr.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        format!("{}\n{}", stdout.trim(), stderr.trim())
    };
    let limited = combined.chars().take(4000).collect::<String>();

    if !status.success() {
        return Err(if detail.is_empty() {
            "Codex login failed.".to_string()
        } else {
            format!("Codex login failed: {detail}")
        });
    }

    Ok(json!({ "output": limited }))
}

pub(crate) async fn codex_login_cancel_core(
    codex_login_cancels: &Mutex<HashMap<String, oneshot::Sender<()>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let cancel_tx = {
        let mut cancels = codex_login_cancels.lock().await;
        cancels.remove(&workspace_id)
    };
    let canceled = if let Some(tx) = cancel_tx {
        let _ = tx.send(());
        true
    } else {
        false
    };
    Ok(json!({ "canceled": canceled }))
}

pub(crate) async fn skills_list_core(
    sessions: &Mutex<HashMap<String, Arc<WorkspaceSession>>>,
    workspace_id: String,
) -> Result<Value, String> {
    let session = get_session_clone(sessions, &workspace_id).await?;
    let params = json!({ "cwd": session.entry.path });
    session.send_request("skills/list", params).await
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
