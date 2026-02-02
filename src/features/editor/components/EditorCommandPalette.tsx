import Search from "lucide-react/dist/esm/icons/search";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import FileText from "lucide-react/dist/esm/icons/file-text";
import Wrench from "lucide-react/dist/esm/icons/wrench";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorKeymap, LaunchScriptEntry } from "../../../types";

type PaletteItem = {
  id: string;
  label: string;
  detail?: string | null;
  kind: "action" | "file" | "script";
  icon: ReactNode;
  onSelect: () => void;
};

type EditorCommandPaletteProps = {
  isOpen: boolean;
  onClose: () => void;
  editorKeymap: EditorKeymap;
  onOpenWorkspaceSearch: () => void;
  availablePaths: string[];
  openPaths: string[];
  onOpenPath: (path: string) => void;
  onOpenFind: () => void;
  onOpenReplace: () => void;
  launchScript: string | null;
  launchScripts: LaunchScriptEntry[];
  onRunLaunchScript: () => void;
  onRunLaunchScriptEntry: (id: string) => void;
};

const QUERY_LIMIT = 60;

function normalizeQuery(value: string) {
  return value.trim().toLowerCase();
}

function findLaunchEntry(entries: LaunchScriptEntry[], patterns: RegExp[]) {
  return entries.find((entry) => {
    const label = (entry.label ?? "").toLowerCase();
    return patterns.some((pattern) => pattern.test(label));
  });
}

