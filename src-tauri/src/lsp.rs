use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::remote_backend;
use crate::state::AppState;

#[derive(Serialize, Clone)]
struct LspNotification {
    workspace_id: String,
    language_id: String,
    method: String,
    params: Value,
}

enum LspCommand {
    Request {
        id: i64,
        method: String,
        params: Value,
    },
    Notify {
        method: String,
        params: Value,
    },
    Shutdown,
}

struct LspClient {
    command_tx: mpsc::Sender<LspCommand>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    next_id: AtomicI64,
}

impl LspClient {
    async fn send_request(&self, method: String, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }
        self.command_tx
            .send(LspCommand::Request { id, method, params })
            .await
            .map_err(|_| "LSP channel closed".to_string())?;
        let response = rx.await.map_err(|_| "LSP request cancelled".to_string())?;
        if let Some(error) = response.get("error") {
            return Err(error.to_string());
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn send_notification(&self, method: String, params: Value) -> Result<(), String> {
        self.command_tx
            .send(LspCommand::Notify { method, params })
            .await
            .map_err(|_| "LSP channel closed".to_string())
    }
}

pub(crate) struct LspManager {
    clients: HashMap<String, LspClient>,
}

impl LspManager {
    pub(crate) fn new() -> Self {
        Self {
            clients: HashMap::new(),
        }
    }

    fn key(workspace_id: &str, language_id: &str) -> String {
        format!("{workspace_id}:{language_id}")
    }

