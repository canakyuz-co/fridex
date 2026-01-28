import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";

import { languageFromPath } from "../../../utils/syntax";
import { lspNotify, lspRequest, lspStart, lspStop } from "../../../services/tauri";
import { pushErrorToast } from "../../../services/toasts";
import { subscribeLspNotifications } from "../../../services/events";
import { useTauriEvent } from "../../app/hooks/useTauriEvent";

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

type UseEditorLspOptions = {
  workspaceId: string | null;
  workspacePath: string | null;
  openPaths: string[];
  buffersByPath: Record<string, EditorBuffer>;
};

type UseEditorLspResult = {
  onMonacoReady: (
    monaco: Monaco,
    editor: MonacoEditor.IStandaloneCodeEditor,
  ) => void;
  onDidSave: (path: string) => void;
};

type LspDiagnostic = {
  range?: {
    start?: { line?: number; character?: number };
    end?: { line?: number; character?: number };
  };
  message?: string;
  severity?: number;
  source?: string;
  code?: string | number;
};

type LspPublishDiagnostics = {
  uri?: string;
  diagnostics?: LspDiagnostic[];
};

type LspDocumentState = {
  languageId: string;
  version: number;
};

type LspNotificationPayload = {
  workspaceId: string;
  languageId: string;
  method: string;
  params: unknown;
};

const SUPPORTED_LANGUAGES = new Set([
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
  "yaml",
  "toml",
  "shell",
]);

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function joinPath(left: string, right: string): string {
  const trimmedLeft = left.replace(/\/+$/, "");
  const trimmedRight = right.replace(/^\/+/, "");
  return `${trimmedLeft}/${trimmedRight}`;
}

function toFileUri(path: string): string {
  const normalized = normalizePath(path);
  const prefix = normalized.startsWith("/") ? "file://" : "file:///";
  return encodeURI(`${prefix}${normalized}`);
}

function toWorkspaceName(path: string): string {
  const normalized = normalizePath(path).replace(/\/+$/, "");
  return normalized.split("/").pop() ?? "workspace";
}

function resolveLanguageId(path: string, buffer?: EditorBuffer | null): string | null {
  const raw = buffer?.language ?? languageFromPath(path);
  if (!raw) {
    return null;
  }
  const normalized = raw === "bash" ? "shell" : raw;
  const mapped =
    normalized === "tsx" ? "typescript" : normalized === "jsx" ? "javascript" : normalized;
  if (mapped === "text" || mapped === "plaintext") {
    return null;
  }
  return SUPPORTED_LANGUAGES.has(mapped) ? mapped : null;
}

function buildInitializeParams(rootUri: string, rootPath: string) {
  return {
    processId: null,
    rootUri,
    workspaceFolders: [{ uri: rootUri, name: toWorkspaceName(rootPath) }],
    capabilities: {
      textDocument: {
        synchronization: { didSave: true, dynamicRegistration: false },
      },
      workspace: { workspaceFolders: true },
    },
  };
}

function parseUriPath(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    return decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
}

function toRelativePath(rootPath: string, uri: string): string | null {
  const filePath = parseUriPath(uri);
  if (!filePath) {
    return null;
  }
  const normalizedRoot = normalizePath(rootPath);
  const normalizedFile = normalizePath(filePath);
  if (normalizedFile.startsWith(normalizedRoot)) {
    return normalizedFile.slice(normalizedRoot.length).replace(/^\/+/, "");
  }
  return normalizedFile.replace(/^\/+/, "");
}

function toMarkerSeverity(monaco: Monaco, severity?: number) {
  if (severity === 1) {
    return monaco.MarkerSeverity.Error;
  }
  if (severity === 2) {
    return monaco.MarkerSeverity.Warning;
  }
  if (severity === 3) {
    return monaco.MarkerSeverity.Info;
  }
  return monaco.MarkerSeverity.Hint;
}

function toMarkers(monaco: Monaco, diagnostics: LspDiagnostic[]) {
  return diagnostics.map((diagnostic) => {
    const startLine = (diagnostic.range?.start?.line ?? 0) + 1;
    const startColumn = (diagnostic.range?.start?.character ?? 0) + 1;
    const endLine = (diagnostic.range?.end?.line ?? startLine - 1) + 1;
    const endColumn = (diagnostic.range?.end?.character ?? startColumn - 1) + 1;
    return {
      severity: toMarkerSeverity(monaco, diagnostic.severity),
      message: diagnostic.message ?? "",
      source: diagnostic.source,
      code: diagnostic.code as string | number | undefined,
      startLineNumber: Math.max(startLine, 1),
      startColumn: Math.max(startColumn, 1),
      endLineNumber: Math.max(endLine, 1),
      endColumn: Math.max(endColumn, 1),
    };
  });
}

