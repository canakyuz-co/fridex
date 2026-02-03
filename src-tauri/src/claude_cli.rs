use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use tauri::ipc::Channel;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_read_input_tokens: u32,
    pub cache_creation_input_tokens: u32,
    pub total_cost_usd: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliEvent {
    pub event_type: String,
    pub content: Option<String>,
    pub usage: Option<ClaudeCliUsage>,
    pub error: Option<String>,
    pub session_id: Option<String>,
    pub model: Option<String>,
}

fn parse_usage(value: &Value) -> Option<ClaudeCliUsage> {
    let usage = value.get("usage")?;
    Some(ClaudeCliUsage {
        input_tokens: usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        output_tokens: usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        cache_read_input_tokens: usage
            .get("cache_read_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        cache_creation_input_tokens: usage
            .get("cache_creation_input_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        total_cost_usd: value
            .get("total_cost_usd")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
    })
}

fn extract_text_content(message: &Value) -> Option<String> {
    let content = message.get("content")?.as_array()?;
    let texts: Vec<&str> = content
        .iter()
        .filter_map(|block| {
            if block.get("type")?.as_str()? == "text" {
                block.get("text")?.as_str()
            } else {
                None
            }
        })
        .collect();
    if texts.is_empty() {
        None
    } else {
        Some(texts.join(""))
    }
}

#[tauri::command]
pub async fn send_claude_cli_message(
    command: String,
    args: Option<String>,
    prompt: String,
    model: Option<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    on_event: Channel<ClaudeCliEvent>,
) -> Result<(), String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("CLI command is required".to_string());
    }

    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Prompt is required".to_string());
    }

    // Build command
    let mut cmd = Command::new(command);

    // Add default args for stream-json output
    cmd.arg("--print");
    cmd.arg("--verbose");
    cmd.arg("--output-format");
    cmd.arg("stream-json");

    // Add custom args if provided
    if let Some(args_str) = args {
        let parsed_args: Vec<&str> = args_str.split_whitespace().collect();
        for arg in parsed_args {
            cmd.arg(arg);
        }
    }

    // Add model if provided and not already set by args.
    if let Some(model) = model.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty())
    {
        let args_str = cmd
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<String>>();
        let has_model_flag = args_str.iter().any(|arg| arg == "--model");
        if !has_model_flag {
            cmd.arg("--model");
            cmd.arg(model);
        }
    }

    // Add prompt
    cmd.arg(&prompt);

    // Set working directory
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
        cmd.env("PATH", crate::utils::git_env_path());
    }

    // Setup stdio
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn CLI: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    let reader = BufReader::new(stdout);
    let stderr_reader = BufReader::new(stderr);
    let mut accumulated_text = String::new();
    let mut session_id: Option<String> = None;
    let mut model: Option<String> = None;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                let _ = on_event.send(ClaudeCliEvent {
                    event_type: "error".to_string(),
                    content: None,
                    usage: None,
                    error: Some(format!("Read error: {}", e)),
                    session_id: session_id.clone(),
                    model: model.clone(),
                });
                continue;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let parsed: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let event_type = parsed
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match event_type {
            "system" => {
                // Init event
                session_id = parsed
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                model = parsed
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let _ = on_event.send(ClaudeCliEvent {
                    event_type: "init".to_string(),
                    content: None,
                    usage: None,
                    error: None,
                    session_id: session_id.clone(),
                    model: model.clone(),
                });
            }
            "assistant" => {
                // Message from assistant
                if let Some(message) = parsed.get("message") {
                    if let Some(text) = extract_text_content(message) {
                        accumulated_text = text.clone();
                        let _ = on_event.send(ClaudeCliEvent {
                            event_type: "content".to_string(),
                            content: Some(text),
                            usage: None,
                            error: None,
                            session_id: session_id.clone(),
                            model: model.clone(),
                        });
                    }
                }
            }
            "result" => {
                // Final result with usage
                let is_error = parsed
                    .get("is_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);

                if is_error {
                    let error_msg = parsed
                        .get("result")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Unknown error")
                        .to_string();
                    let _ = on_event.send(ClaudeCliEvent {
                        event_type: "error".to_string(),
                        content: None,
                        usage: None,
                        error: Some(error_msg),
                        session_id: session_id.clone(),
                        model: model.clone(),
                    });
                } else {
                    let result_text = parsed
                        .get("result")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());

                    let usage = parse_usage(&parsed);

                    let _ = on_event.send(ClaudeCliEvent {
                        event_type: "complete".to_string(),
                        content: result_text.or(Some(accumulated_text.clone())),
                        usage,
                        error: None,
                        session_id: session_id.clone(),
                        model: model.clone(),
                    });
                }
            }
            "error" => {
                let error_msg = parsed
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error")
                    .to_string();
                let _ = on_event.send(ClaudeCliEvent {
                    event_type: "error".to_string(),
                    content: None,
                    usage: None,
                    error: Some(error_msg),
                    session_id: session_id.clone(),
                    model: model.clone(),
                });
            }
            _ => {}
        }
    }

    // Wait for process to finish
    let status = child.wait().map_err(|e| format!("Process error: {}", e))?;

    if !status.success() {
        // Read stderr for detailed error message
        let stderr_output: String = stderr_reader
            .lines()
            .filter_map(|line| line.ok())
            .collect::<Vec<_>>()
            .join("\n");

        let error_msg = if stderr_output.is_empty() {
            format!("CLI exited with code: {}", status.code().unwrap_or(-1))
        } else {
            format!(
                "CLI exited with code: {}\n{}",
                status.code().unwrap_or(-1),
                stderr_output
            )
        };

        let _ = on_event.send(ClaudeCliEvent {
            event_type: "error".to_string(),
            content: None,
            usage: None,
            error: Some(error_msg),
            session_id,
            model,
        });
    }

    Ok(())
}
