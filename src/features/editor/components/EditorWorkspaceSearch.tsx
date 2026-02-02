import Search from "lucide-react/dist/esm/icons/search";
import FileText from "lucide-react/dist/esm/icons/file-text";
import Terminal from "lucide-react/dist/esm/icons/terminal";
import Hash from "lucide-react/dist/esm/icons/hash";
import Boxes from "lucide-react/dist/esm/icons/boxes";
import Braces from "lucide-react/dist/esm/icons/braces";
import X from "lucide-react/dist/esm/icons/x";
import { useEffect, useMemo, useRef } from "react";

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

type EditorWorkspaceSearchProps = {
  isOpen: boolean;
  activeTab: WorkspaceSearchTab;
  onTabChange: (tab: WorkspaceSearchTab) => void;
  query: string;
  results: WorkspaceSearchResult[];
  fileResults: string[];
  classResults: WorkspaceSymbolResult[];
  symbolResults: WorkspaceSymbolResult[];
  symbolLoading: boolean;
  symbolError: string | null;
  actions: WorkspaceSearchAction[];
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onSelectResult: (result: WorkspaceSearchResult) => void;
  onSelectFile: (path: string) => void;
  onSelectAction: (action: WorkspaceSearchAction) => void;
  onSelectSymbol: (symbol: WorkspaceSymbolResult) => void;
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


export function EditorWorkspaceSearch({
  isOpen,
  activeTab,
  onTabChange,
  query,
  results,
  fileResults,
  classResults,
  symbolResults,
  symbolLoading,
  symbolError,
  actions,
  isLoading,
  error,
  onClose,
  onQueryChange,
  onSelectResult,
  onSelectFile,
  onSelectAction,
  onSelectSymbol,
}: EditorWorkspaceSearchProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

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

  const symbolSummary = useMemo(() => {
    if (symbolLoading) {
      return "Loading symbols...";
    }
    if (symbolError) {
      return symbolError;
    }
    return null;
  }, [symbolError, symbolLoading]);

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
                  <div className="editor-workspace-search__result-icon">
                    <Terminal size={14} aria-hidden />
                  </div>
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
                  <div className="editor-workspace-search__result-icon">
                    <FileText size={14} aria-hidden />
                  </div>
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
                  <div className="editor-workspace-search__result-icon">
                    <Hash size={14} aria-hidden />
                  </div>
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
          {(activeTab === "all" || activeTab === "classes") &&
          classResults.length > 0
            ? classResults.map((symbol) => (
                <button
                  key={`class-${symbol.name}-${symbol.line}-${symbol.column}`}
                  type="button"
                  className="editor-workspace-search__result"
                  onClick={() => onSelectSymbol(symbol)}
                >
                  <div className="editor-workspace-search__result-icon">
                    <Boxes size={14} aria-hidden />
                  </div>
                  <div className="editor-workspace-search__result-path">
                    {symbol.name}
                  </div>
                  <div className="editor-workspace-search__result-line">
                    <span className="editor-workspace-search__result-loc">
                      {symbol.line}:{symbol.column}
                    </span>
                  </div>
                </button>
              ))
            : null}
          {(activeTab === "all" || activeTab === "symbols") &&
          symbolResults.length > 0
            ? symbolResults.map((symbol) => (
                <button
                  key={`symbol-${symbol.name}-${symbol.line}-${symbol.column}`}
                  type="button"
                  className="editor-workspace-search__result"
                  onClick={() => onSelectSymbol(symbol)}
                >
                  <div className="editor-workspace-search__result-icon">
                    <Braces size={14} aria-hidden />
                  </div>
                  <div className="editor-workspace-search__result-path">
                    {symbol.name}
                  </div>
                  <div className="editor-workspace-search__result-line">
                    <span className="editor-workspace-search__result-loc">
                      {symbol.line}:{symbol.column}
                    </span>
                  </div>
                </button>
              ))
            : null}
          {symbolSummary ? (
            <div className="editor-workspace-search__empty">{symbolSummary}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
