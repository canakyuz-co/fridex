use std::collections::HashMap;
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub(crate) async fn acp_start_session(
    state: State<'_, AppState>,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let mut host = state.acp_host.lock().await;
    host.start_session(command, args, env.unwrap_or_default())
        .await
}

#[tauri::command]
pub(crate) async fn acp_send(
    state: State<'_, AppState>,
    session_id: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut host = state.acp_host.lock().await;
    host.send(&session_id, request).await
}

#[tauri::command]
pub(crate) async fn acp_stop_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut host = state.acp_host.lock().await;
    host.stop_session(&session_id).await
}
