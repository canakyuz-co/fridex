use std::collections::HashMap;
use std::io::Write;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeminiCliResponse {
    pub content: String,
}

#[tauri::command]
pub async fn send_gemini_cli_message_sync(
    command: String,
    args: Option<String>,
    prompt: String,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<GeminiCliResponse, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("CLI command is required".to_string());
    }
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Prompt is required".to_string());
    }

    let mut cmd = Command::new(command);
    let mut used_placeholder = false;

    if let Some(args_str) = args {
        let parsed_args: Vec<&str> = args_str.split_whitespace().collect();
        for arg in parsed_args {
            if arg.contains("{prompt}") {
                used_placeholder = true;
                cmd.arg(arg.replace("{prompt}", prompt));
            } else {
                cmd.arg(arg);
            }
        }
    }

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    if let Some(env_map) = env {
        for (key, value) in env_map {
            cmd.env(key, value);
        }
    }

    if !used_placeholder {
        cmd.stdin(Stdio::piped());
    }
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn CLI: {e}"))?;

    if !used_placeholder {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(prompt.as_bytes())
                .map_err(|e| format!("Failed to write prompt: {e}"))?;
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("CLI process error: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "CLI exited with code {:?}: {}",
            output.status.code(),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(GeminiCliResponse { content: stdout })
}
