use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::remote_backend;
use crate::state::AppState;
use flate2::read::GzDecoder;
use reqwest::Client;
use sha2::{Digest, Sha256};
use tar::Archive;
use zip::ZipArchive;

#[derive(Serialize, Clone)]
struct LspNotification {
    workspace_id: String,
    language_id: String,
    method: String,
    params: Value,
}

#[derive(Serialize, Clone)]
struct LspDownloadStatus {
    language_id: String,
    server_name: String,
    state: String,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    message: Option<String>,
}

struct LspCommandSpec {
    command: PathBuf,
    args: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct LspManifest {
    entries: HashMap<String, LspManifestEntry>,
}

#[derive(Serialize, Deserialize)]
struct LspManifestEntry {
    version: String,
    sha256: String,
}

enum LspCommand {
    Request {
        id: i64,
        method: String,
        params: Value,
    },
    Notify {
        method: String,
        params: Value,
    },
    Shutdown,
}

struct LspClient {
    command_tx: mpsc::Sender<LspCommand>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    next_id: AtomicI64,
}

impl LspClient {
    async fn send_request(&self, method: String, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }
        self.command_tx
            .send(LspCommand::Request { id, method, params })
            .await
            .map_err(|_| "LSP channel closed".to_string())?;
        let response = rx.await.map_err(|_| "LSP request cancelled".to_string())?;
        if let Some(error) = response.get("error") {
            return Err(error.to_string());
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    async fn send_notification(&self, method: String, params: Value) -> Result<(), String> {
        self.command_tx
            .send(LspCommand::Notify { method, params })
            .await
            .map_err(|_| "LSP channel closed".to_string())
    }
}

pub(crate) struct LspManager {
    clients: HashMap<String, LspClient>,
}

impl LspManager {
    pub(crate) fn new() -> Self {
        Self {
            clients: HashMap::new(),
        }
    }

    fn key(workspace_id: &str, language_id: &str) -> String {
        format!("{workspace_id}:{language_id}")
    }

    pub(crate) async fn start(
        &mut self,
        app: &AppHandle,
        workspace_id: String,
        language_id: String,
        root_path: PathBuf,
    ) -> Result<(), String> {
        let key = Self::key(&workspace_id, &language_id);
        if self.clients.contains_key(&key) {
            return Ok(());
        }
        let command = resolve_lsp_command(app, &language_id).await?;
        let mut child = Command::new(&command.command)
            .args(&command.args)
            .current_dir(&root_path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .map_err(|err| format!("Failed to start LSP: {err}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or("Failed to open LSP stdin")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to open LSP stdout")?;
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (command_tx, command_rx) = mpsc::channel(128);
        spawn_lsp_tasks(
            app.clone(),
            workspace_id.clone(),
            language_id.clone(),
            child,
            stdin,
            stdout,
            command_rx,
            pending.clone(),
        );
        let client = LspClient {
            command_tx,
            pending,
            next_id: AtomicI64::new(1),
        };
        self.clients.insert(key, client);
        Ok(())
    }

    pub(crate) async fn stop(
        &mut self,
        workspace_id: String,
        language_id: String,
    ) -> Result<(), String> {
        let key = Self::key(&workspace_id, &language_id);
        if let Some(client) = self.clients.remove(&key) {
            let _ = client.command_tx.send(LspCommand::Shutdown).await;
        }
        Ok(())
    }

    pub(crate) async fn request(
        &self,
        workspace_id: String,
        language_id: String,
        method: String,
        params: Value,
    ) -> Result<Value, String> {
        let key = Self::key(&workspace_id, &language_id);
        let client = self
            .clients
            .get(&key)
            .ok_or("LSP client not started")?;
        client.send_request(method, params).await
    }

    pub(crate) async fn notify(
        &self,
        workspace_id: String,
        language_id: String,
        method: String,
        params: Value,
    ) -> Result<(), String> {
        let key = Self::key(&workspace_id, &language_id);
        let client = self
            .clients
            .get(&key)
            .ok_or("LSP client not started")?;
        client.send_notification(method, params).await
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn lsp_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("lsp"))
        .map_err(|err| format!("LSP cache klasoru bulunamadi: {err}"))
}

fn lsp_bin_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(lsp_cache_dir(app)?.join("bin"))
}

fn lsp_node_dir(app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    Ok(lsp_cache_dir(app)?.join("node").join(version))
}

fn lsp_node_modules_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(lsp_cache_dir(app)?.join("node_modules"))
}

fn lsp_manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(lsp_cache_dir(app)?.join("manifest.json"))
}

async fn read_manifest(app: &AppHandle) -> Result<LspManifest, String> {
    let path = lsp_manifest_path(app)?;
    let data = match fs::read(&path).await {
        Ok(data) => data,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(LspManifest::default());
        }
        Err(err) => return Err(format!("LSP manifest okunamadi: {err}")),
    };
    serde_json::from_slice(&data).map_err(|err| format!("LSP manifest parse edilemedi: {err}"))
}

async fn write_manifest(app: &AppHandle, manifest: &LspManifest) -> Result<(), String> {
    let path = lsp_manifest_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|err| format!("LSP manifest dizini olusturulamadi: {err}"))?;
    }
    let payload =
        serde_json::to_vec_pretty(manifest).map_err(|err| format!("LSP manifest yazilamadi: {err}"))?;
    fs::write(path, payload)
        .await
        .map_err(|err| format!("LSP manifest yazilamadi: {err}"))?;
    Ok(())
}

