use std::collections::HashMap;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeminiCliResponse {
    pub content: String,
}

#[tauri::command]
pub async fn send_gemini_cli_message_sync(
    command: String,
    args: Option<String>,
    prompt: String,
    model: Option<String>,
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

    fn has_flag(args: &[String], flag: &str) -> bool {
        args.iter().any(|arg| arg == flag)
    }

    fn has_any_flag(args: &[String], flags: &[&str]) -> bool {
        flags.iter().any(|flag| has_flag(args, flag))
    }

    fn run_cli(
        command: &str,
        args: &[String],
        cwd: &Option<String>,
        env: &Option<HashMap<String, String>>,
    ) -> Result<(String, String), String> {
        let mut cmd = Command::new(command);
        cmd.args(args);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        let mut has_path_override = false;
        if let Some(env_map) = env {
            has_path_override = env_map.contains_key("PATH");
            for (key, value) in env_map {
                cmd.env(key, value);
            }
        }
        if !has_path_override {
            // macOS GUI apps often start with a minimal PATH; include common brew/system locations.
            cmd.env("PATH", crate::utils::tools_env_path());
        }
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to spawn CLI: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        if !output.status.success() {
            return Err(format!(
                "CLI exited with code {:?}: {}",
                output.status.code(),
                stderr.trim()
            ));
        }
        Ok((stdout, stderr))
    }

    fn extract_text_from_json(value: &Value) -> Option<String> {
        if let Some(text) = value.get("response").and_then(|v| v.as_str()) {
            return Some(text.to_string());
        }
        if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
            return Some(text.to_string());
        }
        if let Some(text) = value.get("content").and_then(|v| v.as_str()) {
            return Some(text.to_string());
        }
        if let Some(candidates) = value.get("candidates").and_then(|v| v.as_array()) {
            let mut parts_text = String::new();
            for candidate in candidates {
                if let Some(parts) = candidate
                    .get("content")
                    .and_then(|c| c.get("parts"))
                    .and_then(|p| p.as_array())
                {
                    for part in parts {
                        if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                            parts_text.push_str(text);
                        }
                    }
                    if !parts_text.is_empty() {
                        return Some(parts_text);
                    }
                }
            }
        }
        None
    }

    let mut base_args: Vec<String> = Vec::new();
    let mut used_prompt_placeholder = false;

    if let Some(args_str) = args {
        for token in args_str.split_whitespace() {
            if token.contains("{prompt}") {
                used_prompt_placeholder = true;
                base_args.push(token.replace("{prompt}", prompt));
            } else {
                base_args.push(token.to_string());
            }
        }
    }

    // Ensure model is forwarded (best-effort; user can override via args).
    if let Some(model) = model.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()) {
        if !has_flag(&base_args, "--model") {
            base_args.push("--model".to_string());
            base_args.push(model.to_string());
        }
    }

    // Ensure prompt is passed in headless mode unless user already provided it via args.
    if !used_prompt_placeholder && !has_any_flag(&base_args, &["-p", "--prompt"]) {
        base_args.push("-p".to_string());
        base_args.push(prompt.to_string());
    }

    // Try JSON output first; fall back to plain output if the CLI doesn't support it.
    let mut attempts: Vec<Vec<String>> = Vec::new();
    if !has_any_flag(&base_args, &["--output-format", "--output", "--format"]) {
        let mut json_args = base_args.clone();
        json_args.push("--output-format".to_string());
        json_args.push("json".to_string());
        attempts.push(json_args);
    }
    attempts.push(base_args);

    let mut last_error: Option<String> = None;
    for args in attempts {
        match run_cli(command, &args, &cwd, &env) {
            Ok((stdout, _stderr)) => {
                let trimmed = stdout.trim();
                if trimmed.is_empty() {
                    last_error = Some("CLI returned empty output.".to_string());
                    continue;
                }
                if trimmed.starts_with('{') {
                    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                        if let Some(text) = extract_text_from_json(&value) {
                            return Ok(GeminiCliResponse { content: text });
                        }
                    }
                }
                return Ok(GeminiCliResponse {
                    content: stdout.trim().to_string(),
                });
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "CLI request failed.".to_string()))
}