export function EditorCommandPalette({
  isOpen,
  onClose,
  editorKeymap,
  onOpenWorkspaceSearch,
  availablePaths,
  openPaths,
  onOpenPath,
  onOpenFind,
  onOpenReplace,
  launchScript,
  launchScripts,
  onRunLaunchScript,
  onRunLaunchScriptEntry,
}: EditorCommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const actionItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [
      {
        id: "workspace-search",
        label: "Search in workspace",
        detail: "Find matches across the project",
        kind: "action",
        icon: <Search size={16} aria-hidden />,
        onSelect: onOpenWorkspaceSearch,
      },
      {
        id: "find",
        label: "Find in file",
        detail: "Search within the current file",
        kind: "action",
        icon: <Search size={16} aria-hidden />,
        onSelect: onOpenFind,
      },
      {
        id: "replace",
        label: "Replace in file",
        detail: "Find and replace within the current file",
        kind: "action",
        icon: <Wrench size={16} aria-hidden />,
        onSelect: onOpenReplace,
      },
    ];

    if (launchScript) {
      items.push({
        id: "launch",
        label: "Run workspace launch script",
        detail: "Run the default workspace command",
        kind: "action",
        icon: <Terminal size={16} aria-hidden />,
        onSelect: onRunLaunchScript,
      });
    }

    const testEntry = findLaunchEntry(launchScripts, [/test/, /e2e/, /unit/]);
    if (testEntry) {
      items.push({
        id: `launch-test-${testEntry.id}`,
        label: "Run test script",
        detail: testEntry.label ?? "Launch entry",
        kind: "action",
        icon: <Terminal size={16} aria-hidden />,
        onSelect: () => onRunLaunchScriptEntry(testEntry.id),
      });
    }

    const deployEntry = findLaunchEntry(launchScripts, [
      /deploy/,
      /release/,
      /publish/,
      /prod/,
    ]);
    if (deployEntry) {
      items.push({
        id: `launch-deploy-${deployEntry.id}`,
        label: "Run deploy script",
        detail: deployEntry.label ?? "Launch entry",
        kind: "action",
        icon: <Terminal size={16} aria-hidden />,
        onSelect: () => onRunLaunchScriptEntry(deployEntry.id),
      });
    }

    if (launchScripts.length > 0) {
      for (const entry of launchScripts) {
        const label = entry.label?.trim() || "Launch script";
        items.push({
          id: `launch-${entry.id}`,
          label: `Run ${label}`,
          detail: label,
          kind: "script",
          icon: <Terminal size={16} aria-hidden />,
          onSelect: () => onRunLaunchScriptEntry(entry.id),
        });
      }
    }

    return items;
  }, [
    launchScript,
    launchScripts,
    onOpenFind,
    onOpenReplace,
    onOpenWorkspaceSearch,
    onRunLaunchScript,
    onRunLaunchScriptEntry,
  ]);

  const filteredActionItems = useMemo(() => {
    const normalized = normalizeQuery(query);
    if (!normalized) {
      return actionItems;
    }
    return actionItems.filter((item) => {
      const haystack = `${item.label} ${item.detail ?? ""}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [actionItems, query]);

  const filteredFileItems = useMemo<PaletteItem[]>(() => {
    const normalized = normalizeQuery(query);
    if (!normalized) {
      return [];
    }
    const matches = availablePaths
      .filter((path) => path.toLowerCase().includes(normalized))
      .slice(0, QUERY_LIMIT)
      .map((path) => ({
        id: `file-${path}`,
        label: path.split("/").pop() ?? path,
        detail: path,
        kind: "file" as const,
        icon: <FileText size={16} aria-hidden />,
        onSelect: () => onOpenPath(path),
      }));
    return matches;
  }, [availablePaths, onOpenPath, query]);

  const flatItems = useMemo(() => {
    const items: PaletteItem[] = [];
    items.push(...filteredActionItems);
    items.push(...filteredFileItems);
    return items;
  }, [filteredActionItems, filteredFileItems]);

  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex(0);
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  const handleSelect = useCallback(
    (item: PaletteItem) => {
      item.onSelect();
      onClose();
    },
    [onClose],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, flatItems.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const item = flatItems[selectedIndex];
        if (item) {
          handleSelect(item);
        }
      }
    },
    [flatItems, handleSelect, onClose, selectedIndex],
  );

  if (!isOpen) {
    return null;
  }

  const hint =
    editorKeymap === "jetbrains" ? "Shift+Shift" : "Cmd/Ctrl+Shift+P";

  return (
    <div className="editor-command-palette" role="dialog" aria-modal="true">
      <button
        type="button"
        className="editor-command-palette__backdrop"
        onClick={onClose}
        aria-label="Close command palette"
      />
      <div className="editor-command-palette__panel">
        <div className="editor-command-palette__input-row">
          <Search size={16} aria-hidden />
          <input
            ref={inputRef}
            className="editor-command-palette__input"
            placeholder="Type a command or file name..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            aria-label="Command palette query"
          />
          <span className="editor-command-palette__hint">{hint}</span>
        </div>
        <div className="editor-command-palette__results" role="listbox">
          {filteredActionItems.length > 0 ? (
            <div className="editor-command-palette__section">
              <div className="editor-command-palette__section-title">Actions</div>
              {filteredActionItems.map((item, index) => {
                const absoluteIndex = index;
                const isActive = absoluteIndex === selectedIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`editor-command-palette__item${isActive ? " is-active" : ""}`}
                    onClick={() => handleSelect(item)}
                    role="option"
                    aria-selected={isActive}
                  >
                    <span className="editor-command-palette__icon">{item.icon}</span>
                    <span className="editor-command-palette__label">{item.label}</span>
                    {item.detail ? (
                      <span className="editor-command-palette__detail">{item.detail}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {filteredFileItems.length > 0 ? (
            <div className="editor-command-palette__section">
              <div className="editor-command-palette__section-title">Files</div>
              {filteredFileItems.map((item, index) => {
                const absoluteIndex = filteredActionItems.length + index;
                const isActive = absoluteIndex === selectedIndex;
                const isOpen = openPaths.includes(item.detail ?? "");
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`editor-command-palette__item${isActive ? " is-active" : ""}`}
                    onClick={() => handleSelect(item)}
                    role="option"
                    aria-selected={isActive}
                  >
                    <span className="editor-command-palette__icon">{item.icon}</span>
                    <span className="editor-command-palette__label">{item.label}</span>
                    <span className="editor-command-palette__detail">
                      {item.detail}
                    </span>
                    {isOpen ? (
                      <span className="editor-command-palette__tag">Open</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {flatItems.length === 0 ? (
            <div className="editor-command-palette__empty">No matches.</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