function findModelForPath(monaco: Monaco, path: string) {
  const normalized = normalizePath(path);
  return monaco.editor.getModels().find((model: MonacoEditor.ITextModel) => {
    const candidates = [model.uri.path, model.uri.fsPath, model.uri.toString()];
    return candidates.some((value) => normalizePath(value).endsWith(normalized));
  });
}

export function useEditorLsp({
  workspaceId,
  workspacePath,
  openPaths,
  buffersByPath,
}: UseEditorLspOptions): UseEditorLspResult {
  const monacoRef = useRef<Monaco | null>(null);
  const startedLanguagesRef = useRef(new Set<string>());
  const disabledLanguagesRef = useRef(new Set<string>());
  const startPromisesRef = useRef(new Map<string, Promise<boolean>>());
  const openDocsRef = useRef(new Map<string, LspDocumentState>());
  const lastContentRef = useRef(new Map<string, string>());

  const workspaceRootUri = useMemo(() => {
    return workspacePath ? toFileUri(workspacePath) : null;
  }, [workspacePath]);

  const onMonacoReady = useCallback(
    (monaco: Monaco, _editor: MonacoEditor.IStandaloneCodeEditor) => {
      monacoRef.current = monaco;
    },
    [],
  );

  const showLspError = useCallback((languageId: string, error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    pushErrorToast({
      title: "LSP baslatilamadi",
      message: `${languageId} icin sunucu baslatilamadi: ${message}`,
    });
  }, []);

  const startServerProcess = useCallback(
    async (languageId: string) => {
      if (!workspaceId) {
        return false;
      }
      try {
        await lspStart(workspaceId, languageId);
        return true;
      } catch (error) {
        disabledLanguagesRef.current.add(languageId);
        showLspError(languageId, error);
        return false;
      }
    },
    [workspaceId, showLspError],
  );

  const initializeServer = useCallback(
    async (languageId: string) => {
      if (!workspaceId || !workspacePath || !workspaceRootUri) {
        return false;
      }
      try {
        await lspRequest(
          workspaceId,
          languageId,
          "initialize",
          buildInitializeParams(workspaceRootUri, workspacePath),
        );
        await lspNotify(workspaceId, languageId, "initialized", {});
        startedLanguagesRef.current.add(languageId);
        return true;
      } catch (error) {
        showLspError(languageId, error);
        return false;
      }
    },
    [workspaceId, workspacePath, workspaceRootUri, showLspError],
  );

  const createStartPromise = useCallback(
    async (languageId: string) => {
      const started = await startServerProcess(languageId);
      return started ? initializeServer(languageId) : false;
    },
    [initializeServer, startServerProcess],
  );

  const startLanguageServer = useCallback(
    (languageId: string) => {
      if (!workspaceId || !workspacePath || !workspaceRootUri) {
        return Promise.resolve(false);
      }
      if (disabledLanguagesRef.current.has(languageId)) {
        return Promise.resolve(false);
      }
      const existing = startPromisesRef.current.get(languageId);
      if (existing) {
        return existing;
      }
      const promise = createStartPromise(languageId).then((result) => {
        startPromisesRef.current.delete(languageId);
        return result;
      });
      startPromisesRef.current.set(languageId, promise);
      return promise;
    },
    [workspaceId, workspacePath, workspaceRootUri, createStartPromise],
  );

  const openDocument = useCallback(
    async (path: string, languageId: string, content: string) => {
      if (!workspaceId || !workspacePath) {
        return;
      }
      const ready = await startLanguageServer(languageId);
      if (!ready) {
        return;
      }
      const uri = toFileUri(joinPath(workspacePath, path));
      openDocsRef.current.set(path, { languageId, version: 1 });
      lastContentRef.current.set(path, content);
      await lspNotify(workspaceId, languageId, "textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text: content },
      });
    },
    [workspaceId, workspacePath, startLanguageServer],
  );

  const closeDocument = useCallback(
    async (path: string, languageId: string) => {
      if (!workspaceId || !workspacePath) {
        return;
      }
      const uri = toFileUri(joinPath(workspacePath, path));
      await lspNotify(workspaceId, languageId, "textDocument/didClose", {
        textDocument: { uri },
      });
    },
    [workspaceId, workspacePath],
  );

  const onDidSave = useCallback(
    (path: string) => {
      const docState = openDocsRef.current.get(path);
      if (!docState || !workspaceId || !workspacePath) {
        return;
      }
      const uri = toFileUri(joinPath(workspacePath, path));
      void lspNotify(workspaceId, docState.languageId, "textDocument/didSave", {
        textDocument: { uri },
      });
    },
    [workspaceId, workspacePath],
  );

  const applyDiagnostics = useCallback(
    (path: string, diagnostics: LspDiagnostic[]) => {
      const monaco = monacoRef.current;
      if (!monaco) {
        return;
      }
      const model = findModelForPath(monaco, path);
      if (!model) {
        return;
      }
      monaco.editor.setModelMarkers(model, "lsp", toMarkers(monaco, diagnostics));
    },
    [],
  );

  const clearDiagnostics = useCallback((path: string) => {
    const monaco = monacoRef.current;
    if (!monaco) {
      return;
    }
    const model = findModelForPath(monaco, path);
    if (model) {
      monaco.editor.setModelMarkers(model, "lsp", []);
    }
  }, []);

  const resolveDiagnostics = useCallback(
    (payload: LspNotificationPayload) => {
      if (payload.workspaceId !== workspaceId || !workspacePath) {
        return null;
      }
      if (payload.method !== "textDocument/publishDiagnostics") {
        return null;
      }
      const params = payload.params as LspPublishDiagnostics;
      if (!params?.uri || !params?.diagnostics) {
        return null;
      }
      const relativePath = toRelativePath(workspacePath, params.uri);
      if (!relativePath) {
        return null;
      }
      return { path: relativePath, diagnostics: params.diagnostics };
    },
    [workspaceId, workspacePath],
  );

  const handleLspNotification = useCallback(
    (payload: LspNotificationPayload) => {
      const resolved = resolveDiagnostics(payload);
      if (!resolved) {
        return;
      }
      applyDiagnostics(resolved.path, resolved.diagnostics);
    },
    [applyDiagnostics, resolveDiagnostics],
  );

  const stopAllServers = useCallback((workspace: string, languages: string[]) => {
    for (const languageId of languages) {
      void lspStop(workspace, languageId);
    }
  }, []);

  const resetWorkspaceState = useCallback(
    (workspace: string) => {
      const languages = Array.from(startedLanguagesRef.current);
      startedLanguagesRef.current.clear();
      disabledLanguagesRef.current.clear();
      startPromisesRef.current.clear();
      openDocsRef.current.clear();
      lastContentRef.current.clear();
      stopAllServers(workspace, languages);
    },
    [stopAllServers],
  );

  const closeRemovedDocuments = useCallback(
    (openSet: Set<string>) => {
      for (const [path, state] of openDocsRef.current.entries()) {
        if (!openSet.has(path)) {
          void closeDocument(path, state.languageId);
          openDocsRef.current.delete(path);
          lastContentRef.current.delete(path);
          clearDiagnostics(path);
        }
      }
    },
    [closeDocument, clearDiagnostics],
  );

  const openMissingDocuments = useCallback(() => {
    for (const path of openPaths) {
      const buffer = buffersByPath[path];
      if (!buffer || buffer.isLoading || buffer.isTruncated) {
        continue;
      }
      if (openDocsRef.current.has(path)) {
        continue;
      }
      const languageId = resolveLanguageId(path, buffer);
      if (!languageId) {
        continue;
      }
      void openDocument(path, languageId, buffer.content);
    }
  }, [buffersByPath, openDocument, openPaths]);

  const syncOpenDocuments = useCallback(() => {
    // O(n) sync: Set + Map ile O(1) uyelik; gereksiz ikinci tur yok.
    if (!workspaceId || !workspacePath) {
      return;
    }
    const openSet = new Set(openPaths);
    closeRemovedDocuments(openSet);
    openMissingDocuments();
  }, [workspaceId, workspacePath, openPaths, closeRemovedDocuments, openMissingDocuments]);

  const sendDidChange = useCallback(
    (path: string, state: LspDocumentState, content: string) => {
      if (!workspaceId || !workspacePath) {
        return;
      }
      const nextVersion = state.version + 1;
      state.version = nextVersion;
      lastContentRef.current.set(path, content);
      const uri = toFileUri(joinPath(workspacePath, path));
      void lspNotify(workspaceId, state.languageId, "textDocument/didChange", {
        textDocument: { uri, version: nextVersion },
        contentChanges: [{ text: content }],
      });
    },
    [workspaceId, workspacePath],
  );

  const syncDocumentChanges = useCallback(() => {
    // O(n) tarama: sadece degisen buffer'lar icin full-text update gonderir.
    if (!workspaceId || !workspacePath) {
      return;
    }
    for (const [path, state] of openDocsRef.current.entries()) {
      const buffer = buffersByPath[path];
      if (!buffer || buffer.isLoading || buffer.isTruncated) {
        continue;
      }
      const previous = lastContentRef.current.get(path);
      if (previous === buffer.content) {
        continue;
      }
      sendDidChange(path, state, buffer.content);
    }
  }, [workspaceId, workspacePath, buffersByPath, sendDidChange]);

  useTauriEvent(subscribeLspNotifications, handleLspNotification, {
    enabled: Boolean(workspaceId),
  });

  useEffect(() => {
    if (!workspaceId) {
      return;
    }
    return () => {
      resetWorkspaceState(workspaceId);
    };
  }, [workspaceId, resetWorkspaceState]);

  useEffect(() => {
    syncOpenDocuments();
  }, [syncOpenDocuments]);

  useEffect(() => {
    syncDocumentChanges();
  }, [syncDocumentChanges]);

  return { onMonacoReady, onDidSave };
}