fn emit_lsp_download(
    app: &AppHandle,
    language_id: &str,
    server_name: &str,
    state: &str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
    message: Option<String>,
) {
    let payload = LspDownloadStatus {
        language_id: language_id.to_string(),
        server_name: server_name.to_string(),
        state: state.to_string(),
        downloaded_bytes,
        total_bytes,
        message,
    };
    let _ = app.emit("lsp-download", payload);
}

async fn download_to_path(
    client: &Client,
    app: &AppHandle,
    url: &str,
    destination: &Path,
    language_id: &str,
    server_name: &str,
) -> Result<(), String> {
    let response = client
        .get(url)
        .header("User-Agent", "Friday-LSP-Downloader")
        .send()
        .await
        .map_err(|err| format!("LSP indirilemedi: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("LSP indirilemedi: HTTP {}", response.status()));
    }
    let total = response.content_length();
    let mut downloaded = 0u64;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|err| format!("LSP dizini olusturulamadi: {err}"))?;
    }
    let mut file = fs::File::create(destination)
        .await
        .map_err(|err| format!("LSP dosyasi yazilamadi: {err}"))?;
    let mut response = response;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|err| format!("LSP indirilemedi: {err}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|err| format!("LSP dosyasi yazilamadi: {err}"))?;
        downloaded += chunk.len() as u64;
        emit_lsp_download(app, language_id, server_name, "downloading", downloaded, total, None);
    }
    file.flush()
        .await
        .map_err(|err| format!("LSP dosyasi yazilamadi: {err}"))?;
    Ok(())
}

async fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .await
        .map_err(|err| format!("Hash hesaplanamadi: {err}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 8192];
    loop {
        let count = file
            .read(&mut buffer)
            .await
            .map_err(|err| format!("Hash hesaplanamadi: {err}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let digest = hasher.finalize();
    let mut output = String::with_capacity(64);
    for byte in digest {
        output.push_str(&format!("{:02x}", byte));
    }
    Ok(output)
}

async fn unpack_tar_gz(archive_path: PathBuf, target_dir: PathBuf) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&archive_path)
            .map_err(|err| format!("LSP arsiv acilamadi: {err}"))?;
        let decompressor = GzDecoder::new(file);
        let mut archive = Archive::new(decompressor);
        archive
            .unpack(&target_dir)
            .map_err(|err| format!("LSP arsiv acilamadi: {err}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|err| format!("LSP arsiv acilamadi: {err}"))??;
    Ok(())
}

async fn unpack_gz(archive_path: PathBuf, target_path: PathBuf) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&archive_path)
            .map_err(|err| format!("LSP arsiv acilamadi: {err}"))?;
        let mut decoder = GzDecoder::new(file);
        let mut output = std::fs::File::create(&target_path)
            .map_err(|err| format!("LSP dosyasi yazilamadi: {err}"))?;
        std::io::copy(&mut decoder, &mut output)
            .map_err(|err| format!("LSP arsiv acilamadi: {err}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|err| format!("LSP arsiv acilamadi: {err}"))??;
    Ok(())
}

async fn unpack_zip(archive_path: PathBuf, target_dir: PathBuf) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&archive_path)
            .map_err(|err| format!("LSP arsiv acilamadi: {err}"))?;
        let mut archive = ZipArchive::new(file)
            .map_err(|err| format!("LSP arsiv acilamadi: {err}"))?;
        std::fs::create_dir_all(&target_dir)
            .map_err(|err| format!("LSP dizini olusturulamadi: {err}"))?;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|err| format!("LSP arsiv acilamadi: {err}"))?;
            let entry_name = entry.name().to_string();
            let entry_path = target_dir.join(entry_name);
            if entry.name().ends_with('/') {
                std::fs::create_dir_all(&entry_path)
                    .map_err(|err| format!("LSP dizini olusturulamadi: {err}"))?;
            } else {
                if let Some(parent) = entry_path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|err| format!("LSP dizini olusturulamadi: {err}"))?;
                }
                let mut output = std::fs::File::create(&entry_path)
                    .map_err(|err| format!("LSP dosyasi yazilamadi: {err}"))?;
                std::io::copy(&mut entry, &mut output)
                    .map_err(|err| format!("LSP dosyasi yazilamadi: {err}"))?;
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|err| format!("LSP arsiv acilamadi: {err}"))??;
    Ok(())
}

async fn find_binary_in_dir(root: PathBuf, name: &str) -> Result<PathBuf, String> {
    let mut queue = vec![root];
    while let Some(dir) = queue.pop() {
        let mut entries = fs::read_dir(&dir)
            .await
            .map_err(|err| format!("LSP dizini okunamadi: {err}"))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|err| format!("LSP dizini okunamadi: {err}"))?
        {
            let path = entry.path();
            if path.is_dir() {
                queue.push(path);
                continue;
            }
            if let Some(file_name) = path.file_name().and_then(|value| value.to_str()) {
                if file_name == name {
                    return Ok(path);
                }
            }
        }
    }
    Err(format!("LSP dosyasi bulunamadi: {name}"))
}

