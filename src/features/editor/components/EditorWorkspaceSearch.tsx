import Search from "lucide-react/dist/esm/icons/search";
import X from "lucide-react/dist/esm/icons/x";
import { useEffect, useMemo, useRef } from "react";

type WorkspaceSearchResult = {
  path: string;
  line: number;
  column: number;
  lineText: string;
  matchText?: string | null;
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

type EditorWorkspaceSearchProps = {
  isOpen: boolean;
  activeTab: WorkspaceSearchTab;
  onTabChange: (tab: WorkspaceSearchTab) => void;
  query: string;
  includeGlobs: string;
  excludeGlobs: string;
  results: WorkspaceSearchResult[];
  fileResults: string[];
  actions: WorkspaceSearchAction[];
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onIncludeChange: (value: string) => void;
  onExcludeChange: (value: string) => void;
  onSelectResult: (result: WorkspaceSearchResult) => void;
  onSelectFile: (path: string) => void;
  onSelectAction: (action: WorkspaceSearchAction) => void;
};

function highlightMatch(lineText: string, matchText?: string | null) {
  if (!matchText) {
    return lineText;
  }
  const index = lineText.toLowerCase().indexOf(matchText.toLowerCase());
  if (index < 0) {
    return lineText;
  }
  const before = lineText.slice(0, index);
  const match = lineText.slice(index, index + matchText.length);
  const after = lineText.slice(index + matchText.length);
  return (
    <>
      {before}
      <mark>{match}</mark>
      {after}
    </>
  );
}

const INCLUDE_PRESETS: Array<{ id: string; label: string; value: string }> = [
  { id: "all", label: "All", value: "" },
  { id: "src", label: "src/**", value: "src/**" },
  { id: "apps", label: "apps/**", value: "apps/**" },
  { id: "packages", label: "packages/**", value: "packages/**" },
  { id: "custom", label: "Custom", value: "" },
];

const EXCLUDE_PRESETS: Array<{ id: string; label: string; value: string }> = [
  { id: "default", label: "Default", value: "node_modules/**, dist/**, .git/**" },
  { id: "none", label: "None", value: "" },
  { id: "build", label: "Build", value: "dist/**, build/**, target/**" },
  { id: "custom", label: "Custom", value: "" },
];

function presetFromValue(
  presets: Array<{ id: string; value: string }>,
  value: string,
) {
  const trimmed = value.trim();
  const matched = presets.find((preset) => preset.value === trimmed);
  return matched?.id ?? "custom";
}

export function EditorWorkspaceSearch({
  isOpen,
  activeTab,
  onTabChange,
  query,
  includeGlobs,
  excludeGlobs,
  results,
  fileResults,
  actions,
  isLoading,
  error,
  onClose,
  onQueryChange,
  onIncludeChange,
  onExcludeChange,
  onSelectResult,
  onSelectFile,
  onSelectAction,
}: EditorWorkspaceSearchProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const includePreset = useMemo(
    () => presetFromValue(INCLUDE_PRESETS, includeGlobs),
    [includeGlobs],
  );
  const excludePreset = useMemo(
    () => presetFromValue(EXCLUDE_PRESETS, excludeGlobs),
    [excludeGlobs],
  );

  const summary = useMemo(() => {
    if (!query.trim()) {
      return "Type to search across the workspace.";
    }
    if (isLoading) {
      return "Searching...";
    }
    if (error) {
      return error;
    }
    if (results.length === 0) {
      return "No matches found.";
    }
    return `${results.length} result${results.length === 1 ? "" : "s"}`;
  }, [error, isLoading, query, results.length]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  const showTextControls = activeTab === "text" || activeTab === "all";

  return (
    <div className="editor-workspace-search" role="dialog" aria-modal="true">
      <button
        type="button"
        className="editor-workspace-search__backdrop"
        onClick={onClose}
        aria-label="Close workspace search"
      />
      <div className="editor-workspace-search__panel">
        <div className="editor-workspace-search__tabs">
          {(["all", "classes", "files", "symbols", "actions", "text"] as WorkspaceSearchTab[]).map(
            (tab) => (
              <button
                key={tab}
                type="button"
                className={`editor-workspace-search__tab${
                  tab === activeTab ? " is-active" : ""
                }`}
                onClick={() => onTabChange(tab)}
              >
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ),
          )}
          <button
            type="button"
            className="icon-button editor-workspace-search__close"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className="editor-workspace-search__search-row">
          <div className="editor-workspace-search__search-input">
            <Search size={16} aria-hidden />
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Type / to see commands"
            />
          </div>
          <div className="editor-workspace-search__filters">
            <label className="editor-workspace-search__filter">
              <span>Include</span>
              <div className="editor-workspace-search__filter-row">
                <select
                  value={includePreset}
                  onChange={(event) => {
                    const next = event.target.value;
                    const preset = INCLUDE_PRESETS.find((entry) => entry.id === next);
                    if (preset && preset.id !== "custom") {
                      onIncludeChange(preset.value);
                    }
                  }}
                  disabled={!showTextControls}
                >
                  {INCLUDE_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>
            </label>
            <label className="editor-workspace-search__filter">
              <span>Exclude</span>
              <div className="editor-workspace-search__filter-row">
                <select
                  value={excludePreset}
                  onChange={(event) => {
                    const next = event.target.value;
                    const preset = EXCLUDE_PRESETS.find((entry) => entry.id === next);
                    if (preset && preset.id !== "custom") {
                      onExcludeChange(preset.value);
                    }
                  }}
                  disabled={!showTextControls}
                >
                  {EXCLUDE_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </div>
            </label>
          </div>
        </div>
        <div className="editor-workspace-search__summary">{summary}</div>
        <div className="editor-workspace-search__results">
          {(activeTab === "all" || activeTab === "actions") && actions.length > 0 ? (
            <div className="editor-workspace-search__section">
              <div className="editor-workspace-search__section-title">Actions</div>
              {actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className="editor-workspace-search__result"
                  onClick={() => onSelectAction(action)}
                >
                  <div className="editor-workspace-search__result-path">
                    {action.label}
                  </div>
                  {action.detail ? (
                    <div className="editor-workspace-search__result-line">
                      <span className="editor-workspace-search__result-text">
                        {action.detail}
                      </span>
                    </div>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          {(activeTab === "all" || activeTab === "files") && fileResults.length > 0 ? (
            <div className="editor-workspace-search__section">
              <div className="editor-workspace-search__section-title">Files</div>
              {fileResults.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="editor-workspace-search__result"
                  onClick={() => onSelectFile(path)}
                >
                  <div className="editor-workspace-search__result-path">
                    {path.split("/").pop() ?? path}
                  </div>
                  <div className="editor-workspace-search__result-line">
                    <span className="editor-workspace-search__result-text">
                      {path}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
          {(activeTab === "all" || activeTab === "text") && results.length > 0
            ? results.map((result) => (
                <button
                  key={`${result.path}:${result.line}:${result.column}`}
                  type="button"
                  className="editor-workspace-search__result"
                  onClick={() => onSelectResult(result)}
                >
                  <div className="editor-workspace-search__result-path">
                    {result.path}
                  </div>
                  <div className="editor-workspace-search__result-line">
                    <span className="editor-workspace-search__result-loc">
                      {result.line}:{result.column}
                    </span>
                    <span className="editor-workspace-search__result-text">
                      {highlightMatch(result.lineText, result.matchText)}
                    </span>
                  </div>
                </button>
              ))
            : null}
        </div>
      </div>
    </div>
  );
}
