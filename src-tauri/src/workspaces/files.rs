use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;

use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::utils::normalize_git_path;

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "dist" | "target" | "release-artifacts"
    )
}

pub(crate) fn list_workspace_files_inner(root: &PathBuf, max_files: usize) -> Vec<String> {
    let mut results = Vec::new();
    let walker = WalkBuilder::new(root)
        // Allow hidden entries.
        .hidden(false)
        // Avoid crawling symlink targets.
        .follow_links(false)
        // Don't require git to be present to apply to apply git-related ignore rules.
        .require_git(false)
        .filter_entry(|entry| {
            if entry.depth() == 0 {
                return true;
            }
            if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                let name = entry.file_name().to_string_lossy();
                return !should_skip_dir(&name);
            }
            true
        })
        .build();

    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }
        if let Ok(rel_path) = entry.path().strip_prefix(root) {
            let normalized = normalize_git_path(&rel_path.to_string_lossy());
            if !normalized.is_empty() {
                results.push(normalized);
            }
        }
        if results.len() >= max_files {
            break;
        }
    }

    results.sort();
    results
}

const MAX_WORKSPACE_FILE_BYTES: u64 = 400_000;

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct WorkspaceFileResponse {
    content: String,
    truncated: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct WorkspaceSearchResult {
    path: String,
    line: u32,
    column: u32,
    line_text: String,
    match_text: Option<String>,
}

pub(crate) fn read_workspace_file_inner(
    root: &PathBuf,
    relative_path: &str,
) -> Result<WorkspaceFileResponse, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|err| format!("Failed to resolve workspace root: {err}"))?;
    let candidate = canonical_root.join(relative_path);
    let canonical_path = candidate
        .canonicalize()
        .map_err(|err| format!("Failed to open file: {err}"))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err("Invalid file path".to_string());
    }
    let metadata = std::fs::metadata(&canonical_path)
        .map_err(|err| format!("Failed to read file metadata: {err}"))?;
    if !metadata.is_file() {
        return Err("Path is not a file".to_string());
    }

    let file =
        File::open(&canonical_path).map_err(|err| format!("Failed to open file: {err}"))?;
    let mut buffer = Vec::new();
    file.take(MAX_WORKSPACE_FILE_BYTES + 1)
        .read_to_end(&mut buffer)
        .map_err(|err| format!("Failed to read file: {err}"))?;

    let truncated = buffer.len() > MAX_WORKSPACE_FILE_BYTES as usize;
    if truncated {
        buffer.truncate(MAX_WORKSPACE_FILE_BYTES as usize);
    }

    let content =
        String::from_utf8(buffer).map_err(|_| "File is not valid UTF-8".to_string())?;
    Ok(WorkspaceFileResponse { content, truncated })
}

pub(crate) fn write_workspace_file_inner(
    root: &PathBuf,
    relative_path: &str,
    content: &str,
) -> Result<(), String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|err| format!("Failed to resolve workspace root: {err}"))?;
    let candidate = canonical_root.join(relative_path);
    let parent = candidate
        .parent()
        .ok_or_else(|| "Invalid file path".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|err| format!("Failed to resolve parent directory: {err}"))?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err("Invalid file path".to_string());
    }
    if candidate.exists() {
        let canonical_path = candidate
            .canonicalize()
            .map_err(|err| format!("Failed to resolve file path: {err}"))?;
        if !canonical_path.starts_with(&canonical_root) {
            return Err("Invalid file path".to_string());
        }
        let metadata = std::fs::metadata(&canonical_path)
            .map_err(|err| format!("Failed to read file metadata: {err}"))?;
        if !metadata.is_file() {
            return Err("Path is not a file".to_string());
        }
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&candidate)
        .map_err(|err| format!("Failed to open file: {err}"))?;
    file.write_all(content.as_bytes())
        .map_err(|err| format!("Failed to write file: {err}"))?;
    Ok(())
}

fn resolve_workspace_path(root: &PathBuf, relative_path: &str) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|err| format!("Failed to resolve workspace root: {err}"))?;
    let candidate = canonical_root.join(relative_path);
    if let Some(parent) = candidate.parent() {
        let canonical_parent = parent
            .canonicalize()
            .map_err(|err| format!("Failed to resolve parent directory: {err}"))?;
        if !canonical_parent.starts_with(&canonical_root) {
            return Err("Invalid file path".to_string());
        }
    }
    Ok(candidate)
}

