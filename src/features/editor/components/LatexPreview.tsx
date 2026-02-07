import { useEffect, useRef, useState } from "react";
import type { LatexCompileDiagnostic } from "../../../services/tauri";
import { latexCompile } from "../../../services/tauri";

type LatexPreviewProps = {
  workspaceId: string;
  path: string;
  source: string;
};

function base64ToObjectUrl(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: "application/pdf" });
  return URL.createObjectURL(blob);
}

export function LatexPreview({ workspaceId, path, source }: LatexPreviewProps) {
  const [status, setStatus] = useState<"idle" | "compiling" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<LatexCompileDiagnostic[]>([]);
  const [log, setLog] = useState<string>("");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const pendingRef = useRef<LatexPreviewProps | null>(null);
  const pendingKeyRef = useRef<string | null>(null);
  const lastCompiledKeyRef = useRef<string | null>(null);
  const debounceRef = useRef<number | null>(null);

  const CLIENT_COMPILE_TIMEOUT_MS = 70_000;

  const formatError = (err: unknown) => {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const anyErr = err as any;
      if (typeof anyErr.message === "string") return anyErr.message;
      try {
        return JSON.stringify(err);
      } catch {
        return String(err);
      }
    }
    return "Derleme hatasi";
  };

  const getDebounceMs = (nextSource: string) => {
    const size = nextSource.length;
    if (size < 8_000) return 450;
    if (size < 20_000) return 700;
    if (size < 50_000) return 1_200;
    return 1_800;
  };

  useEffect(() => {
    // Debounce compile to keep typing smooth.
    setStatus("compiling");
    setError(null);

    const key = `${workspaceId}::${path}::${source}`;
    pendingRef.current = { workspaceId, path, source };
    pendingKeyRef.current = key;

    const scheduleCompile = (next: LatexPreviewProps, nextKey: string) => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
      }
      const delay = getDebounceMs(next.source);
      debounceRef.current = window.setTimeout(() => {
        if (inFlightRef.current) return;
        if (nextKey === lastCompiledKeyRef.current) {
          pendingRef.current = null;
          pendingKeyRef.current = null;
          return;
        }
        pendingRef.current = null;
        pendingKeyRef.current = null;
        startCompile(next, nextKey);
      }, delay);
    };

    const startCompile = (next: LatexPreviewProps, nextKey: string) => {
      const requestId = ++requestIdRef.current;
      setStatus("compiling");
      setError(null);

      const compilePromise = Promise.race([
        latexCompile(next.workspaceId, next.path, next.source),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => {
            reject(new Error(`Derleme zaman asimi (${CLIENT_COMPILE_TIMEOUT_MS / 1000}s).`));
          }, CLIENT_COMPILE_TIMEOUT_MS);
        }),
      ])
        .then((res) => {
          if (requestId !== requestIdRef.current) return;
          setDiagnostics(res.diagnostics ?? []);
          setLog(res.log ?? "");

          const nextUrl = base64ToObjectUrl(res.pdfBase64);
          if (urlRef.current) {
            URL.revokeObjectURL(urlRef.current);
          }
          urlRef.current = nextUrl;
          setPdfUrl(nextUrl);
          setStatus("ready");
          lastCompiledKeyRef.current = nextKey;
        })
        .catch((err: unknown) => {
          if (requestId !== requestIdRef.current) return;
          setError(formatError(err));
          setStatus("error");
        })
        .finally(() => {
          if (inFlightRef.current === compilePromise) {
            inFlightRef.current = null;
          }
          if (pendingRef.current && pendingKeyRef.current) {
            scheduleCompile(pendingRef.current, pendingKeyRef.current);
          }
        });

      inFlightRef.current = compilePromise;
    };

    scheduleCompile({ workspaceId, path, source }, key);

    return () => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [workspaceId, path, source]);

  useEffect(() => {
    return () => {
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
      }
    };
  }, []);

  return (
    <div className="editor-latex-preview">
      <div className="editor-latex-toolbar">
        <span className="editor-latex-status">
          {status === "compiling" ? "Derleniyor..." : status === "ready" ? "Hazir" : "Hata"}
        </span>
        {diagnostics.length ? (
          <span className="editor-latex-pill">{diagnostics.length} tanilama</span>
        ) : null}
      </div>

      {error ? <div className="editor-latex-error">{error}</div> : null}

      {diagnostics.length ? (
        <div className="editor-latex-diagnostics" role="list">
          {diagnostics.slice(0, 8).map((d, idx) => (
            <div key={`${idx}-${d.message}`} className="editor-latex-diagnostic" role="listitem">
              <span className={`editor-latex-diag-level level-${d.level}`}>{d.level}</span>
              <span className="editor-latex-diag-message">
                {d.line ? `L${d.line}: ` : ""}
                {d.message}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {pdfUrl ? (
        <>
          {/* WebView engines can be picky about PDF-in-iframe; embed/object is more reliable here. */}
          <object
            key={pdfUrl}
            className="editor-latex-frame"
            data={pdfUrl}
            type="application/pdf"
            aria-label="LaTeX Preview"
          >
            <embed src={pdfUrl} type="application/pdf" />
          </object>
          <div className="editor-latex-download">
            <a href={pdfUrl} target="_blank" rel="noreferrer">
              PDF'i yeni pencerede ac
            </a>
          </div>
        </>
      ) : (
        <div className="editor-latex-empty">
          {status === "compiling" ? "PDF olusuyor..." : "Onizleme yok"}
        </div>
      )}

      {/* Keep the log available for debugging without overwhelming the UI. */}
      {log ? (
        <details className="editor-latex-log">
          <summary>Derleme logu</summary>
          <pre>{log}</pre>
        </details>
      ) : null}
    </div>
  );
}
