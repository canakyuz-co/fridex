import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import Plus from "lucide-react/dist/esm/icons/plus";
import ChevronsUpDown from "lucide-react/dist/esm/icons/chevrons-up-down";
import Search from "lucide-react/dist/esm/icons/search";
import FilePlus from "lucide-react/dist/esm/icons/file-plus";
import FolderPlus from "lucide-react/dist/esm/icons/folder-plus";
import RefreshCcw from "lucide-react/dist/esm/icons/refresh-ccw";
import FileText from "lucide-react/dist/esm/icons/file-text";
import Folder from "lucide-react/dist/esm/icons/folder";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open";
import { PanelTabs, type PanelTabId } from "../../layout/components/PanelTabs";
import {
  createWorkspaceDir,
  createWorkspaceFile,
  deleteWorkspacePath,
  moveWorkspacePath,
  readWorkspaceFile,
} from "../../../services/tauri";
import type { OpenAppTarget } from "../../../types";
import { languageFromPath } from "../../../utils/syntax";
import { FilePreviewPopover } from "./FilePreviewPopover";

type FileTreeNode = {
  name: string;
  path: string;
  type: "file" | "folder";
  children: FileTreeNode[];
};

type FileTreePanelProps = {
  workspaceId: string;
  workspacePath: string;
  files: string[];
  isLoading: boolean;
  filePanelMode: PanelTabId;
  onFilePanelModeChange: (mode: PanelTabId) => void;
  onInsertText?: (text: string) => void;
  showTabs?: boolean;
  showMentionActions?: boolean;
  onOpenFile?: (path: string) => void;
  onRefreshFiles?: () => void;
  openTargets: OpenAppTarget[];
  openAppIconById: Record<string, string>;
  selectedOpenAppId: string;
  onSelectOpenAppId: (id: string) => void;
};

type FileTreeBuildNode = {
  name: string;
  path: string;
  type: "file" | "folder";
  children: Map<string, FileTreeBuildNode>;
};

function buildTree(paths: string[]): { nodes: FileTreeNode[]; folderPaths: Set<string> } {
  const root = new Map<string, FileTreeBuildNode>();
  const addNode = (
    map: Map<string, FileTreeBuildNode>,
    name: string,
    path: string,
    type: "file" | "folder",
  ) => {
    const existing = map.get(name);
    if (existing) {
      if (type === "folder") {
        existing.type = "folder";
      }
      return existing;
    }
    const node: FileTreeBuildNode = {
      name,
      path,
      type,
      children: new Map(),
    };
    map.set(name, node);
    return node;
  };

  paths.forEach((path) => {
    const parts = path.split("/").filter(Boolean);
    let currentMap = root;
    let currentPath = "";
    parts.forEach((segment, index) => {
      const isFile = index === parts.length - 1;
      const nextPath = currentPath ? `${currentPath}/${segment}` : segment;
      const node = addNode(currentMap, segment, nextPath, isFile ? "file" : "folder");
      if (!isFile) {
        currentMap = node.children;
        currentPath = nextPath;
      }
    });
  });

  const folderPaths = new Set<string>();

  const toArray = (map: Map<string, FileTreeBuildNode>): FileTreeNode[] => {
    const nodes = Array.from(map.values()).map((node) => {
      if (node.type === "folder") {
        folderPaths.add(node.path);
      }
      return {
        name: node.name,
        path: node.path,
        type: node.type,
        children: node.type === "folder" ? toArray(node.children) : [],
      };
    });
    nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "folder" ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    return nodes;
  };

  return { nodes: toArray(root), folderPaths };
}

const imageExtensions = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "bmp",
  "heic",
  "heif",
  "tif",
  "tiff",
]);

function isImagePath(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return imageExtensions.has(ext);
}