pub(crate) fn create_workspace_file_inner(
    root: &PathBuf,
    relative_path: &str,
) -> Result<(), String> {
    let path = resolve_workspace_path(root, relative_path)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create directory: {err}"))?;
    }
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|err| format!("Failed to create file: {err}"))?;
    Ok(())
}

pub(crate) fn create_workspace_dir_inner(
    root: &PathBuf,
    relative_path: &str,
) -> Result<(), String> {
    let path = resolve_workspace_path(root, relative_path)?;
    std::fs::create_dir_all(&path)
        .map_err(|err| format!("Failed to create directory: {err}"))?;
    Ok(())
}

pub(crate) fn delete_workspace_path_inner(
    root: &PathBuf,
    relative_path: &str,
) -> Result<(), String> {
    let path = resolve_workspace_path(root, relative_path)?;
    if !path.exists() {
        return Err("Path does not exist".to_string());
    }
    let metadata = std::fs::metadata(&path)
        .map_err(|err| format!("Failed to read metadata: {err}"))?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(&path)
            .map_err(|err| format!("Failed to remove folder: {err}"))?;
    } else {
        std::fs::remove_file(&path)
            .map_err(|err| format!("Failed to remove file: {err}"))?;
    }
    Ok(())
}

pub(crate) fn move_workspace_path_inner(
    root: &PathBuf,
    from_path: &str,
    to_path: &str,
) -> Result<(), String> {
    let from = resolve_workspace_path(root, from_path)?;
    let to = resolve_workspace_path(root, to_path)?;
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create destination directory: {err}"))?;
    }
    std::fs::rename(&from, &to).map_err(|err| format!("Failed to move path: {err}"))?;
    Ok(())
}



pub(crate) fn search_workspace_files_inner(
    root: &PathBuf,
    query: &str,
    include_globs: &[String],
    exclude_globs: &[String],
    max_results: usize,
) -> Result<Vec<WorkspaceSearchResult>, String> {
    let mut cmd = Command::new("rg");
    cmd.current_dir(root);
    cmd.arg("--json")
        .arg("--with-filename")
        .arg("--line-number")
        .arg("--column")
        .arg("--color")
        .arg("never");
    for pattern in include_globs {
        if !pattern.trim().is_empty() {
            cmd.arg("--glob").arg(pattern);
        }
    }
    for pattern in exclude_globs {
        let trimmed = pattern.trim();
        if !trimmed.is_empty() {
            cmd.arg("--glob").arg(format!("!{trimmed}"));
        }
    }
    cmd.arg(query);
    let output = cmd
        .output()
        .map_err(|err| format!("Failed to run rg: {err}"))?;

    if !output.status.success() && output.status.code() != Some(1) {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Search failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();
    for line in stdout.lines() {
        if results.len() >= max_results {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(kind) = value.get("type").and_then(|value| value.as_str()) else {
            continue;
        };
        if kind != "match" {
            continue;
        }
        let data = match value.get("data") {
            Some(data) => data,
            None => continue,
        };
        let path = data
            .get("path")
            .and_then(|path| path.get("text"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_string();
        let line_number = data
            .get("line_number")
            .and_then(|value| value.as_u64())
            .unwrap_or(0) as u32;
        let line_text = data
            .get("lines")
            .and_then(|lines| lines.get("text"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim_end_matches(['\n', '\r'])
            .to_string();
        let (column, match_text) = data
            .get("submatches")
            .and_then(|value| value.as_array())
            .and_then(|matches| matches.first())
            .and_then(|match_value| {
                let start = match_value.get("start")?.as_u64()?;
                let end = match_value.get("end")?.as_u64()?;
                Some((start, end))
            })
            .map(|(start, end)| {
                let bytes = line_text.as_bytes();
                let start_index = std::cmp::min(start as usize, bytes.len());
                let end_index = std::cmp::min(end as usize, bytes.len());
                let match_text = if start_index < end_index {
                    String::from_utf8_lossy(&bytes[start_index..end_index]).to_string()
                } else {
                    String::new()
                };
                ((start_index as u32) + 1, Some(match_text))
            })
            .unwrap_or((1, None));

        results.push(WorkspaceSearchResult {
            path,
            line: line_number.max(1),
            column,
            line_text,
            match_text,
        });
    }

    Ok(results)
}