async fn normalize_extracted_dir(extracted_root: PathBuf, target_dir: PathBuf) -> Result<(), String> {
    let mut entries = fs::read_dir(&extracted_root)
        .await
        .map_err(|err| format!("LSP dizini okunamadi: {err}"))?;
    let mut children = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|err| format!("LSP dizini okunamadi: {err}"))?
    {
        children.push(entry.path());
    }
    if children.len() == 1 && children[0].is_dir() {
        let mut inner_entries = fs::read_dir(&children[0])
            .await
            .map_err(|err| format!("LSP dizini okunamadi: {err}"))?;
        fs::create_dir_all(&target_dir)
            .await
            .map_err(|err| format!("LSP dizini olusturulamadi: {err}"))?;
        while let Some(entry) = inner_entries
            .next_entry()
            .await
            .map_err(|err| format!("LSP dizini okunamadi: {err}"))?
        {
            let target = target_dir.join(entry.file_name());
            fs::rename(entry.path(), target)
                .await
                .map_err(|err| format!("LSP tasinamadi: {err}"))?;
        }
    } else {
        fs::create_dir_all(&target_dir)
            .await
            .map_err(|err| format!("LSP dizini olusturulamadi: {err}"))?;
        for child in children {
            let file_name = child
                .file_name()
                .map(|name| name.to_owned())
                .ok_or("LSP tasinamadi: dosya adi bulunamadi".to_string())?;
            let target = target_dir.join(file_name);
            fs::rename(child, target)
                .await
                .map_err(|err| format!("LSP tasinamadi: {err}"))?;
        }
    }
    fs::remove_dir_all(extracted_root)
        .await
        .map_err(|err| format!("LSP gecici dizin temizlenemedi: {err}"))?;
    Ok(())
}

#[cfg(unix)]
async fn ensure_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .await
        .map_err(|err| format!("LSP dosyasi okunamadi: {err}"))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .await
        .map_err(|err| format!("LSP izni ayarlanamadi: {err}"))?;
    Ok(())
}

#[cfg(not(unix))]
async fn ensure_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn node_archive_name(version: &str) -> Result<String, String> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    match (os, arch) {
        ("macos", "aarch64") => Ok(format!("node-v{version}-darwin-arm64.tar.gz")),
        ("macos", "x86_64") => Ok(format!("node-v{version}-darwin-x64.tar.gz")),
        ("linux", "x86_64") => Ok(format!("node-v{version}-linux-x64.tar.gz")),
        _ => Err("Node LSP indirme bu platformda desteklenmiyor.".to_string()),
    }
}

async fn ensure_node_installed(
    app: &AppHandle,
    language_id: &str,
) -> Result<PathBuf, String> {
    const NODE_VERSION: &str = "20.11.1";
    let node_dir = lsp_node_dir(app, NODE_VERSION)?;
    let node_bin = node_dir.join("bin").join("node");
    if node_bin.exists() {
        return Ok(node_bin);
    }
    emit_lsp_download(app, language_id, "node", "starting", 0, None, None);
    let archive_name = node_archive_name(NODE_VERSION)?;
    let base_url = format!("https://nodejs.org/dist/v{NODE_VERSION}");
    let archive_url = format!("{base_url}/{archive_name}");
    let shasums_url = format!("{base_url}/SHASUMS256.txt");
    let client = Client::new();
    let shasums = client
        .get(&shasums_url)
        .header("User-Agent", "Friday-LSP-Downloader")
        .send()
        .await
        .map_err(|err| format!("Node hash listesi indirilemedi: {err}"))?
        .text()
        .await
        .map_err(|err| format!("Node hash listesi indirilemedi: {err}"))?;
    let expected_hash = shasums
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?;
            if name == archive_name {
                Some(hash.to_string())
            } else {
                None
            }
        })
        .ok_or("Node hash bulunamadi.".to_string())?;
    let temp_dir = lsp_cache_dir(app)?.join("tmp");
    fs::create_dir_all(&temp_dir)
        .await
        .map_err(|err| format!("Gecici dizin olusturulamadi: {err}"))?;
    let temp_file = temp_dir.join(format!("node-{archive_name}-{}.tar.gz", now_millis()));
    download_to_path(&client, app, &archive_url, &temp_file, language_id, "node").await?;
    emit_lsp_download(app, language_id, "node", "verifying", 0, None, None);
    let actual_hash = sha256_file(&temp_file).await?;
    if actual_hash != expected_hash {
        return Err("Node hash dogrulamasi basarisiz.".to_string());
    }
    emit_lsp_download(app, language_id, "node", "extracting", 0, None, None);
    let extracted_root = temp_dir.join(format!("node-extract-{}", now_millis()));
    fs::create_dir_all(&extracted_root)
        .await
        .map_err(|err| format!("Gecici dizin olusturulamadi: {err}"))?;
    unpack_tar_gz(temp_file.clone(), extracted_root.clone()).await?;
    fs::remove_file(&temp_file)
        .await
        .map_err(|err| format!("Gecici dosya silinemedi: {err}"))?;
    if node_dir.exists() {
        fs::remove_dir_all(&node_dir)
            .await
            .map_err(|err| format!("Eski Node dizini silinemedi: {err}"))?;
    }
    normalize_extracted_dir(extracted_root, node_dir.clone()).await?;
    emit_lsp_download(app, language_id, "node", "installed", 0, None, None);
    Ok(node_dir.join("bin").join("node"))
}

async fn ensure_npm_package(
    app: &AppHandle,
    language_id: &str,
    package: &str,
    version: &str,
) -> Result<(), String> {
    let node_bin = ensure_node_installed(app, language_id).await?;
    let node_dir = lsp_node_dir(app, "20.11.1")?;
    let npm_cli = node_dir
        .join("lib")
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js");
    let lsp_dir = lsp_cache_dir(app)?;
    fs::create_dir_all(&lsp_dir)
        .await
        .map_err(|err| format!("LSP dizini olusturulamadi: {err}"))?;
    let package_dir = lsp_node_modules_dir(app)?.join(package);
    if package_dir.exists() {
        let pkg_json = package_dir.join("package.json");
        if let Ok(contents) = fs::read(&pkg_json).await {
            if let Ok(parsed) = serde_json::from_slice::<Value>(&contents) {
                if parsed
                    .get("version")
                    .and_then(|value| value.as_str())
                    .is_some_and(|value| value == version)
                {
                    return Ok(());
                }
            }
        }
    }
    emit_lsp_download(app, language_id, package, "installing", 0, None, None);
    let status = Command::new(node_bin)
        .arg(npm_cli)
        .arg("install")
        .arg(format!("{package}@{version}"))
        .arg("--prefix")
        .arg(&lsp_dir)
        .arg("--no-audit")
        .arg("--no-fund")
        .arg("--silent")
        .status()
        .await
        .map_err(|err| format!("NPM calistirilamadi: {err}"))?;
    if !status.success() {
        return Err(format!("{package} kurulumu basarisiz."));
    }
    emit_lsp_download(app, language_id, package, "installed", 0, None, None);
    Ok(())
}

