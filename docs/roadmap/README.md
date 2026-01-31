# Roadmap Overview

This folder groups the main product documents so each pillar can evolve independently.

## Pillars

1) [Product Vision & Naming](Product_Vision_and_Naming.md)  
   - Positioning, target user, and core promise. (Konumlandırma, hedef kullanıcı ve temel vaat.)
   - Naming strategy, brand voice, and UX tone. (İsimlendirme stratejisi, marka sesi ve UX tonu.)
   - Non-goals to keep scope tight. (Kapsamı sıkı tutan kapsam dışı maddeler.)

2) [Core App Architecture (Frontend + Tauri)](Core_App_Architecture.md)  
   - Runtime boundaries (React/Vite vs Tauri/Rust). (Çalışma zamanı sınırları: React/Vite ve Tauri/Rust.)
   - IPC contracts, event flow, and initialization order. (IPC sözleşmeleri, olay akışı ve başlatma sırası.)
   - Performance budgets and platform constraints. (Performans bütçeleri ve platform kısıtları.)

3) [Code Editor System](Code_Editor_System.md)  
   - Editor engine choice and integration strategy. (Editör motoru seçimi ve entegrasyon stratejisi.)
   - Buffer model, file tabs, and diff/patch flow. (Buffer modeli, dosya sekmeleri ve diff/patch akışı.)
   - Responsiveness and memory limits for large files. (Büyük dosyalar için hız ve bellek limitleri.)

4) [Task & TODO Orchestration](Task_and_TODO_Orchestration.md)  
   - Task model, lifecycle, and ownership rules. (Görev modeli, yaşam döngüsü ve sahiplik kuralları.)
   - UI surfaces (home, thread, editor sidebar). (UI yüzeyleri: ana ekran, thread, editör kenar paneli.)
   - Links to files, threads, and external issues. (Dosyalar, thread'ler ve dış issue bağlantıları.)

5) [File Management & Indexing](File_Management_and_Indexing.md)  
   - Root allowlist, permissions, and safety checks. (Kök izin listesi, yetkiler ve güvenlik kontrolleri.)
   - Index strategy, search, and cache invalidation. (İndeks stratejisi, arama ve cache geçersiz kılma.)
   - Large file handling and streaming reads. (Büyük dosya yönetimi ve stream okuma.)

6) [MCP Integrations & Adapters](MCP_Integrations_and_Adapters.md)  
   - Adapter registry, discovery, and capability maps. (Adapter kaydı, keşif ve yetenek haritaları.)
   - Context binding with tenant/workspace scoping. (Tenant/workspace kapsamı ile context bağlama.)
   - Retry/backoff, caching, and error normalization. (Retry/backoff, cache ve hata normalizasyonu.)

7) [GitHub Issues & Dev Workflow](GitHub_Issues_and_Dev_Workflow.md)  
   - Issue/PR sync, labels, and comment flows. (Issue/PR senkronu, label ve yorum akışları.)
   - Rate-limit handling and UX fallbacks. (Rate-limit yönetimi ve UX fallback'leri.)
   - Thread-to-issue linking for traceability. (İzlenebilirlik için thread-issue bağlama.)

8) [Observability, Security & Governance](Observability_Security_and_Governance.md)  
   - Logs, metrics, traces, and correlation IDs. (Loglar, metrikler, izler ve korelasyon ID'leri.)
   - RBAC/ABAC gates for sensitive actions. (Hassas işlemler için RBAC/ABAC kapıları.)
   - Audit trail, data retention, and privacy policy. (Denetim izi, veri saklama ve gizlilik politikası.)

9) [CI/CD & Server Provisioning](CI_CD_and_Server_Provisioning.md)  
   - Pipelines, self-hosted runners, and deploy templates. (Pipeline, self-hosted runner ve deploy şablonları.)
   - Server config, services, and DB management. (Sunucu konfig, servis ve DB yönetimi.)
   - Release playbook and rollback. (Release playbook ve rollback.)

## Current Stack Snapshot

- Frontend: React + Vite (TypeScript), feature-sliced UI. (Frontend: React + Vite (TypeScript), feature-sliced UI.)
- Backend: Tauri (Rust), IPC commands + app-server orchestration. (Backend: Tauri (Rust), IPC komutları + app-server orkestrasyonu.)
- Storage: Local JSON (`workspaces.json`, `settings.json`) + `localStorage`. (Depolama: Yerel JSON (`workspaces.json`, `settings.json`) + `localStorage`.)
- Integrations: Git/GitHub via `gh`, file ops via Tauri. (Entegrasyonlar: `gh` ile Git/GitHub, Tauri ile dosya işlemleri.)
