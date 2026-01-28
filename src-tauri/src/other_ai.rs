use reqwest::Client;
use serde_json::Value;

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