async fn ensure_node_lsp(
    app: &AppHandle,
    language_id: &str,
    package: &str,
    version: &str,
    bin_name: &str,
    args: &[&str],
) -> Result<LspCommandSpec, String> {
    ensure_npm_package(app, language_id, package, version).await?;
    let node_bin = ensure_node_installed(app, language_id).await?;
    let bin_path = lsp_node_modules_dir(app)?.join(".bin").join(bin_name);
    if !bin_path.exists() {
        return Err(format!("{package} icin calistirilabilir bulunamadi."));
    }
    let mut command_args = Vec::with_capacity(args.len() + 1);
    command_args.push(bin_path.to_string_lossy().to_string());
    command_args.extend(args.iter().map(|value| value.to_string()));
    Ok(LspCommandSpec {
        command: node_bin,
        args: command_args,
    })
}

async fn ensure_gopls(app: &AppHandle, language_id: &str) -> Result<LspCommandSpec, String> {
    const GOPLS_VERSION: &str = "v0.21.0";
    let bin_dir = lsp_bin_dir(app)?;
    fs::create_dir_all(&bin_dir)
        .await
        .map_err(|err| format!("LSP dizini olusturulamadi: {err}"))?;
    let gopls_path = bin_dir.join("gopls");
    if gopls_path.exists() {
        return Ok(LspCommandSpec {
            command: gopls_path,
            args: Vec::new(),
        });
    }
    emit_lsp_download(app, language_id, "gopls", "installing", 0, None, None);
    let status = Command::new("go")
        .arg("install")
        .arg(format!("golang.org/x/tools/gopls@{GOPLS_VERSION}"))
        .env("GOBIN", &bin_dir)
        .status()
        .await
        .map_err(|err| format!("Go bulunamadi: {err}"))?;
    if !status.success() {
        return Err("gopls kurulumu basarisiz. Go toolchain kurulu olmalidir.".to_string());
    }
    ensure_executable(&gopls_path).await?;
    emit_lsp_download(app, language_id, "gopls", "installed", 0, None, None);
    Ok(LspCommandSpec {
        command: gopls_path,
        args: Vec::new(),
    })
}

async fn ensure_terraform_ls(
    app: &AppHandle,
    language_id: &str,
) -> Result<LspCommandSpec, String> {
    const TERRAFORM_LS_VERSION: &str = "v0.38.3";
    let bin_dir = lsp_bin_dir(app)?;
    fs::create_dir_all(&bin_dir)
        .await
        .map_err(|err| format!("LSP dizini olusturulamadi: {err}"))?;
    let terraform_ls_path = bin_dir.join("terraform-ls");
    if terraform_ls_path.exists() {
        return Ok(LspCommandSpec {
            command: terraform_ls_path,
            args: vec!["serve".to_string()],
        });
    }
    emit_lsp_download(app, language_id, "terraform-ls", "installing", 0, None, None);
    let status = Command::new("go")
        .arg("install")
        .arg(format!("github.com/hashicorp/terraform-ls@{TERRAFORM_LS_VERSION}"))
        .env("GOBIN", &bin_dir)
        .status()
        .await
        .map_err(|err| format!("Go bulunamadi: {err}"))?;
    if !status.success() {
        return Err("terraform-ls kurulumu basarisiz. Go toolchain kurulu olmalidir."
            .to_string());
    }
    ensure_executable(&terraform_ls_path).await?;
    emit_lsp_download(app, language_id, "terraform-ls", "installed", 0, None, None);
    Ok(LspCommandSpec {
        command: terraform_ls_path,
        args: vec!["serve".to_string()],
    })
}

async fn ensure_sourcekit(app: &AppHandle, language_id: &str) -> Result<LspCommandSpec, String> {
    emit_lsp_download(app, language_id, "sourcekit-lsp", "checking", 0, None, None);
    let output = Command::new("xcrun")
        .arg("-f")
        .arg("sourcekit-lsp")
        .output()
        .await
        .map_err(|err| format!("sourcekit-lsp bulunamadi: {err}"))?;
    if !output.status.success() {
        return Err("sourcekit-lsp bulunamadi. Xcode/Swift toolchain kurulu olmalidir."
            .to_string());
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Err("sourcekit-lsp bulunamadi.".to_string());
    }
    Ok(LspCommandSpec {
        command: PathBuf::from(path),
        args: Vec::new(),
    })
}

async fn resolve_xcrun_tool(tool: &str) -> Result<PathBuf, String> {
    let output = Command::new("xcrun")
        .arg("-f")
        .arg(tool)
        .output()
        .await
        .map_err(|err| format!("{tool} bulunamadi: {err}"))?;
    if !output.status.success() {
        return Err(format!("{tool} bulunamadi."));
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return Err(format!("{tool} bulunamadi."));
    }
    Ok(PathBuf::from(path))
}