export function FileTreePanel({
  workspaceId,
  workspacePath,
  files,
  isLoading,
  filePanelMode,
  onFilePanelModeChange,
  onInsertText,
  showTabs = true,
  showMentionActions = true,
  onOpenFile,
  onRefreshFiles,
  openTargets,
  openAppIconById,
  selectedOpenAppId,
  onSelectOpenAppId,
}: FileTreePanelProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewAnchor, setPreviewAnchor] = useState<{
    top: number;
    left: number;
    arrowTop: number;
    height: number;
  } | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewSelection, setPreviewSelection] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [isDragSelecting, setIsDragSelecting] = useState(false);
  const dragAnchorLineRef = useRef<number | null>(null);
  const dragMovedRef = useRef(false);
  const hasManualToggle = useRef(false);
  const showLoading = isLoading && files.length === 0;
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const previewKind = useMemo(
    () => (previewPath && isImagePath(previewPath) ? "image" : "text"),
    [previewPath],
  );

  const filteredFiles = useMemo(() => {
    if (!normalizedQuery) {
      return files;
    }
    return files.filter((path) => path.toLowerCase().includes(normalizedQuery));
  }, [files, normalizedQuery]);

  const { nodes, folderPaths } = useMemo(
    () => buildTree(normalizedQuery ? filteredFiles : files),
    [files, filteredFiles, normalizedQuery],
  );

  const visibleFolderPaths = folderPaths;
  const hasFolders = visibleFolderPaths.size > 0;
  const allVisibleExpanded =
    hasFolders && Array.from(visibleFolderPaths).every((path) => expandedFolders.has(path));

  useEffect(() => {
    setExpandedFolders((prev) => {
      if (normalizedQuery) {
        return new Set(folderPaths);
      }
      const next = new Set<string>();
      prev.forEach((path) => {
        if (folderPaths.has(path)) {
          next.add(path);
        }
      });
      if (next.size === 0 && !hasManualToggle.current) {
        nodes.forEach((node) => {
          if (node.type === "folder") {
            next.add(node.path);
          }
        });
      }
      return next;
    });
  }, [folderPaths, nodes, normalizedQuery]);

  useEffect(() => {
    setPreviewPath(null);
    setPreviewAnchor(null);
    setPreviewSelection(null);
    setPreviewContent("");
    setPreviewTruncated(false);
    setPreviewError(null);
    setPreviewLoading(false);
    setIsDragSelecting(false);
    dragAnchorLineRef.current = null;
    dragMovedRef.current = false;
  }, [workspaceId]);

  const closePreview = useCallback(() => {
    setPreviewPath(null);
    setPreviewAnchor(null);
    setPreviewSelection(null);
    setPreviewContent("");
    setPreviewTruncated(false);
    setPreviewError(null);
    setPreviewLoading(false);
    setIsDragSelecting(false);
    dragAnchorLineRef.current = null;
    dragMovedRef.current = false;
  }, []);

  useEffect(() => {
    if (!previewPath) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePreview();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [previewPath, closePreview]);

  const toggleAllFolders = () => {
    if (!hasFolders) {
      return;
    }
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (allVisibleExpanded) {
        visibleFolderPaths.forEach((path) => next.delete(path));
      } else {
        visibleFolderPaths.forEach((path) => next.add(path));
      }
      return next;
    });
    hasManualToggle.current = true;
  };

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const resolvePath = useCallback(
    (relativePath: string) => {
      const base = workspacePath.endsWith("/")
        ? workspacePath.slice(0, -1)
        : workspacePath;
      return `${base}/${relativePath}`;
    },
    [workspacePath],
  );

  const normalizeRelativePath = useCallback((value: string | null) => {
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const normalized = trimmed.replace(/^\/+/, "").replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) {
      return null;
    }
    if (normalized.includes("://")) {
      return null;
    }
    return normalized;
  }, []);

  const joinPath = useCallback((base: string, name: string) => {
    if (!base) {
      return name;
    }
    return `${base.replace(/\/$/, "")}/${name.replace(/^\//, "")}`;
  }, []);

  const runFileAction = useCallback(
    async (action: () => Promise<void>) => {
      if (actionBusy) {
        return;
      }
      setActionBusy(true);
      try {
        await action();
        onRefreshFiles?.();
      } catch (error) {
        alert(error instanceof Error ? error.message : String(error));
      } finally {
        setActionBusy(false);
      }
    },
    [actionBusy, onRefreshFiles],
  );

  const handleCreateFile = useCallback(
    async (basePath: string) => {
      const name = normalizeRelativePath(
        window.prompt("Yeni dosya adi", "new-file.ts"),
      );
      if (!name) {
        return;
      }
      const targetPath = joinPath(basePath, name);
      await runFileAction(() => createWorkspaceFile(workspaceId, targetPath));
    },
    [joinPath, normalizeRelativePath, runFileAction, workspaceId],
  );

  const handleCreateFolder = useCallback(
    async (basePath: string) => {
      const name = normalizeRelativePath(
        window.prompt("Yeni klasor adi", "new-folder"),
      );
      if (!name) {
        return;
      }
      const targetPath = joinPath(basePath, name);
      await runFileAction(() => createWorkspaceDir(workspaceId, targetPath));
    },
    [joinPath, normalizeRelativePath, runFileAction, workspaceId],
  );

  const handleDeletePath = useCallback(
    async (relativePath: string) => {
      const confirmDelete = window.confirm(
        `Silinsin mi?\n${relativePath}`,
      );
      if (!confirmDelete) {
        return;
      }
      await runFileAction(() => deleteWorkspacePath(workspaceId, relativePath));
    },
    [runFileAction, workspaceId],
  );

  const handleRenamePath = useCallback(
    async (relativePath: string) => {
      const parts = relativePath.split("/");
      const currentName = parts.pop() ?? relativePath;
      const baseDir = parts.join("/");
      const nextName = normalizeRelativePath(
        window.prompt("Yeni ad", currentName),
      );
      if (!nextName || nextName === currentName) {
        return;
      }
      const nextPath = joinPath(baseDir, nextName);
      await runFileAction(() => moveWorkspacePath(workspaceId, relativePath, nextPath));
    },
    [joinPath, normalizeRelativePath, runFileAction, workspaceId],
  );

  const handleMovePath = useCallback(
    async (relativePath: string) => {
      const nextPath = normalizeRelativePath(
        window.prompt("Yeni konum (path)", relativePath),
      );
      if (!nextPath || nextPath === relativePath) {
        return;
      }
      await runFileAction(() => moveWorkspacePath(workspaceId, relativePath, nextPath));
    },
    [normalizeRelativePath, runFileAction, workspaceId],
  );

  const previewImageSrc = useMemo(() => {
    if (!previewPath || previewKind !== "image") {
      return null;
    }
    try {
      return convertFileSrc(resolvePath(previewPath));
    } catch {
      return null;
    }
  }, [previewPath, previewKind, resolvePath]);

  const openPreview = useCallback((path: string, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const estimatedWidth = 640;
    const estimatedHeight = 520;
    const padding = 16;
    const maxHeight = Math.min(estimatedHeight, window.innerHeight - padding * 2);
    const left = Math.min(
      Math.max(padding, rect.left - estimatedWidth - padding),
      Math.max(padding, window.innerWidth - estimatedWidth - padding),
    );
    const top = Math.min(
      Math.max(padding, rect.top - maxHeight * 0.35),
      Math.max(padding, window.innerHeight - maxHeight - padding),
    );
    const arrowTop = Math.min(
      Math.max(16, rect.top + rect.height / 2 - top),
      Math.max(16, maxHeight - 16),
    );
    setPreviewPath(path);
    setPreviewAnchor({ top, left, arrowTop, height: maxHeight });
    setPreviewSelection(null);
    setIsDragSelecting(false);
    dragAnchorLineRef.current = null;
    dragMovedRef.current = false;
  }, []);

  useEffect(() => {
    if (!previewPath) {
      return;
    }
    let cancelled = false;
    if (previewKind === "image") {
      setPreviewContent("");
      setPreviewTruncated(false);
      setPreviewError(null);
      setPreviewLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setPreviewLoading(true);
    setPreviewError(null);
    readWorkspaceFile(workspaceId, previewPath)
      .then((response) => {
        if (cancelled) {
          return;
        }
        setPreviewContent(response.content ?? "");
        setPreviewTruncated(Boolean(response.truncated));
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setPreviewError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) {
          setPreviewLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [previewKind, previewPath, workspaceId]);

  useEffect(() => {
    if (!isDragSelecting) {
      return;
    }
    const handleMouseUp = () => {
      setIsDragSelecting(false);
      dragAnchorLineRef.current = null;
    };
    window.addEventListener("mouseup", handleMouseUp);
    return () => window.removeEventListener("mouseup", handleMouseUp);
  }, [isDragSelecting]);

  const selectRangeFromAnchor = useCallback((anchor: number, index: number) => {
    const start = Math.min(anchor, index);
    const end = Math.max(anchor, index);
    setPreviewSelection({ start, end });
  }, []);

  const handleSelectLine = useCallback(
    (index: number, event: MouseEvent<HTMLButtonElement>) => {
      if (dragMovedRef.current) {
        dragMovedRef.current = false;
        return;
      }
      if (event.shiftKey && previewSelection) {
        const anchor = previewSelection.start;
        selectRangeFromAnchor(anchor, index);
        return;
      }
      setPreviewSelection({ start: index, end: index });
    },
    [previewSelection, selectRangeFromAnchor],
  );

  const handleLineMouseDown = useCallback(
    (index: number, event: MouseEvent<HTMLButtonElement>) => {
      if (previewKind !== "text" || event.button !== 0) {
        return;
      }
      event.preventDefault();
      setIsDragSelecting(true);
      const anchor =
        event.shiftKey && previewSelection ? previewSelection.start : index;
      dragAnchorLineRef.current = anchor;
      dragMovedRef.current = false;
      selectRangeFromAnchor(anchor, index);
    },
    [previewKind, previewSelection, selectRangeFromAnchor],
  );

  const handleLineMouseEnter = useCallback(
    (index: number, _event: MouseEvent<HTMLButtonElement>) => {
      if (!isDragSelecting) {
        return;
      }
      const anchor = dragAnchorLineRef.current;
      if (anchor === null) {
        return;
      }
      if (anchor !== index) {
        dragMovedRef.current = true;
      }
      selectRangeFromAnchor(anchor, index);
    },
    [isDragSelecting, selectRangeFromAnchor],
  );

  const handleLineMouseUp = useCallback(() => {
    if (!isDragSelecting) {
      return;
    }
    setIsDragSelecting(false);
    dragAnchorLineRef.current = null;
  }, [isDragSelecting]);

  const selectionHints = useMemo(
    () =>
      previewKind === "text"
        ? ["Shift + click or drag + click", "for multi-line selection"]
        : [],
    [previewKind],
  );

  const handleAddSelection = useCallback(() => {
    if (previewKind !== "text" || !previewPath || !previewSelection || !onInsertText) {
      return;
    }
    const lines = previewContent.split("\n");
    const selected = lines.slice(previewSelection.start, previewSelection.end + 1);
    const language = languageFromPath(previewPath);
    const fence = language ? `\`\`\`${language}` : "```";
    const start = previewSelection.start + 1;
    const end = previewSelection.end + 1;
    const rangeLabel = start === end ? `L${start}` : `L${start}-L${end}`;
    const snippet = `${previewPath}:${rangeLabel}\n${fence}\n${selected.join("\n")}\n\`\`\``;
    onInsertText(snippet);
    closePreview();
  }, [
    previewContent,
    previewKind,
    previewPath,
    previewSelection,
    onInsertText,
    closePreview,
  ]);

  const showNodeMenu = useCallback(
    async (event: MouseEvent<HTMLButtonElement>, relativePath: string, isFolder: boolean) => {
      event.preventDefault();
      event.stopPropagation();
      const items = [] as MenuItem[];
      if (isFolder) {
        items.push(
          await MenuItem.new({
            text: "New File",
            action: () => handleCreateFile(relativePath),
          }),
          await MenuItem.new({
            text: "New Folder",
            action: () => handleCreateFolder(relativePath),
          }),
        );
      }
      items.push(
        await MenuItem.new({
          text: "Rename",
          action: () => handleRenamePath(relativePath),
        }),
        await MenuItem.new({
          text: "Move",
          action: () => handleMovePath(relativePath),
        }),
        await MenuItem.new({
          text: "Delete",
          action: () => handleDeletePath(relativePath),
        }),
        await MenuItem.new({
          text: "Reveal in Finder",
          action: async () => {
            await revealItemInDir(resolvePath(relativePath));
          },
        }),
      );
      const menu = await Menu.new({ items });
      const window = getCurrentWindow();
      const position = new LogicalPosition(event.clientX, event.clientY);
      await menu.popup(position, window);
    },
    [
      handleCreateFile,
      handleCreateFolder,
      handleDeletePath,
      handleMovePath,
      handleRenamePath,
      resolvePath,
    ],
  );

  const renderNode = (node: FileTreeNode, depth: number) => {
    const isFolder = node.type === "folder";
    const isExpanded = isFolder && expandedFolders.has(node.path);
    return (
      <div key={node.path}>
        <div className="file-tree-row-wrap">
          <button
            type="button"
            className={`file-tree-row${isFolder ? " is-folder" : " is-file"}`}
            style={{ paddingLeft: `${depth * 10}px` }}
            onClick={(event) => {
              if (isFolder) {
                toggleFolder(node.path);
                return;
              }
              if (onOpenFile) {
                onOpenFile(node.path);
                return;
              }
              openPreview(node.path, event.currentTarget);
            }}
            onContextMenu={(event) => {
              void showNodeMenu(event, node.path, isFolder);
            }}
          >
            {isFolder ? (
              <span className={`file-tree-chevron${isExpanded ? " is-open" : ""}`}>
                ›
              </span>
            ) : (
              <span className="file-tree-spacer" aria-hidden />
            )}
            <span
              className={`file-tree-icon ${isFolder ? "is-folder" : "is-file"}`}
              aria-hidden
            >
              {isFolder ? (
                isExpanded ? (
                  <FolderOpen className="file-tree-icon-svg" />
                ) : (
                  <Folder className="file-tree-icon-svg" />
                )
              ) : (
                <FileText className="file-tree-icon-svg" />
              )}
            </span>
            <span className="file-tree-name">{node.name}</span>
          </button>
          {!isFolder && showMentionActions && onInsertText && (
            <button
              type="button"
              className="ghost icon-button file-tree-action"
              onClick={(event) => {
                event.stopPropagation();
                onInsertText?.(node.path);
              }}
              aria-label={`Mention ${node.name}`}
              title="Mention in chat"
            >
              <Plus size={10} aria-hidden />
            </button>
          )}
        </div>
        {isFolder && isExpanded && node.children.length > 0 && (
          <div className="file-tree-children">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="diff-panel file-tree-panel">
      <div className="git-panel-header">
        {showTabs ? (
          <PanelTabs active={filePanelMode} onSelect={onFilePanelModeChange} />
        ) : null}
        <div className="file-tree-meta">
          <div className="file-tree-count">
          {filteredFiles.length
            ? normalizedQuery
              ? `${filteredFiles.length} match${filteredFiles.length === 1 ? "" : "es"}`
              : `${filteredFiles.length} file${filteredFiles.length === 1 ? "" : "s"}`
            : showLoading
              ? "Loading files"
              : "No files"}
        </div>
          <div className="file-tree-actions" role="group" aria-label="File actions">
            <button
              type="button"
              className="ghost icon-button"
              onClick={() => handleCreateFile("")}
              aria-label="New file"
              title="New file"
              disabled={actionBusy}
            >
              <FilePlus size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="ghost icon-button"
              onClick={() => handleCreateFolder("")}
              aria-label="New folder"
              title="New folder"
              disabled={actionBusy}
            >
              <FolderPlus size={14} aria-hidden />
            </button>
            <button
              type="button"
              className="ghost icon-button"
              onClick={() => onRefreshFiles?.()}
              aria-label="Refresh files"
              title="Refresh files"
              disabled={actionBusy}
            >
              <RefreshCcw size={14} aria-hidden />
            </button>
          </div>
          {hasFolders ? (
            <button
              type="button"
              className="ghost icon-button file-tree-toggle"
              onClick={toggleAllFolders}
              aria-label={allVisibleExpanded ? "Collapse all folders" : "Expand all folders"}
              title={allVisibleExpanded ? "Collapse all folders" : "Expand all folders"}
            >
              <ChevronsUpDown aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
      <div className="file-tree-search">
        <Search className="file-tree-search-icon" aria-hidden />
        <input
          className="file-tree-search-input"
          type="search"
          placeholder="Filter files and folders"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter files and folders"
        />
      </div>
      <div className="file-tree-list">
        {showLoading ? (
          <div className="file-tree-skeleton">
            {Array.from({ length: 8 }).map((_, index) => (
              <div
                className="file-tree-skeleton-row"
                key={`file-tree-skeleton-${index}`}
                style={{ width: `${68 + index * 3}%` }}
              />
            ))}
          </div>
        ) : nodes.length === 0 ? (
          <div className="file-tree-empty">
            {normalizedQuery ? "No matches found." : "No files available."}
          </div>
        ) : (
          nodes.map((node) => renderNode(node, 0))
        )}
      </div>
      {previewPath && previewAnchor
        ? createPortal(
            <FilePreviewPopover
              path={previewPath}
              absolutePath={resolvePath(previewPath)}
              content={previewContent}
              truncated={previewTruncated}
              previewKind={previewKind}
              imageSrc={previewImageSrc}
              openTargets={openTargets}
              openAppIconById={openAppIconById}
              selectedOpenAppId={selectedOpenAppId}
              onSelectOpenAppId={onSelectOpenAppId}
              selection={previewSelection}
              onSelectLine={handleSelectLine}
              onLineMouseDown={handleLineMouseDown}
              onLineMouseEnter={handleLineMouseEnter}
              onLineMouseUp={handleLineMouseUp}
              onClearSelection={() => setPreviewSelection(null)}
              onAddSelection={handleAddSelection}
              onClose={closePreview}
              selectionHints={selectionHints}
              style={{
                position: "fixed",
                top: previewAnchor.top,
                left: previewAnchor.left,
                width: 640,
                maxHeight: previewAnchor.height,
                ["--file-preview-arrow-top" as string]: `${previewAnchor.arrowTop}px`,
              }}
              isLoading={previewLoading}
              error={previewError}
            />,
            document.body,
          )
        : null}
    </aside>
  );
}
