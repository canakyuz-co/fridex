# CI/CD & Server Provisioning

## Amac
Kullanicinin bir urunu canliya cikarma surecini tek panelden, tekrar edilebilir ve guvenli bir sekilde yonetmek.
Odak: CI/CD pipeline, self-hosted runner kurulumu, sunucu konfig, servis/DB yonetimi, gozetim (observability) ve geri donus (rollback).

## Kapsam ve Non-Goals

### Kapsam
- GitHub Actions workflow uretimi (build/test/deploy).
- Self-hosted runner kurulumu ve dogrulama.
- Sunucu konfig (Nginx/Caddy, TLS, reverse proxy).
- Servis kurulumu (Grafana, Kafka, Redis, Supabase/PocketBase vb.).
- Database yonetimi (migration, backup, restore, role).
- Observability (log/metric/trace) ve audit log.
- Release playbook ve rollback.

### Non-Goals
- Tam otomatik IaC (Terraform/Ansible) zorunlulugu yok.
- Kubernetes zorunlu degil (ileride opsiyonel).
- Tek bir bulut saglayiciyla sinirli degil.

## Fazlar (MVP -> Genisleme)

### Faz 0: Kapsam Kilidi
- Kabul kriterleri netlestirilir.
- Risk matrisi ve oncelikler belirlenir.
- Cikti: MVP tanimi, scope.

### Faz 1: Proje Profili (Repo Analizi)
- Stack tespiti (frontend/backend/build/test komutlari).
- Env/secret gereksinimleri cikarilir.
- Cikti: Deployment profili (manifest).

### Faz 2: CI/CD Template Uretimi
- GitHub Actions workflow uretimi.
- Pipeline adimlari: lint/test/build/deploy.
- Cikti: `ci.yaml`, `deploy.yaml`.

### Faz 3: Self-Hosted Runner Kurulumu
- Runner bootstrap script.
- Servis olarak calisma, otomatik restart.
- Cikti: Runner dogrulama raporu.

### Faz 4: Sunucu Konfig Katmani
- Nginx/Caddy reverse proxy.
- TLS/SSL ayarlari.
- Cikti: Konfig template + healthcheck.

### Faz 5: Servis Kurulumu
- Kafka, Grafana, Redis, Supabase/PocketBase vb.
- Docker/Compose veya bare-metal secimi.
- Cikti: Servis kurulum recipe.

### Faz 6: Database Yonetimi
- Migration, backup, restore, role/policy.
- Cikti: DB yonetim playbook.

### Faz 7: Observability ve Guvenlik
- Log/metric/trace pipeline.
- Secrets yonetimi (KMS/Secrets Manager opsiyonel).
- Cikti: Observability policy.

### Faz 8: Release Playbook
- Go-live checklist ve rollback.
- Cikti: Uctan uca canliya cikis recetesi.

## Temel Is Akislari

### 1) CI/CD Akisi
1. Repo analizi -> pipeline uretimi.
2. Runner secimi (cloud/self-hosted).
3. Deploy hedefi ve env/secret map.
4. Pipeline tetikleme + raporlama.

### 2) Sunucu Hazirligi
1. SSH erisimi + kullanici/izinler.
2. Runner kurulumu + servis kaydi.
3. Reverse proxy + TLS.
4. Uygulama servisleri ve DB.

### 3) Release ve Rollback
1. Preflight kontroller (healthcheck, db migration dry-run).
2. Canary/blue-green opsiyonlari.
3. Rollback plan.

## Gereksinimler
- GitHub Actions erisimi.
- SSH key management.
- Sunucu root veya uygun sudo yetkisi.
- Secrets ve env degiskenleri.

## Kabul Kriterleri (MVP)
- Repo profili otomatik olusuyor.
- CI/CD workflow uretimi calisir.
- Self-hosted runner kurulur ve job alir.
- Temel deploy ve healthcheck basarili.

## Riskler ve Onlemler
- Runner token sızıntisi: token rotation + scope limit.
- Config drift: konfig şablonlari + denetim.
- Flaky deploy: idempotent script + retry.
- Gizli veri: PII masking + log kisiti.

## Paylasim Planı (Milestone)
- Faz 2: CI/CD template yayin.
- Faz 3: Self-hosted runner kurulumu demo.
- Faz 4: Reverse proxy + TLS demo.
- Faz 8: Release playbook paylasimi.

## Notlar
- Docker/Compose ile basit baslangic onerilir; K8s opsiyonel.
- Tüm adimlar modular olmalidir (yeniden kullanilabilir recipes).
- Her adimda audit log tutulur.
