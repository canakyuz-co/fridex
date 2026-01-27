use serde::Deserialize;
#[derive(Deserialize)]
pub(crate) struct AiMessage {
    pub(crate) role: String,
    pub(crate) content: String,
}

pub(crate) mod commands {
    use super::AiMessage;
    use tauri::ipc::Channel;

    // Returns availability for the requested provider; O(1) time, O(1) space.
    #[tauri::command]
    pub(crate) async fn ai_provider_status(provider_id: String) -> Result<bool, String> {
        let _ = provider_id;
        Ok(false)
    }

    // Stubbed streaming entrypoint until AI core is wired; O(1) time, O(1) space.
    #[tauri::command]
    pub(crate) async fn ai_generate_stream(
        provider_id: String,
        model: Option<String>,
        messages: Vec<AiMessage>,
        temperature: f32,
        on_event: Channel<String>,
    ) -> Result<(), String> {
        let _ = (provider_id, model, messages, temperature, on_event);
        Err("AI core is not configured yet.".to_string())
    }
}
