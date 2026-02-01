import { useCallback, useEffect, useRef, useState } from "react";
import { readWorkspaceFile, writeWorkspaceFile } from "../../../services/tauri";
import { monacoLanguageFromPath } from "../../../utils/languageRegistry";

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

type UseEditorStateOptions = {
  workspaceId: string | null;
  availablePaths?: string[];
  filesReady?: boolean;
  onDidSave?: (path: string) => void;
};

type UseEditorStateResult = {
  openPaths: string[];
  activePath: string | null;
  buffersByPath: Record<string, EditorBuffer>;
  openFile: (path: string) => void;
  closeFile: (path: string) => void;
  setActivePath: (path: string) => void;
  updateContent: (path: string, value: string) => void;
  saveFile: (path: string) => void;
};


export function useEditorState({
  workspaceId,
  availablePaths = [],
  filesReady = true,
  onDidSave,
}: UseEditorStateOptions): UseEditorStateResult {
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [buffersByPath, setBuffersByPath] = useState<Record<string, EditorBuffer>>({});
  const hasRestoredRef = useRef(false);

  const getLastFileKey = useCallback(
    (id: string) => `codexmonitor.editorLastFile.${id}`,
    [],
  );

  const findReadmePath = useCallback((paths: string[]) => {
    if (!paths.length) {
      return null;
    }
    let best: { path: string; extensionWeight: number; depth: number; length: number } | null =
      null;
    for (const path of paths) {
      const name = path.split("/").pop() ?? path;
      const lower = name.toLowerCase();
      if (!lower.startsWith("readme")) {
        continue;
      }
      const isExactMd = lower === "readme.md";
      const isExactMdx = lower === "readme.mdx";
      const isExact = lower === "readme";
      const candidate = {
        path,
        extensionWeight: isExactMd ? 0 : isExactMdx ? 1 : isExact ? 2 : 3,
        depth: path.split("/").length,
        length: path.length,
      };
      if (
        !best ||
        candidate.extensionWeight < best.extensionWeight ||
        (candidate.extensionWeight === best.extensionWeight &&
          (candidate.depth < best.depth ||
            (candidate.depth === best.depth && candidate.length < best.length)))
      ) {
        best = candidate;
      }
    }
    return best?.path ?? null;
  }, []);

  const openFile = useCallback(
    (path: string) => {
      if (!workspaceId) {
        return;
      }
      setActivePath(path);
      setOpenPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
      setBuffersByPath((prev) => {
        if (prev[path]) {
          return prev;
        }
        return {
          ...prev,
          [path]: {
            path,
            content: "",
            language: monacoLanguageFromPath(path),
            isDirty: false,
            isSaving: false,
            isLoading: true,
            error: null,
            isTruncated: false,
          },
        };
      });
      void (async () => {
        try {
          const response = await readWorkspaceFile(workspaceId, path);
          setBuffersByPath((prev) => {
            const current = prev[path];
          if (!current) {
            return prev;
          }
          return {
            ...prev,
            [path]: {
              ...current,
              content: response.content,
              isLoading: false,
              error: null,
              isTruncated: response.truncated,
            },
          };
        });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setBuffersByPath((prev) => {
            const current = prev[path];
            if (!current) {
              return prev;
            }
            return {
              ...prev,
              [path]: {
                ...current,
                isLoading: false,
                error: message,
              },
            };
          });
        }
      })();
    },
    [workspaceId],
  );

  useEffect(() => {
    setOpenPaths([]);
    setActivePath(null);
    setBuffersByPath({});
    hasRestoredRef.current = false;
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || !filesReady) {
      return;
    }
    if (hasRestoredRef.current) {
      return;
    }
    if (openPaths.length > 0 || activePath) {
      hasRestoredRef.current = true;
      return;
    }
    const storedPath =
      typeof window === "undefined"
        ? null
        : window.localStorage.getItem(getLastFileKey(workspaceId));
    const storedIsValid = storedPath ? availablePaths.includes(storedPath) : false;
    const readmePath = storedIsValid ? null : findReadmePath(availablePaths);
    const nextPath = storedIsValid ? storedPath : readmePath;
    hasRestoredRef.current = true;
    if (nextPath) {
      openFile(nextPath);
    }
  }, [
    activePath,
    availablePaths,
    filesReady,
    findReadmePath,
    getLastFileKey,
    openFile,
    openPaths.length,
    workspaceId,
  ]);

  useEffect(() => {
    if (!workspaceId || !activePath || typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(getLastFileKey(workspaceId), activePath);
  }, [activePath, getLastFileKey, workspaceId]);

  const closeFile = useCallback((path: string) => {
    setOpenPaths((prev) => {
      const next = prev.filter((entry) => entry !== path);
      setActivePath((current) => {
        if (current !== path) {
          return current;
        }
        return next[next.length - 1] ?? null;
      });
      return next;
    });
    setBuffersByPath((prev) => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, []);

  const updateContent = useCallback((path: string, value: string) => {
    setBuffersByPath((prev) => {
      const current = prev[path];
      if (!current || current.isLoading) {
        return prev;
      }
      return {
        ...prev,
        [path]: {
          ...current,
          content: value,
          isDirty: true,
        },
      };
    });
  }, []);

  const saveFile = useCallback(
    (path: string) => {
      if (!workspaceId) {
        return;
      }
      const buffer = buffersByPath[path];
      if (!buffer || buffer.isLoading || buffer.isSaving || buffer.isTruncated) {
        return;
      }
      setBuffersByPath((prev) => {
        const current = prev[path];
        if (!current) {
          return prev;
        }
        return {
          ...prev,
          [path]: {
            ...current,
            isSaving: true,
            error: null,
          },
        };
      });
      void (async () => {
        try {
          await writeWorkspaceFile(workspaceId, path, buffer.content);
          onDidSave?.(path);
          setBuffersByPath((prev) => {
            const current = prev[path];
            if (!current) {
              return prev;
            }
            return {
              ...prev,
              [path]: {
                ...current,
                isDirty: false,
                isSaving: false,
                error: null,
              },
            };
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setBuffersByPath((prev) => {
            const current = prev[path];
            if (!current) {
              return prev;
            }
            return {
              ...prev,
              [path]: {
                ...current,
                isSaving: false,
                error: message,
              },
            };
          });
        }
      })();
    },
    [workspaceId, buffersByPath, onDidSave],
  );

  return {
    openPaths,
    activePath,
    buffersByPath,
    openFile,
    closeFile,
    setActivePath,
    updateContent,
    saveFile,
  };
}
