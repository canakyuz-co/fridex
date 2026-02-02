import Editor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import Close from "lucide-react/dist/esm/icons/x";
import Code from "lucide-react/dist/esm/icons/code";
import Columns2 from "lucide-react/dist/esm/icons/columns-2";
import Eye from "lucide-react/dist/esm/icons/eye";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorPlaceholder } from "./EditorPlaceholder";
import { Markdown } from "../../messages/components/Markdown";
import { EditorCommandPalette } from "./EditorCommandPalette";
import { EditorWorkspaceSearch } from "./EditorWorkspaceSearch";
import type { EditorKeymap, LaunchScriptEntry } from "../../../types";
import { lspRequest, searchWorkspaceFiles } from "../../../services/tauri";
import { languageFromPath } from "../../../utils/syntax";

import "monaco-editor/esm/vs/language/css/monaco.contribution";
import "monaco-editor/esm/vs/language/html/monaco.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";

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

type WorkspaceSearchResult = {
  path: string;
  line: number;
  column: number;
  lineText: string;
  matchText?: string | null;
};

type WorkspaceSymbolResult = {
  name: string;
  kind: "class" | "symbol";
  line: number;
  column: number;
  detail?: string | null;
};

type WorkspaceSearchTab =
  | "all"
  | "files"
  | "actions"
  | "text"
  | "classes"
  | "symbols";

type WorkspaceSearchAction = {
  id: string;
  label: string;
  detail?: string | null;
  onSelect: () => void;
};

type EditorViewProps = {
  workspaceId: string | null;
  openPaths: string[];
  activePath: string | null;
  buffersByPath: Record<string, EditorBuffer>;
  availablePaths: string[];
  editorKeymap: EditorKeymap;
  workspacePath: string | null;
  launchScript: string | null;
  launchScripts: LaunchScriptEntry[];
  onSelectPath: (path: string) => void;
  onClosePath: (path: string) => void;
  onOpenPath: (path: string) => void;
  onContentChange: (path: string, value: string) => void;
  onSavePath: (path: string) => void;
  onRunLaunchScript: () => void;
  onRunLaunchScriptEntry: (id: string) => void;
  onMonacoReady?: (
    monaco: Monaco,
    editor: MonacoEditor.IStandaloneCodeEditor,
  ) => void;
};

function isMarkdownPath(path: string | null) {
  if (!path) {
    return false;
  }
  return path.endsWith(".md") || path.endsWith(".mdx");
}

