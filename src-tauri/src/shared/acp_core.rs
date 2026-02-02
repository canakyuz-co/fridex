use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

const MAX_MESSAGE_SIZE: usize = 8 * 1024 * 1024;

pub(crate) struct AcpHost {
    sessions: HashMap<String, AcpSession>,
}

struct AcpSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

impl AcpHost {
    pub(crate) fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub(crate) async fn start_session(
        &mut self,
        command: String,
        args: Vec<String>,
        env: HashMap<String, String>,
    ) -> Result<String, String> {
        let mut cmd = Command::new(&command);
        cmd.args(args);
        for (key, value) in env {
            cmd.env(key, value);
        }
        let mut child = cmd
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .map_err(|err| format!("ACP start failed: {err}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "ACP stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "ACP stdout unavailable".to_string())?;
        let session_id = build_session_id();
        self.sessions.insert(
            session_id.clone(),
            AcpSession {
                child,
                stdin,
                stdout: BufReader::new(stdout),
            },
        );
        Ok(session_id)
    }

    pub(crate) async fn stop_session(&mut self, session_id: &str) -> Result<(), String> {
        if let Some(mut session) = self.sessions.remove(session_id) {
            let _ = session.child.kill().await;
        }
        Ok(())
    }

    pub(crate) async fn send(&mut self, session_id: &str, payload: Value) -> Result<Value, String> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| "ACP session not found".to_string())?;
        let request_id = payload
            .get("id")
            .and_then(|value| value.as_i64().map(|id| id.to_string()).or_else(|| value.as_str().map(|s| s.to_string())));
        let body = serde_json::to_string(&payload)
            .map_err(|err| format!("ACP serialize failed: {err}"))?;
        let header = format!("Content-Length: {}\r\n\r\n", body.as_bytes().len());
        session
            .stdin
            .write_all(header.as_bytes())
            .await
            .map_err(|err| format!("ACP write failed: {err}"))?;
        session
            .stdin
            .write_all(body.as_bytes())
            .await
            .map_err(|err| format!("ACP write failed: {err}"))?;
        session
            .stdin
            .flush()
            .await
            .map_err(|err| format!("ACP flush failed: {err}"))?;

        loop {
            let response = read_message(&mut session.stdout).await?;
            if let Some(ref id) = request_id {
                let response_id = response
                    .get("id")
                    .and_then(|value| value.as_i64().map(|v| v.to_string()).or_else(|| value.as_str().map(|s| s.to_string())));
                if response_id.as_deref() != Some(id) {
                    continue;
                }
            }
            return Ok(response);
        }
    }
}

fn build_session_id() -> String {
    let counter = SESSION_COUNTER.fetch_add(1, Ordering::SeqCst);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    format!("acp-{millis}-{counter}")
}

async fn read_message(reader: &mut BufReader<ChildStdout>) -> Result<Value, String> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .await
            .map_err(|err| format!("ACP read header failed: {err}"))?;
        if bytes == 0 {
            return Err("ACP stream closed".to_string());
        }
        let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
        if trimmed.is_empty() {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            let parsed = rest.trim().parse::<usize>().map_err(|_| {
                "ACP invalid Content-Length".to_string()
            })?;
            content_length = Some(parsed);
        }
    }
    let length = content_length.ok_or_else(|| "ACP missing Content-Length".to_string())?;
    if length > MAX_MESSAGE_SIZE {
        return Err("ACP message too large".to_string());
    }
    let mut buffer = vec![0u8; length];
    reader
        .read_exact(&mut buffer)
        .await
        .map_err(|err| format!("ACP read body failed: {err}"))?;
    serde_json::from_slice::<Value>(&buffer).map_err(|err| format!("ACP parse failed: {err}"))
}
