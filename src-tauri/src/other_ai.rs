use reqwest::Client;
use serde_json::Value;
use std::collections::HashMap;
use std::process::Command;

fn collect_unique_models(items: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for item in items {
        let trimmed = item.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.to_string()) {
            models.push(trimmed.to_string());
        }
    }
    models
}

async fn list_claude_models(client: &Client, api_key: &str) -> Result<Vec<String>, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API key is required".to_string());
    }
    let response = client
        .get("https://api.anthropic.com/v1/models")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|err| format!("Claude API request failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Claude API error: {}",
            response.status().as_u16()
        ));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|err| format!("Claude API response invalid: {err}"))?;
    let models = payload
        .get("data")
        .and_then(|data| data.as_array())
        .map(|data| {
            data.iter()
                .filter_map(|item| item.get("id").and_then(|value| value.as_str()))
                .map(|value| value.to_string())
                .filter(|value| value.starts_with("claude-"))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    Ok(collect_unique_models(models))
}

async fn list_gemini_models(client: &Client, api_key: &str) -> Result<Vec<String>, String> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API key is required".to_string());
    }
    let response = client
        .get("https://generativelanguage.googleapis.com/v1beta/models")
        .query(&[("key", api_key)])
        .send()
        .await
        .map_err(|err| format!("Gemini API request failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Gemini API error: {}",
            response.status().as_u16()
        ));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|err| format!("Gemini API response invalid: {err}"))?;
    let models = payload
        .get("models")
        .and_then(|data| data.as_array())
        .map(|data| {
            data.iter()
                .filter_map(|item| item.get("name").and_then(|value| value.as_str()))
                .map(|value| value.strip_prefix("models/").unwrap_or(value).to_string())
                .filter(|value| value.starts_with("gemini-"))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();
    Ok(collect_unique_models(models))
}

fn extract_model_name(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(name) = value.get("name").and_then(|value| value.as_str()) {
        return Some(name.to_string());
    }
    if let Some(id) = value.get("id").and_then(|value| value.as_str()) {
        return Some(id.to_string());
    }
    if let Some(model) = value.get("model").and_then(|value| value.as_str()) {
        return Some(model.to_string());
    }
    if let Some(model_id) = value.get("modelId").and_then(|value| value.as_str()) {
        return Some(model_id.to_string());
    }
    None
}

fn collect_models_from_json(provider: &str, payload: &Value) -> Vec<String> {
    let mut models = Vec::new();
    let candidates = payload
        .get("models")
        .and_then(|value| value.as_array())
        .or_else(|| payload.get("data").and_then(|value| value.as_array()))
        .or_else(|| payload.as_array());
    if let Some(items) = candidates {
        for item in items {
            if let Some(name) = extract_model_name(item) {
                models.push(name);
            }
        }
    }
    let prefix = if provider == "claude" { "claude-" } else { "gemini-" };
    models
        .into_iter()
        .map(|value| value.strip_prefix("models/").unwrap_or(value.as_str()).to_string())
        .filter(|value| value.starts_with(prefix))
        .collect()
}

fn collect_models_from_text(provider: &str, output: &str) -> Vec<String> {
    let prefix = if provider == "claude" { "claude-" } else { "gemini-" };
    let mut models = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim().trim_start_matches("- ").trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with(prefix) {
            models.push(trimmed.to_string());
            continue;
        }
        if let Some(token) = trimmed
            .split_whitespace()
            .find(|token| token.starts_with(prefix))
        {
            models.push(token.to_string());
        }
    }
    models
}

fn run_cli_with_env(
    command: &str,
    args: &[&str],
    env: &Option<HashMap<String, String>>,
) -> Result<String, String> {
    let mut cmd = Command::new(command);
    cmd.args(args);
    let mut has_path_override = false;
    if let Some(env_map) = env {
        has_path_override = env_map.contains_key("PATH");
        for (key, value) in env_map {
            cmd.env(key, value);
        }
    }
    if !has_path_override {
        cmd.env("PATH", crate::utils::tools_env_path());
    }
    let output = cmd.output().map_err(|err| format!("CLI spawn failed: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "CLI exited with code {:?}: {}",
            output.status.code(),
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn list_models_via_cli(
    provider: &str,
    command: &str,
    env: &Option<HashMap<String, String>>,
) -> Result<Vec<String>, String> {
    if provider == "claude" {
        return Err("Claude CLI does not expose a non-interactive model list.".to_string());
    }
    let attempts: Vec<Vec<&str>> = vec![
        vec!["models", "list", "--output-format", "json"],
        vec!["models", "list", "--output", "json"],
        vec!["models", "list", "--format", "json"],
        vec!["models", "list"],
        vec!["--list-models", "--output-format", "json"],
        vec!["--list-models"],
    ];
    let mut last_error = None;
    for args in attempts {
        match run_cli_with_env(command, &args, env) {
            Ok(stdout) => {
                let parsed = serde_json::from_str::<Value>(&stdout).ok();
                let mut models = if let Some(payload) = parsed {
                    collect_models_from_json(provider, &payload)
                } else {
                    collect_models_from_text(provider, &stdout)
                };
                models = collect_unique_models(models);
                if !models.is_empty() {
                    return Ok(models);
                }
                last_error = Some("CLI returned no models.".to_string());
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| "CLI model list failed.".to_string()))
}

#[tauri::command]
pub(crate) async fn list_other_ai_models(
    provider: String,
    api_key: String,
) -> Result<Vec<String>, String> {
    let normalized = provider.trim().to_lowercase();
    let client = Client::new();
    match normalized.as_str() {
        "claude" => list_claude_models(&client, &api_key).await,
        "gemini" => list_gemini_models(&client, &api_key).await,
        _ => Err("Unsupported provider".to_string()),
    }
}

#[tauri::command]
pub(crate) async fn list_other_ai_models_cli(
    provider: String,
    command: String,
    env: Option<HashMap<String, String>>,
) -> Result<Vec<String>, String> {
    let normalized = provider.trim().to_lowercase();
    let command = command.trim();
    if command.is_empty() {
        return Err("CLI command is required".to_string());
    }
    match normalized.as_str() {
        "claude" | "gemini" => list_models_via_cli(&normalized, command, &env),
        _ => Err("Unsupported provider".to_string()),
    }
}
