import Editor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import Close from "lucide-react/dist/esm/icons/x";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { EditorPlaceholder } from "./EditorPlaceholder";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

type EditorBuffer = {
  path: string;
  content: string;
  language: string | null;
  isDirty: boolean;
  isSaving: boolean;
  isLoading: boolean;
  error: string | null;
  isTruncated: boolean;
};

type EditorViewProps = {
  workspaceId: string | null;
  openPaths: string[];
  activePath: string | null;
  buffersByPath: Record<string, EditorBuffer>;
  onSelectPath: (path: string) => void;
  onClosePath: (path: string) => void;
  onContentChange: (path: string, value: string) => void;
  onSavePath: (path: string) => void;
};

function configureMonaco(monaco: Monaco) {
  const globalScope = globalThis as typeof globalThis & {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  };
  if (globalScope.MonacoEnvironment?.getWorker) {
    return;
  }
  globalScope.MonacoEnvironment = {
    getWorker: (_workerId, label) => {
      if (label === "json") {
        return new jsonWorker();
      }
      if (label === "css" || label === "scss" || label === "less") {
        return new cssWorker();
      }
      if (label === "html" || label === "handlebars" || label === "razor") {
        return new htmlWorker();
      }
      if (label === "typescript" || label === "javascript") {
        return new tsWorker();
      }
      return new editorWorker();
    },
  };
}

export function EditorView({
  workspaceId,
  openPaths,
  activePath,
  buffersByPath,
  onSelectPath,
  onClosePath,
  onContentChange,
  onSavePath,
}: EditorViewProps) {
  const activeBuffer = activePath ? buffersByPath[activePath] : null;
  const activePathRef = useRef(activePath);
  const monacoRef = useRef<Monaco | null>(null);

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  const tabs = useMemo(
    () =>
      openPaths.map((path) => ({
        path,
        name: path.split("/").pop() ?? path,
        isActive: path === activePath,
        buffer: buffersByPath[path],
      })),
    [openPaths, activePath, buffersByPath],
  );

  const applyTheme = useCallback((monaco: Monaco) => {
    const styles = getComputedStyle(document.documentElement);
    const readVar = (name: string, fallback: string) => {
      const value = styles.getPropertyValue(name).trim();
      return value || fallback;
    };
    monaco.editor.defineTheme("friday-app", {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": readVar("--surface-messages", "#0c1119"),
        "editor.foreground": readVar("--text-primary", "#e6e7ea"),
        "editorLineNumber.foreground": readVar("--text-dim", "#586072"),
        "editorLineNumber.activeForeground": readVar("--text-stronger", "#c5cad6"),
        "editorCursor.foreground": readVar("--border-accent", "#9bd1ff"),
        "editor.selectionBackground": readVar("--surface-active", "#234c74"),
        "editor.inactiveSelectionBackground": readVar("--surface-hover", "#1a2a3f"),
        "editorIndentGuide.background": readVar("--border-muted", "#1c2533"),
        "editorIndentGuide.activeBackground": readVar("--border-strong", "#2a3546"),
        "editor.lineHighlightBackground": "transparent",
        "editorLineHighlightBorder": "transparent",
        "editorGutter.background": readVar("--surface-messages", "#0c1119"),
        "editorWhitespace.foreground": readVar("--border-muted", "#2a3546"),
        "editorRuler.foreground": readVar("--border-muted", "#1f2a3a"),
      },
    });
    monaco.editor.setTheme("friday-app");
  }, []);

  const handleBeforeMount = useCallback((monaco: Monaco) => {
    configureMonaco(monaco);
    applyTheme(monaco);
  }, [applyTheme]);

  const handleMount = useCallback(
    (editorInstance: Monaco.editor.IStandaloneCodeEditor, monaco: Monaco) => {
      monacoRef.current = monaco;
      applyTheme(monaco);
      editorInstance.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
        () => {
          const path = activePathRef.current;
          if (path) {
            onSavePath(path);
          }
        },
      );
    },
    [applyTheme, onSavePath],
  );

  useEffect(() => {
    if (!monacoRef.current) {
      return;
    }
    const observer = new MutationObserver(() => {
      if (monacoRef.current) {
        applyTheme(monacoRef.current);
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    return () => observer.disconnect();
  }, [applyTheme]);

  if (!workspaceId) {
    return <EditorPlaceholder hasWorkspace={false} />;
  }

  return (
    <div className="editor-shell">
      <div className="editor-tabs" role="tablist" aria-label="Editor tabs">
        {tabs.length === 0 ? (
          <div className="editor-tabs-empty">Dosya acmak icin soldan sec.</div>
        ) : (
          tabs.map((tab) => (
            <button
              key={tab.path}
              type="button"
              className={`editor-tab${tab.isActive ? " is-active" : ""}`}
              onClick={() => onSelectPath(tab.path)}
              aria-current={tab.isActive ? "page" : undefined}
            >
              <span className="editor-tab-title">{tab.name}</span>
              {tab.buffer?.isDirty ? (
                <span className="editor-tab-dirty" aria-hidden>
                  ●
                </span>
              ) : null}
              <span
                className="editor-tab-close"
                role="button"
                tabIndex={0}
                aria-label={`${tab.name} dosyasini kapat`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClosePath(tab.path);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onClosePath(tab.path);
                  }
                }}
              >
                <Close size={12} aria-hidden />
              </span>
            </button>
          ))
        )}
      </div>
      {activeBuffer ? (
        <div className="editor-canvas">
          {activeBuffer.isLoading ? (
            <div className="editor-state">Dosya yukleniyor...</div>
          ) : activeBuffer.error ? (
            <div className="editor-state error">{activeBuffer.error}</div>
          ) : (
            <>
              {activeBuffer.isTruncated ? (
                <div className="editor-banner">
                  Buyuk dosya kesildi. Duzenleme devre disi.
                </div>
              ) : null}
              <Editor
                path={activeBuffer.path}
                language={activeBuffer.language ?? undefined}
                value={activeBuffer.content}
                theme="friday-dark"
                height="100%"
                width="100%"
                onChange={(value) => {
                  onContentChange(activeBuffer.path, value ?? "");
                }}
                beforeMount={handleBeforeMount}
                onMount={handleMount}
                options={{
                  minimap: { enabled: false },
                  fontFamily: "var(--code-font-family)",
                  fontSize: 13,
                  lineHeight: 20,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  readOnly: activeBuffer.isTruncated,
                  renderWhitespace: "selection",
                  renderLineHighlight: "none",
                }}
              />
            </>
          )}
        </div>
      ) : (
        <EditorPlaceholder hasWorkspace />
      )}
    </div>
  );
}
