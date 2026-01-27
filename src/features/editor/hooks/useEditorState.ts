import { useCallback, useEffect, useState } from "react";
import { readWorkspaceFile } from "../../../services/tauri";
import { languageFromPath } from "../../../utils/syntax";

type EditorBuffer = {
  path: string;
  content: string;
  language: string | null;
  isDirty: boolean;
  isLoading: boolean;
  error: string | null;
  isTruncated: boolean;
};

type UseEditorStateOptions = {
  workspaceId: string | null;
};

type UseEditorStateResult = {
  openPaths: string[];
  activePath: string | null;
  buffersByPath: Record<string, EditorBuffer>;
  openFile: (path: string) => void;
  closeFile: (path: string) => void;
  setActivePath: (path: string) => void;
  updateContent: (path: string, value: string) => void;
};

function toMonacoLanguage(path: string): string | null {
  const language = languageFromPath(path);
  if (language === "markup") {
    return "html";
  }
  if (language === "bash") {
    return "shell";
  }
  if (language === "text") {
    return "plaintext";
  }
  return language;
}

export function useEditorState({
  workspaceId,
}: UseEditorStateOptions): UseEditorStateResult {
  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [buffersByPath, setBuffersByPath] = useState<Record<string, EditorBuffer>>({});

  useEffect(() => {
    setOpenPaths([]);
    setActivePath(null);
    setBuffersByPath({});
  }, [workspaceId]);

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
            language: toMonacoLanguage(path),
            isDirty: false,
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

  return {
    openPaths,
    activePath,
    buffersByPath,
    openFile,
    closeFile,
    setActivePath,
    updateContent,
  };
}