async fn ensure_clangd(app: &AppHandle, language_id: &str) -> Result<LspCommandSpec, String> {
    if std::env::consts::OS != "macos" {
        return Err("clangd bu platformda desteklenmiyor.".to_string());
    }
    emit_lsp_download(app, language_id, "clangd", "checking", 0, None, None);
    let path = resolve_xcrun_tool("clangd").await.map_err(|_| {
        "clangd bulunamadi. Xcode Command Line Tools kurulu olmalidir.".to_string()
    })?;
    Ok(LspCommandSpec {
        command: path,
        args: Vec::new(),
    })
}

async fn ensure_binary_download(
    app: &AppHandle,
    language_id: &str,
    server_name: &str,
    url: &str,
    output_path: PathBuf,
    needs_gzip: bool,
) -> Result<PathBuf, String> {
    if output_path.exists() {
        return Ok(output_path);
    }
    emit_lsp_download(app, language_id, server_name, "starting", 0, None, None);
    let client = Client::new();
    let temp_dir = lsp_cache_dir(app)?.join("tmp");
    fs::create_dir_all(&temp_dir)
        .await
        .map_err(|err| format!("Gecici dizin olusturulamadi: {err}"))?;
    let file_name = output_path
        .file_name()
        .ok_or("LSP dosya adi bulunamadi".to_string())?;
    let temp_file = temp_dir.join(format!(
        "{}-{}.download",
        file_name.to_string_lossy(),
        now_millis()
    ));
    download_to_path(&client, app, url, &temp_file, language_id, server_name).await?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|err| format!("LSP dizini olusturulamadi: {err}"))?;
    }
    if needs_gzip {
        emit_lsp_download(app, language_id, server_name, "extracting", 0, None, None);
        unpack_gz(temp_file.clone(), output_path.clone()).await?;
        fs::remove_file(&temp_file)
            .await
            .map_err(|err| format!("Gecici dosya silinemedi: {err}"))?;
    } else {
        fs::rename(&temp_file, &output_path)
            .await
            .map_err(|err| format!("LSP dosyasi yazilamadi: {err}"))?;
    }
    ensure_executable(&output_path).await?;
    let actual_hash = sha256_file(&output_path).await?;
    let mut manifest = read_manifest(app).await?;
    let key = format!("{server_name}:{language_id}");
    manifest.entries.insert(
        key,
        LspManifestEntry {
            version: "latest".to_string(),
            sha256: actual_hash,
        },
    );
    write_manifest(app, &manifest).await?;
    emit_lsp_download(app, language_id, server_name, "installed", 0, None, None);
    Ok(output_path)
}

async fn ensure_rust_analyzer(app: &AppHandle, language_id: &str) -> Result<LspCommandSpec, String> {
    if std::env::consts::OS != "macos" {
        return Err("Rust LSP bu platformda desteklenmiyor.".to_string());
    }
    let bin_dir = lsp_bin_dir(app)?;
    let binary = bin_dir.join("rust-analyzer");
    let arch = std::env::consts::ARCH;
    let asset = match arch {
        "aarch64" => "rust-analyzer-aarch64-apple-darwin.gz",
        "x86_64" => "rust-analyzer-x86_64-apple-darwin.gz",
        _ => return Err("Rust LSP bu platformda desteklenmiyor.".to_string()),
    };
    let url = format!(
        "https://github.com/rust-lang/rust-analyzer/releases/latest/download/{asset}"
    );
    let path = ensure_binary_download(app, language_id, "rust-analyzer", &url, binary, true).await?;
    Ok(LspCommandSpec {
        command: path,
        args: Vec::new(),
    })
}

async fn ensure_sqls(app: &AppHandle, language_id: &str) -> Result<LspCommandSpec, String> {
    const SQLS_VERSION: &str = "0.2.45";
    let bin_dir = lsp_bin_dir(app)?;
    let binary = bin_dir.join("sqls");
    if binary.exists() {
        return Ok(LspCommandSpec {
            command: binary,
            args: vec!["-stdio".to_string()],
        });
    }
    emit_lsp_download(app, language_id, "sqls", "starting", 0, None, None);
    let temp_dir = lsp_cache_dir(app)?.join("tmp");
    fs::create_dir_all(&temp_dir)
        .await
        .map_err(|err| format!("Gecici dizin olusturulamadi: {err}"))?;
    let archive_name = format!("sqls-darwin-{SQLS_VERSION}.zip");
    let url = format!(
        "https://github.com/lighttiger2505/sqls/releases/download/v{SQLS_VERSION}/{archive_name}"
    );
    let archive_path = temp_dir.join(format!("sqls-{SQLS_VERSION}-{}.zip", now_millis()));
    let client = Client::new();
    download_to_path(&client, app, &url, &archive_path, language_id, "sqls").await?;
    emit_lsp_download(app, language_id, "sqls", "extracting", 0, None, None);
    let extract_root = temp_dir.join(format!("sqls-extract-{}", now_millis()));
    unpack_zip(archive_path.clone(), extract_root.clone()).await?;
    fs::remove_file(&archive_path)
        .await
        .map_err(|err| format!("Gecici dosya silinemedi: {err}"))?;
    let extracted_bin = find_binary_in_dir(extract_root.clone(), "sqls").await?;
    fs::create_dir_all(&bin_dir)
        .await
        .map_err(|err| format!("LSP dizini olusturulamadi: {err}"))?;
    fs::rename(&extracted_bin, &binary)
        .await
        .map_err(|err| format!("LSP dosyasi yazilamadi: {err}"))?;
    ensure_executable(&binary).await?;
    fs::remove_dir_all(&extract_root)
        .await
        .map_err(|err| format!("Gecici dizin temizlenemedi: {err}"))?;
    let actual_hash = sha256_file(&binary).await?;
    let mut manifest = read_manifest(app).await?;
    manifest.entries.insert(
        "sqls:sql".to_string(),
        LspManifestEntry {
            version: SQLS_VERSION.to_string(),
            sha256: actual_hash,
        },
    );
    write_manifest(app, &manifest).await?;
    emit_lsp_download(app, language_id, "sqls", "installed", 0, None, None);
    Ok(LspCommandSpec {
        command: binary,
        args: vec!["-stdio".to_string()],
    })
}