function configureMonaco(_monaco: Monaco) {
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
  availablePaths,
  editorKeymap,
  workspacePath,
  launchScript,
  launchScripts,
  onSelectPath,
  onClosePath,
  onOpenPath,
  onContentChange,
  onSavePath,
  onRunLaunchScript,
  onRunLaunchScriptEntry,
  onMonacoReady,
}: EditorViewProps) {
  const activeBuffer = activePath ? buffersByPath[activePath] : null;
  const activeBufferPath = activeBuffer?.path ?? null;
  const isMarkdown = activeBuffer
    ? activeBuffer.language === "markdown" || isMarkdownPath(activeBuffer.path)
    : false;
  const [markdownView, setMarkdownView] = useState<"code" | "preview" | "split">(
    "code",
  );
  const activePathRef = useRef(activePath);
  const monacoRef = useRef<Monaco | null>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [workspaceSearchOpen, setWorkspaceSearchOpen] = useState(false);
  const [workspaceSearchTab, setWorkspaceSearchTab] = useState<WorkspaceSearchTab>("all");
  const [workspaceSearchQuery, setWorkspaceSearchQuery] = useState("");
  const [workspaceSearchInclude, _setWorkspaceSearchInclude] = useState("");
  const [workspaceSearchExclude, _setWorkspaceSearchExclude] = useState(
    "node_modules/**, dist/**, .git/**",
  );
  const [workspaceSearchResults, setWorkspaceSearchResults] = useState<
    WorkspaceSearchResult[]
  >([]);
  const [workspaceSearchLoading, setWorkspaceSearchLoading] = useState(false);
  const [workspaceSearchError, setWorkspaceSearchError] = useState<string | null>(null);
  const [workspaceSymbolResults, setWorkspaceSymbolResults] = useState<
    WorkspaceSymbolResult[]
  >([]);
  const [workspaceSymbolLoading, setWorkspaceSymbolLoading] = useState(false);
  const [workspaceSymbolError, setWorkspaceSymbolError] = useState<string | null>(null);
  const shiftTapRef = useRef(0);
  const pendingRevealRef = useRef<{ path: string; line: number; column: number } | null>(
    null,
  );

  const openCommandPalette = useCallback(() => {
    setCommandPaletteOpen(true);
  }, []);

  const closeCommandPalette = useCallback(() => {
    setCommandPaletteOpen(false);
  }, []);

  const openWorkspaceSearch = useCallback(() => {
    setWorkspaceSearchTab("all");
    setWorkspaceSearchOpen(true);
    setCommandPaletteOpen(false);
  }, []);

  const openWorkspaceSearchWithTab = useCallback((tab: WorkspaceSearchTab) => {
    setWorkspaceSearchTab(tab);
    setWorkspaceSearchOpen(true);
    setCommandPaletteOpen(false);
  }, []);

  const closeWorkspaceSearch = useCallback(() => {
    setWorkspaceSearchOpen(false);
  }, []);

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    setWorkspaceSearchOpen(false);
    setWorkspaceSearchQuery("");
    setWorkspaceSearchResults([]);
    setWorkspaceSearchError(null);
    setWorkspaceSearchTab("all");
    setWorkspaceSymbolResults([]);
    setWorkspaceSymbolError(null);
  }, [workspaceId]);

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
    const normalizeColor = (value: string, fallback: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return fallback;
      }
      if (trimmed.startsWith("#")) {
        return trimmed;
      }
      const rgbMatch = trimmed.match(
        /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i,
      );
      if (rgbMatch) {
        const toHex = (input: string) => {
          const num = Number(input);
          return Number.isFinite(num)
            ? num.toString(16).padStart(2, "0")
            : "00";
        };
        return `#${toHex(rgbMatch[1])}${toHex(rgbMatch[2])}${toHex(rgbMatch[3])}`;
      }
      return fallback;
    };
    const readVar = (name: string, fallback: string) => {
      const value = styles.getPropertyValue(name);
      return normalizeColor(value, fallback);
    };
    monaco.editor.defineTheme("friday-app", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "96AAC8" },
        { token: "punctuation", foreground: "C8D2DC" },
        { token: "property", foreground: "FF7B72" },
        { token: "tag", foreground: "FF7B72" },
        { token: "constant", foreground: "FF7B72" },
        { token: "symbol", foreground: "FF7B72" },
        { token: "deleted", foreground: "FF7B72" },
        { token: "number", foreground: "F2CC60" },
        { token: "boolean", foreground: "F2CC60" },
        { token: "selector", foreground: "7EE787" },
        { token: "attribute.name", foreground: "7EE787" },
        { token: "string", foreground: "7EE787" },
        { token: "character", foreground: "7EE787" },
        { token: "builtin", foreground: "7EE787" },
        { token: "inserted", foreground: "7EE787" },
        { token: "operator", foreground: "C8D2DC" },
        { token: "entity", foreground: "C8D2DC" },
        { token: "url", foreground: "C8D2DC" },
        { token: "variable", foreground: "C8D2DC" },
        { token: "keyword", foreground: "8BD5FF" },
        { token: "attribute.value", foreground: "8BD5FF" },
        { token: "atrule", foreground: "8BD5FF" },
        { token: "function", foreground: "D2A8FF" },
        { token: "type", foreground: "D2A8FF" },
        { token: "class", foreground: "D2A8FF" },
      ],
      colors: {
        "editor.background": readVar("--surface-sidebar", "#0c1119"),
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
        "editorGutter.background": readVar("--surface-sidebar", "#0c1119"),
        "editorWhitespace.foreground": readVar("--border-muted", "#2a3546"),
        "editorRuler.foreground": readVar("--border-muted", "#1f2a3a"),
      },
    });
    monaco.editor.setTheme("friday-app");
  }, []);

  const handleBeforeMount = useCallback((monaco: Monaco) => {
    configureMonaco(monaco);
    monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
    monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
    applyTheme(monaco);
  }, [applyTheme]);

  const handleMount = useCallback(
    (editorInstance: MonacoEditor.IStandaloneCodeEditor, monaco: Monaco) => {
      monacoRef.current = monaco;
      editorRef.current = editorInstance;
      applyTheme(monaco);
      onMonacoReady?.(monaco, editorInstance);
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
    [applyTheme, onSavePath, onMonacoReady],
  );

  const openFind = useCallback(() => {
    editorRef.current?.getAction("actions.find")?.run();
  }, []);

  const openReplace = useCallback(() => {
    editorRef.current?.getAction("editor.action.startFindReplaceAction")?.run();
  }, []);

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

  useEffect(() => {
    if (!activeBufferPath) {
      return;
    }
    setMarkdownView(isMarkdown ? "split" : "code");
  }, [activeBufferPath, isMarkdown]);

  useEffect(() => {
    const pending = pendingRevealRef.current;
    if (!pending || pending.path !== activeBufferPath || !editorRef.current) {
      return;
    }
    editorRef.current.revealLineInCenter(pending.line);
    editorRef.current.setPosition({
      lineNumber: pending.line,
      column: pending.column,
    });
    editorRef.current.focus();
    pendingRevealRef.current = null;
  }, [activeBufferPath, activeBuffer?.content]);

  useEffect(() => {
    if (!workspaceSearchOpen || !workspaceId) {
      return;
    }
    const trimmed = workspaceSearchQuery.trim();
    if (!trimmed) {
      setWorkspaceSearchResults([]);
      setWorkspaceSearchError(null);
      return;
    }
    const includeGlobs = workspaceSearchInclude
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const excludeGlobs = workspaceSearchExclude
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const handle = window.setTimeout(() => {
      setWorkspaceSearchLoading(true);
      searchWorkspaceFiles(
        workspaceId,
        trimmed,
        includeGlobs,
        excludeGlobs,
        200,
      )
        .then((results) => {
          setWorkspaceSearchResults(results);
          setWorkspaceSearchError(null);
        })
        .catch((error) => {
          setWorkspaceSearchResults([]);
          setWorkspaceSearchError(
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          setWorkspaceSearchLoading(false);
        });
    }, 250);
    return () => window.clearTimeout(handle);
  }, [
    workspaceId,
    workspaceSearchExclude,
    workspaceSearchInclude,
    workspaceSearchOpen,
    workspaceSearchQuery,
  ]);

  const workspaceSearchActions = useMemo<WorkspaceSearchAction[]>(() => {
    const actions: WorkspaceSearchAction[] = [
      {
        id: "find",
        label: "Find in file",
        detail: "Search within the current file",
        onSelect: openFind,
      },
      {
        id: "replace",
        label: "Replace in file",
        detail: "Find and replace within the current file",
        onSelect: openReplace,
      },
    ];
    if (launchScript) {
      actions.push({
        id: "launch",
        label: "Run workspace launch script",
        detail: "Run the default workspace command",
        onSelect: onRunLaunchScript,
      });
    }
    for (const entry of launchScripts) {
      const label = entry.label?.trim() || "Launch script";
      actions.push({
        id: `launch-${entry.id}`,
        label: `Run ${label}`,
        detail: label,
        onSelect: () => onRunLaunchScriptEntry(entry.id),
      });
    }
    return actions;
  }, [
    launchScript,
    launchScripts,
    onRunLaunchScript,
    onRunLaunchScriptEntry,
    openFind,
    openReplace,
  ]);

  const workspaceSearchFileResults = useMemo(() => {
    const normalized = workspaceSearchQuery.trim().toLowerCase();
    if (!normalized) {
      return [];
    }
    return availablePaths
      .filter((path) => path.toLowerCase().includes(normalized))
      .slice(0, 120);
  }, [availablePaths, workspaceSearchQuery]);

  const workspaceClassResults = useMemo(
    () => workspaceSymbolResults.filter((entry) => entry.kind === "class"),
    [workspaceSymbolResults],
  );

  const workspaceSymbolsResults = useMemo(
    () => workspaceSymbolResults.filter((entry) => entry.kind === "symbol"),
    [workspaceSymbolResults],
  );

  const resolveLanguageId = useCallback(
    (path: string, language: string | null) => {
      const raw = language && language !== "plaintext" ? language : languageFromPath(path);
      if (!raw) {
        return null;
      }
      const normalized =
        raw === "tsx"
          ? "typescript"
          : raw === "jsx"
            ? "javascript"
            : raw === "bash"
              ? "shell"
              : raw;
      const supported = new Set([
        "typescript",
        "javascript",
        "json",
        "css",
        "scss",
        "less",
        "html",
        "markdown",
        "rust",
        "python",
        "go",
        "terraform",
        "sql",
        "yaml",
        "toml",
        "xml",
        "lua",
        "graphql",
        "prisma",
        "ruby",
        "c",
        "cpp",
        "dockerfile",
        "shell",
        "swift",
        "php",
      ]);
      return supported.has(normalized) ? normalized : null;
    },
    [],
  );

  const toFileUri = useCallback((rootPath: string, relative: string) => {
    const normalizedRoot = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedRel = relative.replace(/\\/g, "/").replace(/^\/+/, "");
    const full = `${normalizedRoot}/${normalizedRel}`;
    const prefix = full.startsWith("/") ? "file://" : "file:///";
    return encodeURI(`${prefix}${full}`);
  }, []);

  useEffect(() => {
    if (!workspaceSearchOpen) {
      return;
    }
    if (workspaceSearchTab !== "classes" && workspaceSearchTab !== "symbols") {
      return;
    }
    if (!workspaceId || !workspacePath || !activeBufferPath || !activeBuffer) {
      setWorkspaceSymbolResults([]);
      setWorkspaceSymbolError(null);
      return;
    }
    const languageId = resolveLanguageId(activeBufferPath, activeBuffer.language);
    if (!languageId) {
      setWorkspaceSymbolResults([]);
      setWorkspaceSymbolError("Symbols not available for this file type.");
      return;
    }
    const uri = toFileUri(workspacePath, activeBufferPath);
    const query = workspaceSearchQuery.trim().toLowerCase();
    setWorkspaceSymbolLoading(true);
    lspRequest(workspaceId, languageId, "textDocument/documentSymbol", {
      textDocument: { uri },
    })
      .then((response) => {
        const results: WorkspaceSymbolResult[] = [];
        const addSymbol = (name: string, kind: number, line: number, column: number) => {
          const normalizedName = name.trim();
          if (!normalizedName) {
            return;
          }
          if (query && !normalizedName.toLowerCase().includes(query)) {
            return;
          }
          const isClass = kind === 5;
          results.push({
            name: normalizedName,
            kind: isClass ? "class" : "symbol",
            line,
            column,
          });
        };

        const walkDocumentSymbols = (items: any[]) => {
          for (const item of items) {
            const name = item?.name ?? "";
            const kind = item?.kind ?? 0;
            const range = item?.range ?? item?.location?.range ?? null;
            const line = (range?.start?.line ?? 0) + 1;
            const column = (range?.start?.character ?? 0) + 1;
            addSymbol(name, kind, line, column);
            if (Array.isArray(item?.children)) {
              walkDocumentSymbols(item.children);
            }
          }
        };

        if (Array.isArray(response)) {
          walkDocumentSymbols(response);
        }
        setWorkspaceSymbolResults(results);
        setWorkspaceSymbolError(null);
      })
      .catch((error) => {
        setWorkspaceSymbolResults([]);
        setWorkspaceSymbolError(
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        setWorkspaceSymbolLoading(false);
      });
  }, [
    activeBuffer,
    activeBufferPath,
    resolveLanguageId,
    toFileUri,
    workspaceId,
    workspacePath,
    workspaceSearchOpen,
    workspaceSearchQuery,
    workspaceSearchTab,
  ]);

  useEffect(() => {
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }
      if (commandPaletteOpen) {
        return;
      }
      if (editorKeymap === "jetbrains" && event.key === "Shift") {
        const now = Date.now();
        if (now - shiftTapRef.current < 350) {
          shiftTapRef.current = 0;
          event.preventDefault();
          openWorkspaceSearchWithTab("files");
          return;
        }
        shiftTapRef.current = now;
        return;
      }
      if (
        event.key.toLowerCase() === "f" &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        event.preventDefault();
        openWorkspaceSearchWithTab("text");
        return;
      }
      if (
        event.key.toLowerCase() === "p" &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey)
      ) {
        if (editorKeymap === "vscode" || editorKeymap === "default") {
          event.preventDefault();
          openCommandPalette();
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown, true);
    };
  }, [commandPaletteOpen, editorKeymap, openCommandPalette, openWorkspaceSearchWithTab]);

  if (!workspaceId) {
    return <EditorPlaceholder hasWorkspace={false} />;
  }

  const isLargeFile = Boolean(
    activeBuffer &&
      (activeBuffer.isTruncated || activeBuffer.content.length > 1_000_000),
  );
  const editorOptions = {
    minimap: { enabled: false },
    fontFamily: "var(--code-font-family)",
    fontSize: 13,
    lineHeight: 20,
    scrollBeyondLastLine: false,
    wordWrap: isLargeFile ? "off" : "on",
    readOnly: activeBuffer?.isTruncated ?? false,
    renderWhitespace: isLargeFile ? "none" : "selection",
    renderLineHighlight: "none",
    "semanticHighlighting.enabled": false,
    smoothScrolling: !isLargeFile,
    cursorSmoothCaretAnimation: isLargeFile ? "off" : "on",
    quickSuggestions: isLargeFile ? false : { other: true, comments: false, strings: false },
    quickSuggestionsDelay: isLargeFile ? 300 : 100,
    suggestOnTriggerCharacters: !isLargeFile,
    parameterHints: { enabled: !isLargeFile },
  } as const;

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
        {isMarkdown ? (
          <div className="editor-tabs-actions" role="group" aria-label="Markdown view">
            <button
              type="button"
              className={`icon-button editor-view-toggle${
                markdownView === "code" ? " is-active" : ""
              }`}
              onClick={() => setMarkdownView("code")}
              aria-pressed={markdownView === "code"}
              aria-label="Code view"
              title="Code view"
            >
              <Code size={14} aria-hidden />
            </button>
            <button
              type="button"
              className={`icon-button editor-view-toggle${
                markdownView === "split" ? " is-active" : ""
              }`}
              onClick={() => setMarkdownView("split")}
              aria-pressed={markdownView === "split"}
              aria-label="Split view"
              title="Split view"
            >
              <Columns2 size={14} aria-hidden />
            </button>
            <button
              type="button"
              className={`icon-button editor-view-toggle${
                markdownView === "preview" ? " is-active" : ""
              }`}
              onClick={() => setMarkdownView("preview")}
              aria-pressed={markdownView === "preview"}
              aria-label="Preview"
              title="Preview"
            >
              <Eye size={14} aria-hidden />
            </button>
          </div>
        ) : null}
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
              {isMarkdown ? (
                <div className={`editor-split editor-split--${markdownView}`}>
                  {markdownView !== "preview" ? (
                    <div className="editor-pane editor-pane--code">
                      <Editor
                        path={activeBuffer.path}
                        language={activeBuffer.language ?? undefined}
                        value={activeBuffer.content}
                        theme="friday-app"
                        height="100%"
                        width="100%"
                        onChange={(value) => {
                          onContentChange(activeBuffer.path, value ?? "");
                        }}
                        beforeMount={handleBeforeMount}
                        onMount={handleMount}
                        options={editorOptions}
                      />
                    </div>
                  ) : null}
                  {markdownView !== "code" ? (
                    <div className="editor-pane editor-pane--preview">
                      <div className="editor-markdown-preview">
                        <Markdown className="markdown" value={activeBuffer.content} />
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <Editor
                  path={activeBuffer.path}
                  language={activeBuffer.language ?? undefined}
                  value={activeBuffer.content}
                  theme="friday-app"
                  height="100%"
                  width="100%"
                  onChange={(value) => {
                    onContentChange(activeBuffer.path, value ?? "");
                  }}
                  beforeMount={handleBeforeMount}
                  onMount={handleMount}
                  options={editorOptions}
                />
              )}
            </>
          )}
        </div>
      ) : (
        <EditorPlaceholder hasWorkspace />
      )}
      <EditorCommandPalette
        isOpen={commandPaletteOpen}
        onClose={closeCommandPalette}
        editorKeymap={editorKeymap}
        onOpenWorkspaceSearch={openWorkspaceSearch}
        availablePaths={availablePaths}
        openPaths={openPaths}
        onOpenPath={onOpenPath}
        onOpenFind={openFind}
        onOpenReplace={openReplace}
        launchScript={launchScript}
        launchScripts={launchScripts}
        onRunLaunchScript={onRunLaunchScript}
        onRunLaunchScriptEntry={onRunLaunchScriptEntry}
      />
      <EditorWorkspaceSearch
        isOpen={workspaceSearchOpen}
        activeTab={workspaceSearchTab}
        onTabChange={setWorkspaceSearchTab}
        query={workspaceSearchQuery}
        results={workspaceSearchResults}
        fileResults={workspaceSearchFileResults}
        classResults={workspaceClassResults}
        symbolResults={workspaceSymbolsResults}
        symbolError={workspaceSymbolError}
        symbolLoading={workspaceSymbolLoading}
        actions={workspaceSearchActions}
        isLoading={workspaceSearchLoading}
        error={workspaceSearchError}
        onClose={closeWorkspaceSearch}
        onQueryChange={setWorkspaceSearchQuery}
        onSelectResult={(result) => {
          pendingRevealRef.current = {
            path: result.path,
            line: result.line,
            column: result.column,
          };
          onOpenPath(result.path);
          closeWorkspaceSearch();
        }}
        onSelectFile={(path) => {
          onOpenPath(path);
          closeWorkspaceSearch();
        }}
        onSelectAction={(action) => {
          action.onSelect();
          closeWorkspaceSearch();
        }}
        onSelectSymbol={(symbol) => {
          if (!activeBufferPath) {
            return;
          }
          pendingRevealRef.current = {
            path: activeBufferPath,
            line: symbol.line,
            column: symbol.column,
          };
          onOpenPath(activeBufferPath);
          closeWorkspaceSearch();
        }}
      />
    </div>
  );
}
