use tauri::AppHandle;

#[cfg(target_os = "macos")]
use tokio::process::Command;

#[tauri::command]
pub(crate) async fn tts_speak(
    _app: AppHandle,
    text: String,
    voice: Option<String>,
) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("say");
        if let Some(voice) = voice.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            cmd.arg("-v").arg(voice);
        }
        cmd.arg(trimmed);
        cmd.spawn()
            .map_err(|error| format!("Failed to start speech: {error}"))?;
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = voice;
        Err("Text-to-speech is only supported on macOS builds.".to_string())
    }
}