async fn ensure_lemminx(app: &AppHandle, language_id: &str) -> Result<LspCommandSpec, String> {
    const LEMMINX_VERSION: &str = "0.3.0";
    let bin_dir = lsp_bin_dir(app)?;
    let jar_path = bin_dir.join("lemminx.jar");
    if !jar_path.exists() {
        emit_lsp_download(app, language_id, "lemminx", "starting", 0, None, None);
        let url = format!("https://github.com/eclipse/lemminx/releases/download/{LEMMINX_VERSION}/org.eclipse.lsp4xml-{LEMMINX_VERSION}-uber.jar");
        let client = Client::new();
        download_to_path(&client, app, &url, &jar_path, language_id, "lemminx").await?;
        let actual_hash = sha256_file(&jar_path).await?;
        let mut manifest = read_manifest(app).await?;
        manifest.entries.insert(
            "lemminx:xml".to_string(),
            LspManifestEntry {
                version: LEMMINX_VERSION.to_string(),
                sha256: actual_hash,
            },
        );
        write_manifest(app, &manifest).await?;
    }
    let java_output = Command::new("java")
        .arg("-version")
        .output()
        .await
        .map_err(|err| format!("Java bulunamadi: {err}"))?;
    if !java_output.status.success() {
        return Err("Java bulunamadi. XML LSP icin Java kurulumu gerekir.".to_string());
    }
    Ok(LspCommandSpec {
        command: PathBuf::from("java"),
        args: vec!["-jar".to_string(), jar_path.to_string_lossy().to_string()],
    })
}

async fn ensure_lua_ls(app: &AppHandle, language_id: &str) -> Result<LspCommandSpec, String> {
    let bin_dir = lsp_bin_dir(app)?;
    let binary = bin_dir.join("lua-language-server");
    if binary.exists() {
        return Ok(LspCommandSpec {
            command: binary,
            args: Vec::new(),
        });
    }
    let arch = std::env::consts::ARCH;
    let asset = match arch {
        "aarch64" => "lua-language-server-3.17.1-darwin-arm64.tar.gz",
        "x86_64" => "lua-language-server-3.17.1-darwin-x64.tar.gz",
        _ => return Err("Lua LSP bu platformda desteklenmiyor.".to_string()),
    };
    let url = format!(
        "https://github.com/LuaLS/lua-language-server/releases/download/3.17.1/{asset}"
    );
    emit_lsp_download(app, language_id, "lua-language-server", "starting", 0, None, None);
    let temp_dir = lsp_cache_dir(app)?.join("tmp");
    fs::create_dir_all(&temp_dir)
        .await
        .map_err(|err| format!("Gecici dizin olusturulamadi: {err}"))?;
    let archive_path = temp_dir.join(format!("lua-ls-{}.tar.gz", now_millis()));
    let client = Client::new();
    download_to_path(&client, app, &url, &archive_path, language_id, "lua-language-server").await?;
    emit_lsp_download(app, language_id, "lua-language-server", "extracting", 0, None, None);
    let extract_root = temp_dir.join(format!("lua-extract-{}", now_millis()));
    unpack_tar_gz(archive_path.clone(), extract_root.clone()).await?;
    fs::remove_file(&archive_path)
        .await
        .map_err(|err| format!("Gecici dosya silinemedi: {err}"))?;
    let extracted_bin = find_binary_in_dir(extract_root.clone(), "lua-language-server").await?;
    fs::create_dir_all(&bin_dir)
        .await
        .map_err(|err| format!("LSP dizini olusturulamadi: {err}"))?;
    fs::rename(&extracted_bin, &binary)
        .await
        .map_err(|err| format!("LSP dosyasi yazilamadi: {err}"))?;
    ensure_executable(&binary).await?;
    fs::remove_dir_all(&extract_root)
        .await
        .map_err(|err| format!("Gecici dizin temizlenemedi: {err}"))?;
    let actual_hash = sha256_file(&binary).await?;
    let mut manifest = read_manifest(app).await?;
    manifest.entries.insert(
        "lua-language-server:lua".to_string(),
        LspManifestEntry {
            version: "3.17.1".to_string(),
            sha256: actual_hash,
        },
    );
    write_manifest(app, &manifest).await?;
    emit_lsp_download(app, language_id, "lua-language-server", "installed", 0, None, None);
    Ok(LspCommandSpec {
        command: binary,
        args: Vec::new(),
    })
}

