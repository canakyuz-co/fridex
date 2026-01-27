import Editor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import Close from "lucide-react/dist/esm/icons/x";
import { useCallback, useMemo } from "react";
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
};

let monacoConfigured = false;

function configureMonaco(monaco: Monaco) {
  if (monacoConfigured) {
    return;
  }
  monacoConfigured = true;
  const globalScope = globalThis as typeof globalThis & {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  };
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

  monaco.editor.defineTheme("friday-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#0d121b",
      "editor.foreground": "#e6e7ea",
      "editorLineNumber.foreground": "#5d6472",
      "editorLineNumber.activeForeground": "#c4c8d2",
      "editorCursor.foreground": "#9fd2ff",
      "editor.selectionBackground": "#275a8f",
      "editor.inactiveSelectionBackground": "#1b2b3f",
      "editorIndentGuide.background": "#1f2835",
      "editorIndentGuide.activeBackground": "#2e3a4b",
      "editor.lineHighlightBackground": "#111826",
      "editorLineHighlightBorder": "#1b2433",
    },
  });
}

export function EditorView({
  workspaceId,
  openPaths,
  activePath,
  buffersByPath,
  onSelectPath,
  onClosePath,
  onContentChange,
}: EditorViewProps) {
  const activeBuffer = activePath ? buffersByPath[activePath] : null;

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

  const handleBeforeMount = useCallback((monaco: Monaco) => {
    configureMonaco(monaco);
    monaco.editor.setTheme("friday-dark");
  }, []);

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
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  scrollBeyondLastLine: false,
                  wordWrap: "on",
                  readOnly: activeBuffer.isTruncated,
                  renderWhitespace: "selection",
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
