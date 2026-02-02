# Zed Esinli Editor Yol Haritası (Friday)

Bu doküman, mevcut kod tabanına göre Zed seviyesine yaklaşmak için eksik/gerekli alanları ve aşamalı planı özetler.  
Odak: **Editor çekirdeği / performans**, sonra collab/remote/plugin alanları.

## 1) Mevcut Durum (Koddaki Kanıtlarla)

- **LSP altyapısı var**: `src-tauri/src/lsp.rs` (LSP süreç yönetimi, request/notify).
- **Command palette / search UI var**: `EditorCommandPalette`, `EditorWorkspaceSearch` (frontend).
- **Workspace search rg ile**: backend `search_workspace_files` → `rg`.
- **Remote backend iskeleti var**: `src-tauri/src/remote_backend.rs` ve state içinde `remote_backend`.
- **Tauri event hub + LSP events**: `src/services/events.ts` ve `lsp-notification`.
- **Collab menü/flag’ler var, core CRDT yok**: `collaboration_mode_list`, `experimental_collab_enabled`.
- **Keymap yapısı var**: `EditorKeymap` tipleri ve komutlar için kısmi altyapı.

## 2) Zed Seviyesi İçin Eksik/Geride Olanlar

1) **Editor çekirdeği Rust değil**
   - Şu an Monaco kullanıyoruz (React).
   - Zed farkı: Rust text buffer + GPU render.
2) **GPU render pipeline yok**
   - UI web tabanlı, GPU native değil.
3) **Tree-sitter / incremental parse yok**
   - LSP var ama lokal incremental parse yok.
4) **CRDT tabanlı gerçek collaboration yok**
   - Sadece “collaboration mode” bayrakları var.
5) **Remote dev gerçek değil**
   - Remote backend iskeleti var ama file/LSP routing sınırlı.
6) **Plugin / extension sandbox yok**
   - API + izin modeli yok.
7) **Perf gates/telemetry yok**
   - P95 input/scroll metriği ölçülmüyor.

## 3) Zed’den Esinlenilecek Temel Alanlar

- Rendering + input latency (core)
- Text buffer mimarisi (rope/piece-table)
- CRDT / multi-cursor sync
- Remote workspace + remote LSP
- Plugin API / sandbox

## 4) Hedef Mimari (8–10 madde)

1) **Çekirdek metin modeli (Rust)**  
   Rope / piece-table, O(log n) edit; undo/redo.
2) **Selection + cursor modeli**  
   Multi-cursor, range selection; saf veri yapıları.
3) **Viewport/layout hesaplayıcı**  
   Sadece görünen satırlar; line cache + invalidation.
4) **Render pipeline**  
   Önce basit (Canvas) → sonra GPU (GPUI benzeri).
5) **Input latency metrikleri**  
   P95 keystroke‑to‑paint; scroll FPS sampling.
6) **Large file stratejisi**  
   1MB+ dosyada minimal features; chunked load.
7) **Bridge/IPC**  
   Editor core ↔ frontend minimal JSON‑RPC.
8) **Feature flag**  
   “native editor core” ile Monaco paralel.
9) **Test harness**  
   Rope edit benchmark + random edit fuzz.
10) **Compatibility planı**  
    LSP/search/file ops mevcut altyapıya bağlanır.

## 5) Karmaşıklık Özeti (Zorunlu)

- Insert/Delete: **O(log n)** (rope/piece-table)
- Cursor/selection: **O(1)**
- Render: **O(v)** (viewport lines)
- Undo/Redo: **O(log n)** + snapshot pointer **O(1)**
- Memory: **O(n)** text + **O(k)** edit history

## 6) Faz Planı

### Faz 0 – Mimari & Lisans
- Zed core GPL/AGPL → **kod alınmaz**, sadece esinlenilir.
- GPUI Apache 2 → kullanılabilir.

### Faz 1 – Editor Core (Rust)
- Text buffer + cursor + undo + file IO + basic render.

### Faz 2 – Performans
- GPU render + scroll optimizasyonu + large file strategy.

### Faz 3 – LSP + Search
- Autocomplete, go‑to, symbols; rg tabanlı search.

### Faz 4 – Collab
- CRDT + presence + follow + channel/room.

### Faz 5 – Remote Dev
- Remote fs + remote LSP + task runner.

### Faz 6 – Parlatma
- Keymaps, plugin API, telemetry, UI polish, stability.

## 7) Önerilen İlk Adım (Küçük ama Doğru Başlangıç)

- `src-tauri/src/shared/editor_core/` altında **Rust editor core skeleton**
- Rope + basit insert/delete + cursor
- Basit benchmark test (time/space)
- Feature flag ile frontend’den ops gönderimi (no UI yet)

## 8) Notlar

- Hedef “Zed hissi” için öncelik: **render + input latency + büyük dosya performansı**.
- CRDT/remote/plugin uzun vadeli fazlara alınmalıdır.