async fn ensure_ruby_lsp(app: &AppHandle, language_id: &str) -> Result<LspCommandSpec, String> {
    const RUBY_LSP_VERSION: &str = "0.26.5";
    let ruby_dir = lsp_cache_dir(app)?.join("ruby");
    let bin_dir = ruby_dir.join("bin");
    let ruby_lsp_bin = bin_dir.join("ruby-lsp");
    if ruby_lsp_bin.exists() {
        return Ok(LspCommandSpec {
            command: ruby_lsp_bin,
            args: Vec::new(),
        });
    }
    emit_lsp_download(app, language_id, "ruby-lsp", "installing", 0, None, None);
    fs::create_dir_all(&bin_dir)
        .await
        .map_err(|err| format!("Ruby LSP dizini olusturulamadi: {err}"))?;
    let status = Command::new("ruby")
        .arg("-S")
        .arg("gem")
        .arg("install")
        .arg("ruby-lsp")
        .arg("-v")
        .arg(RUBY_LSP_VERSION)
        .arg("--no-document")
        .arg("--install-dir")
        .arg(ruby_dir.join("gems"))
        .arg("--bindir")
        .arg(&bin_dir)
        .status()
        .await
        .map_err(|err| format!("Ruby bulunamadi: {err}"))?;
    if !status.success() {
        return Err("ruby-lsp kurulumu basarisiz. Ruby kurulu olmalidir.".to_string());
    }
    emit_lsp_download(app, language_id, "ruby-lsp", "installed", 0, None, None);
    Ok(LspCommandSpec {
        command: ruby_lsp_bin,
        args: Vec::new(),
    })
}

async fn ensure_marksman(app: &AppHandle, language_id: &str) -> Result<LspCommandSpec, String> {
    if std::env::consts::OS != "macos" {
        return Err("Markdown LSP bu platformda desteklenmiyor.".to_string());
    }
    let bin_dir = lsp_bin_dir(app)?;
    let binary = bin_dir.join("marksman");
    let url = "https://github.com/artempyanykh/marksman/releases/latest/download/marksman-macos";
    let path = ensure_binary_download(app, language_id, "marksman", url, binary, false).await?;
    Ok(LspCommandSpec {
        command: path,
        args: vec!["server".to_string()],
    })
}

async fn ensure_taplo(app: &AppHandle, language_id: &str) -> Result<LspCommandSpec, String> {
    if std::env::consts::OS != "macos" {
        return Err("TOML LSP bu platformda desteklenmiyor.".to_string());
    }
    let bin_dir = lsp_bin_dir(app)?;
    let binary = bin_dir.join("taplo");
    let arch = std::env::consts::ARCH;
    let asset = match arch {
        "aarch64" => "taplo-darwin-aarch64.gz",
        "x86_64" => "taplo-darwin-x86_64.gz",
        _ => return Err("TOML LSP bu platformda desteklenmiyor.".to_string()),
    };
    let url = format!(
        "https://github.com/tamasfe/taplo/releases/latest/download/{asset}"
    );
    let path = ensure_binary_download(app, language_id, "taplo", &url, binary, true).await?;
    Ok(LspCommandSpec {
        command: path,
        args: vec!["lsp".to_string(), "stdio".to_string()],
    })
}

async fn resolve_lsp_command(app: &AppHandle, language_id: &str) -> Result<LspCommandSpec, String> {
    match language_id {
        "typescript" | "javascript" => {
            ensure_npm_package(app, language_id, "typescript", "5.9.3").await?;
            ensure_node_lsp(
                app,
                language_id,
                "typescript-language-server",
                "5.1.3",
                "typescript-language-server",
                &["--stdio"],
            )
            .await
        }
        "json" => {
            ensure_node_lsp(
                app,
                language_id,
                "vscode-json-languageserver-bin",
                "1.0.1",
                "vscode-json-language-server",
                &["--stdio"],
            )
            .await
        }
        "css" | "scss" | "less" => {
            ensure_node_lsp(
                app,
                language_id,
                "vscode-css-languageserver-bin",
                "1.4.0",
                "vscode-css-language-server",
                &["--stdio"],
            )
            .await
        }
        "html" => {
            ensure_node_lsp(
                app,
                language_id,
                "vscode-html-languageserver-bin",
                "1.4.0",
                "vscode-html-language-server",
                &["--stdio"],
            )
            .await
        }
        "dockerfile" => {
            ensure_node_lsp(
                app,
                language_id,
                "dockerfile-language-server-nodejs",
                "0.15.0",
                "docker-langserver",
                &["--stdio"],
            )
            .await
        }
        "markdown" => ensure_marksman(app, language_id).await,
        "rust" => ensure_rust_analyzer(app, language_id).await,
        "python" => {
            ensure_node_lsp(
                app,
                language_id,
                "pyright",
                "1.1.408",
                "pyright-langserver",
                &["--stdio"],
            )
            .await
        }
        "go" => ensure_gopls(app, language_id).await,
        "terraform" => ensure_terraform_ls(app, language_id).await,
        "sql" => ensure_sqls(app, language_id).await,
        "yaml" => {
            ensure_node_lsp(
                app,
                language_id,
                "yaml-language-server",
                "1.19.2",
                "yaml-language-server",
                &["--stdio"],
            )
            .await
        }
        "toml" => ensure_taplo(app, language_id).await,
        "xml" => ensure_lemminx(app, language_id).await,
        "lua" => ensure_lua_ls(app, language_id).await,
        "graphql" => {
            ensure_node_lsp(
                app,
                language_id,
                "graphql-language-service-cli",
                "3.5.0",
                "graphql-lsp",
                &["--stdio"],
            )
            .await
        }
        "prisma" => {
            ensure_node_lsp(
                app,
                language_id,
                "@prisma/language-server",
                "31.4.0",
                "prisma-language-server",
                &["--stdio"],
            )
            .await
        }
        "ruby" => ensure_ruby_lsp(app, language_id).await,
        "c" | "cpp" => ensure_clangd(app, language_id).await,
        "shell" => {
            ensure_node_lsp(
                app,
                language_id,
                "bash-language-server",
                "5.6.0",
                "bash-language-server",
                &["start"],
            )
            .await
        }
        "php" => {
            ensure_node_lsp(
                app,
                language_id,
                "intelephense",
                "1.16.4",
                "intelephense",
                &["--stdio"],
            )
            .await
        }
        "swift" => ensure_sourcekit(app, language_id).await,
        _ => Err("Bu dil icin LSP desteklenmiyor.".to_string()),
    }
}