    pub(crate) async fn start(
        &mut self,
        app: &AppHandle,
        workspace_id: String,
        language_id: String,
        root_path: PathBuf,
    ) -> Result<(), String> {
        let key = Self::key(&workspace_id, &language_id);
        if self.clients.contains_key(&key) {
            return Ok(());
        }
        let (command, args) =
            command_for_language(&language_id).ok_or("Unsupported language")?;
        let mut child = Command::new(&command)
            .args(args)
            .current_dir(&root_path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .map_err(|err| format!("Failed to start LSP: {err}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Failed to open LSP stdin")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to open LSP stdout")?;
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (command_tx, command_rx) = mpsc::channel(128);
        spawn_lsp_tasks(
            app.clone(),
            workspace_id.clone(),
            language_id.clone(),
            child,
            stdin,
            stdout,
            command_rx,
            pending.clone(),
        );
        let client = LspClient {
            command_tx,
            pending,
            next_id: AtomicI64::new(1),
        };
        self.clients.insert(key, client);
        Ok(())
    }

    pub(crate) async fn stop(
        &mut self,
        workspace_id: String,
        language_id: String,
    ) -> Result<(), String> {
        let key = Self::key(&workspace_id, &language_id);
        if let Some(client) = self.clients.remove(&key) {
            let _ = client.command_tx.send(LspCommand::Shutdown).await;
        }
        Ok(())
    }

    pub(crate) async fn request(
        &self,
        workspace_id: String,
        language_id: String,
        method: String,
        params: Value,
    ) -> Result<Value, String> {
        let key = Self::key(&workspace_id, &language_id);
        let client = self
            .clients
            .get(&key)
            .ok_or("LSP client not started")?;
        client.send_request(method, params).await
    }

    pub(crate) async fn notify(
        &self,
        workspace_id: String,
        language_id: String,
        method: String,
        params: Value,
    ) -> Result<(), String> {
        let key = Self::key(&workspace_id, &language_id);
        let client = self
            .clients
            .get(&key)
            .ok_or("LSP client not started")?;
        client.send_notification(method, params).await
    }
}

fn command_for_language(language_id: &str) -> Option<(&'static str, Vec<&'static str>)> {
    match language_id {
        "typescript" | "javascript" => Some(("typescript-language-server", vec!["--stdio"])),
        "json" => Some(("vscode-json-language-server", vec!["--stdio"])),
        "css" | "scss" | "less" => Some(("vscode-css-language-server", vec!["--stdio"])),
        "html" => Some(("vscode-html-language-server", vec!["--stdio"])),
        "markdown" => Some(("marksman", vec!["server"])),
        "rust" => Some(("rust-analyzer", vec![])),
        "python" => Some(("pyright-langserver", vec!["--stdio"])),
        "go" => Some(("gopls", vec![])),
        "yaml" => Some(("yaml-language-server", vec!["--stdio"])),
        "toml" => Some(("taplo", vec!["lsp", "stdio"])),
        "shell" => Some(("bash-language-server", vec!["start"])),
        _ => None,
    }
}

fn spawn_lsp_tasks(
    app: AppHandle,
    workspace_id: String,
    language_id: String,
    mut child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    mut command_rx: mpsc::Receiver<LspCommand>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
) {
    let app_for_reader = app.clone();
    tokio::spawn(async move {
        if let Err(err) =
            lsp_reader_loop(app_for_reader, workspace_id, language_id, stdout, pending).await
        {
            eprintln!("[lsp] reader stopped: {err}");
        }
        let _ = child.kill().await;
    });

    tokio::spawn(async move {
        if let Err(err) = lsp_writer_loop(stdin, &mut command_rx).await {
            eprintln!("[lsp] writer stopped: {err}");
        }
    });
}

async fn lsp_writer_loop(
    mut stdin: ChildStdin,
    command_rx: &mut mpsc::Receiver<LspCommand>,
) -> Result<(), String> {
    while let Some(command) = command_rx.recv().await {
        let message = match command {
            LspCommand::Request { id, method, params } => {
                json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
            }
            LspCommand::Notify { method, params } => {
                json!({ "jsonrpc": "2.0", "method": method, "params": params })
            }
            LspCommand::Shutdown => {
                let payload = json!({ "jsonrpc": "2.0", "method": "shutdown", "params": {} });
                write_message(&mut stdin, &payload).await?;
                let exit_payload = json!({ "jsonrpc": "2.0", "method": "exit", "params": {} });
                write_message(&mut stdin, &exit_payload).await?;
                return Ok(());
            }
        };
        write_message(&mut stdin, &message).await?;
    }
    Ok(())
}

async fn lsp_reader_loop(
    app: AppHandle,
    workspace_id: String,
    language_id: String,
    stdout: ChildStdout,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
) -> Result<(), String> {
    let mut reader = BufReader::new(stdout);
    loop {
        let message = read_message(&mut reader).await?;
        if let Some(id) = message.get("id").and_then(|value| value.as_i64()) {
            let tx = {
                let mut pending = pending.lock().await;
                pending.remove(&id)
            };
            if let Some(tx) = tx {
                let _ = tx.send(message);
            }
            continue;
        }
        let method = message
            .get("method")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let payload = LspNotification {
            workspace_id: workspace_id.clone(),
            language_id: language_id.clone(),
            method,
            params,
        };
        let _ = app.emit("lsp-notification", payload);
    }
}

async fn write_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    let payload = serde_json::to_string(message).map_err(|err| err.to_string())?;
    let header = format!("Content-Length: {}\r\n\r\n", payload.as_bytes().len());
    stdin
        .write_all(header.as_bytes())
        .await
        .map_err(|err| err.to_string())?;
    stdin
        .write_all(payload.as_bytes())
        .await
        .map_err(|err| err.to_string())?;
    stdin.flush().await.map_err(|err| err.to_string())?;
    Ok(())
}

async fn read_message(reader: &mut BufReader<ChildStdout>) -> Result<Value, String> {
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .await
            .map_err(|err| err.to_string())?;
        if bytes == 0 {
            return Err("LSP stream closed".to_string());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = value.trim().parse::<usize>().unwrap_or(0);
        }
    }
    if content_length == 0 {
        return Err("Missing Content-Length".to_string());
    }
    let mut buffer = vec![0u8; content_length];
    reader
        .read_exact(&mut buffer)
        .await
        .map_err(|err| err.to_string())?;
    serde_json::from_slice(&buffer).map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) async fn lsp_start(
    workspace_id: String,
    language_id: String,
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Err("LSP remote backend modunda desteklenmiyor.".to_string());
    }
    let workspaces = state.workspaces.lock().await;
    let entry = workspaces
        .get(&workspace_id)
        .ok_or("workspace not found")?;
    let root = PathBuf::from(&entry.path);
    drop(workspaces);
    let mut manager = state.lsp_manager.lock().await;
    manager
        .start(&app, workspace_id, language_id, root)
        .await
}

#[tauri::command]
pub(crate) async fn lsp_stop(
    workspace_id: String,
    language_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Err("LSP remote backend modunda desteklenmiyor.".to_string());
    }
    let mut manager = state.lsp_manager.lock().await;
    manager.stop(workspace_id, language_id).await
}

#[tauri::command]
pub(crate) async fn lsp_request(
    workspace_id: String,
    language_id: String,
    method: String,
    params: Value,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Err("LSP remote backend modunda desteklenmiyor.".to_string());
    }
    let manager = state.lsp_manager.lock().await;
    manager
        .request(workspace_id, language_id, method, params)
        .await
}

#[tauri::command]
pub(crate) async fn lsp_notify(
    workspace_id: String,
    language_id: String,
    method: String,
    params: Value,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Err("LSP remote backend modunda desteklenmiyor.".to_string());
    }
    let manager = state.lsp_manager.lock().await;
    manager
        .notify(workspace_id, language_id, method, params)
        .await
}
