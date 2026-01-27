use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::storage::{read_tasks, write_tasks};
use crate::types::{TaskEntry, TaskStatus};

fn tasks_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("tasks.json"))
        .map_err(|e| e.to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) async fn list_tasks(app: AppHandle) -> Result<Vec<TaskEntry>, String> {
    let path = tasks_path(&app)?;
    let mut tasks = read_tasks(&path)?;
    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(tasks)
}

#[tauri::command]
pub(crate) async fn create_task(
    app: AppHandle,
    title: String,
    content: String,
    workspace_id: Option<String>,
) -> Result<TaskEntry, String> {
    let path = tasks_path(&app)?;
    let mut tasks = read_tasks(&path)?;
    let now = now_ms();
    let entry = TaskEntry {
        id: Uuid::new_v4().to_string(),
        title,
        content,
        status: TaskStatus::Todo,
        workspace_id,
        created_at: now,
        updated_at: now,
    };
    tasks.push(entry.clone());
    write_tasks(&path, &tasks)?;
    Ok(entry)
}

#[tauri::command]
pub(crate) async fn update_task(
    app: AppHandle,
    id: String,
    title: String,
    content: String,
) -> Result<TaskEntry, String> {
    let path = tasks_path(&app)?;
    let mut tasks = read_tasks(&path)?;
    let now = now_ms();
    let Some(task_index) = tasks.iter().position(|task| task.id == id) else {
        return Err("Task not found.".to_string());
    };
    let task = &mut tasks[task_index];
    task.title = title;
    task.content = content;
    task.updated_at = now;
    let updated = task.clone();
    write_tasks(&path, &tasks)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) async fn set_task_status(
    app: AppHandle,
    id: String,
    status: TaskStatus,
) -> Result<TaskEntry, String> {
    let path = tasks_path(&app)?;
    let mut tasks = read_tasks(&path)?;
    let now = now_ms();
    let Some(task_index) = tasks.iter().position(|task| task.id == id) else {
        return Err("Task not found.".to_string());
    };
    let task = &mut tasks[task_index];
    task.status = status;
    task.updated_at = now;
    let updated = task.clone();
    write_tasks(&path, &tasks)?;
    Ok(updated)
}

#[tauri::command]
pub(crate) async fn delete_task(app: AppHandle, id: String) -> Result<(), String> {
    let path = tasks_path(&app)?;
    let mut tasks = read_tasks(&path)?;
    let start_len = tasks.len();
    tasks.retain(|task| task.id != id);
    if tasks.len() == start_len {
        return Err("Task not found.".to_string());
    }
    write_tasks(&path, &tasks)?;
    Ok(())
}