fn spawn_lsp_tasks(
    app: AppHandle,
    workspace_id: String,
    language_id: String,
    mut child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    mut command_rx: mpsc::Receiver<LspCommand>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
) {
    let app_for_reader = app.clone();
    tokio::spawn(async move {
        if let Err(err) =
            lsp_reader_loop(app_for_reader, workspace_id, language_id, stdout, pending).await
        {
            eprintln!("[lsp] reader stopped: {err}");
        }
        let _ = child.kill().await;
    });

    tokio::spawn(async move {
        if let Err(err) = lsp_writer_loop(stdin, &mut command_rx).await {
            eprintln!("[lsp] writer stopped: {err}");
        }
    });
}

async fn lsp_writer_loop(
    mut stdin: ChildStdin,
    command_rx: &mut mpsc::Receiver<LspCommand>,
) -> Result<(), String> {
    while let Some(command) = command_rx.recv().await {
        let message = match command {
            LspCommand::Request { id, method, params } => {
                json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
            }
            LspCommand::Notify { method, params } => {
                json!({ "jsonrpc": "2.0", "method": method, "params": params })
            }
            LspCommand::Shutdown => {
                let payload = json!({ "jsonrpc": "2.0", "method": "shutdown", "params": {} });
                write_message(&mut stdin, &payload).await?;
                let exit_payload = json!({ "jsonrpc": "2.0", "method": "exit", "params": {} });
                write_message(&mut stdin, &exit_payload).await?;
                return Ok(());
            }
        };
        write_message(&mut stdin, &message).await?;
    }
    Ok(())
}

async fn lsp_reader_loop(
    app: AppHandle,
    workspace_id: String,
    language_id: String,
    stdout: ChildStdout,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
) -> Result<(), String> {
    let mut reader = BufReader::new(stdout);
    loop {
        let message = read_message(&mut reader).await?;
        if let Some(id) = message.get("id").and_then(|value| value.as_i64()) {
            let tx = {
                let mut pending = pending.lock().await;
                pending.remove(&id)
            };
            if let Some(tx) = tx {
                let _ = tx.send(message);
            }
            continue;
        }
        let method = message
            .get("method")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        let payload = LspNotification {
            workspace_id: workspace_id.clone(),
            language_id: language_id.clone(),
            method,
            params,
        };
        let _ = app.emit("lsp-notification", payload);
    }
}

async fn write_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    let payload = serde_json::to_string(message).map_err(|err| err.to_string())?;
    let header = format!("Content-Length: {}\r\n\r\n", payload.as_bytes().len());
    stdin
        .write_all(header.as_bytes())
        .await
        .map_err(|err| err.to_string())?;
    stdin
        .write_all(payload.as_bytes())
        .await
        .map_err(|err| err.to_string())?;
    stdin.flush().await.map_err(|err| err.to_string())?;
    Ok(())
}

async fn read_message(reader: &mut BufReader<ChildStdout>) -> Result<Value, String> {
    let mut content_length: usize = 0;
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .await
            .map_err(|err| err.to_string())?;
        if bytes == 0 {
            return Err("LSP stream closed".to_string());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("Content-Length:") {
            content_length = value.trim().parse::<usize>().unwrap_or(0);
        }
    }
    if content_length == 0 {
        return Err("Missing Content-Length".to_string());
    }
    let mut buffer = vec![0u8; content_length];
    reader
        .read_exact(&mut buffer)
        .await
        .map_err(|err| err.to_string())?;
    serde_json::from_slice(&buffer).map_err(|err| err.to_string())
}

#[tauri::command]
pub(crate) async fn lsp_start(
    workspace_id: String,
    language_id: String,
    state: tauri::State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Err("LSP remote backend modunda desteklenmiyor.".to_string());
    }
    let workspaces = state.workspaces.lock().await;
    let entry = workspaces
        .get(&workspace_id)
        .ok_or("workspace not found")?;
    let root = PathBuf::from(&entry.path);
    drop(workspaces);
    let mut manager = state.lsp_manager.lock().await;
    manager
        .start(&app, workspace_id, language_id, root)
        .await
}

#[tauri::command]
pub(crate) async fn lsp_stop(
    workspace_id: String,
    language_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Err("LSP remote backend modunda desteklenmiyor.".to_string());
    }
    let mut manager = state.lsp_manager.lock().await;
    manager.stop(workspace_id, language_id).await
}

#[tauri::command]
pub(crate) async fn lsp_request(
    workspace_id: String,
    language_id: String,
    method: String,
    params: Value,
    state: tauri::State<'_, AppState>,
) -> Result<Value, String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Err("LSP remote backend modunda desteklenmiyor.".to_string());
    }
    let manager = state.lsp_manager.lock().await;
    manager
        .request(workspace_id, language_id, method, params)
        .await
}

#[tauri::command]
pub(crate) async fn lsp_notify(
    workspace_id: String,
    language_id: String,
    method: String,
    params: Value,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if remote_backend::is_remote_mode(&*state).await {
        return Err("LSP remote backend modunda desteklenmiyor.".to_string());
    }
    let manager = state.lsp_manager.lock().await;
    manager
        .notify(workspace_id, language_id, method, params)
        .await
}
