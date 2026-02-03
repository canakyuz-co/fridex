# Friday: Diger AI (Claude/Gemini vb.) Entegrasyonlari

Bu dokuman, **Codex app-server akisini bozmadan** Friday icinde baska LLM'leri (Claude, Gemini, vb.) nasil entegre ettigimizi ve hangi entegrasyon yollarinin ne zaman secilecegini tanimlar.

## Hedef ve Kapsam

- Codex (OpenAI) tarafi: `codex app-server` JSON-RPC akisi **degismeyecek**.
- Diger modeller: Friday icinde **ayri bir "provider" katmani** ile calisacak.
- Amaç: tek chat UI icinden model degistirerek (Codex/Claude/Gemini/Custom) calismak.

## Protokoller: API vs CLI vs ACP

### 1) API (HTTP)
- Provider'a dogrudan HTTP ile istek atilir (Anthropic/Google/OpenAI vb.).
- Auth genellikle API key ister (uygulama settings veya environment).
- Avantaj: deterministic, kolay debug, model listesi API ile alinabilir.
- Dezavantaj: API key yonetimi + rate limit + streaming format farkliliklari.

### 2) CLI (Komut calistirma)
- Friday, local'de kurulu bir CLI'yi cagirir (ornegin `claude`, `gemini`).
- Auth genellikle CLI'nin kendi login/config mekanizmasidir (kullanici makinesinde).
- Avantaj: API key girmeden calisabilir (CLI login ile).
- Dezavantaj: model listesi her CLI'da yok; output formatlari degisebilir.

### 3) ACP (Agent Client Protocol)
- ACP, editor/host (Friday) ile agent (CLI) arasinda ortak bir protokol.
- Zed ekosisteminde yaygin; bazi agent'lar ACP ile dogrudan stream-json delta gonderebilir.
- Avantaj: streaming + arayuzle daha "canli" deneyim, tool-calling benzeri akislara uygun.
- Dezavantaj: her provider/CLI ACP desteklemez; kurulum/komut seti degisebilir.

## Friday'de Mimari (Codex bozulmadan)

### Codex (Degismez)
- Backend, workspace basina `codex app-server` spawn eder.
- UI, thread/list, thread/resume, thread/archive uzerinden ilerler.

### Diger Modeller (Yeni katman)
- Settings > Other AI bolumunde provider tanimi:
  - `id`: UI'da provider prefix'i (ornegin `claude`, `gemini`)
  - `provider`: `claude | gemini | custom`
  - `protocol`: `api | cli | acp`
  - `command`: CLI/ACP icin calistirilacak komut (ornegin `gemini`, `claude`)
  - `args`: opsiyonel argumanlar
  - `env`: opsiyonel environment degiskenleri (PII/secret loglanmaz)
  - `models`: UI model listesi (fallback liste veya API/CLI'dan gelen liste)

Model secimi UI'da `providerId:modelName` formatindadir (ornegin `gemini:gemini-1.5-pro`).

## Model Listesi: "API key zorunlulugu" olmadan

### Gercekci beklenti
- Bazi CLI'lar non-interactive model listesi sunmaz.
- Bu durumda Friday, **fallback (varsayilan) model listesi** koyar ve kullanici isterse manuel duzenler.

### Strateji (sirayla)
1. `protocol=cli` ve `command` varsa: CLI ile modeli calistir (key gerekmeden).
2. `protocol=api` ise: API key varsa model listesini API'dan cek.
3. Hicbiri yoksa: fallback listeyi kullan (kullanici manuel duzenleyebilir).

## Hangi AI'lar Nasil Entegre Edilebilir (Matris)

### Bulut (Provider API)
- OpenAI: API (OpenAI SDK / REST); ayrica "OpenAI-compatible" endpoint'ler ile ayni adapter.
- Anthropic (Claude): API (x-api-key) / CLI (claude toolchain varsa).
- Google Gemini: API (Generative Language) / CLI (gemini-cli) / ACP (gemini CLI ACP destekliyorsa).
- Mistral, Groq, Together, Fireworks, DeepSeek vb.: genelde API; cogu OpenAI-compatible da olabilir.

### Lokal / Self-hosted
- Ollama: OpenAI-compatible proxy veya kendi API; Friday icin "OpenAI-compatible" provider olarak baglanabilir.
- LM Studio: OpenAI-compatible server.
- llama.cpp server / vLLM: OpenAI-compatible server (deployment kolayligi icin tercih).

### CLI tabanli akillar
- Claude CLI: CLI output formatlari ile entegre edilir; streaming icin stream-json benzeri mod varsa kullanilir.
- Gemini CLI: headless prompt modu ile entegre edilir; cikti JSON ise parse edilir, degilse plain text kabul edilir.

## Guvenlik Notlari
- API key/secret'ler loglanmaz.
- UI'da kaydedilen anahtarlar: best-effort; tercihen environment/secret manager.
- Multi-tenant hedefi icin: ileride workspace bazli key/role ayrimi (tenant_id) zorunlu olacak.

## Performans Notlari
- Chat gecmisi prompt'a eklenirken ring-buffer yaklasimi ile son N mesaj tutulur.
  - Time: O(N), Space: O(N) (N sabit limit).
- CLI/ACP cagirilari: tek istek tek proses (simdilik). Ileride session reuse + debounce eklenebilir.

