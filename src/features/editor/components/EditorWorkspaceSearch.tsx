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

type EditorWorkspaceSearchProps = {
  isOpen: boolean;
  query: string;
  includeGlobs: string;
  excludeGlobs: string;
  results: WorkspaceSearchResult[];
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onIncludeChange: (value: string) => void;
  onExcludeChange: (value: string) => void;
  onSelectResult: (result: WorkspaceSearchResult) => void;
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
  query,
  includeGlobs,
  excludeGlobs,
  results,
  isLoading,
  error,
  onClose,
  onQueryChange,
  onIncludeChange,
  onExcludeChange,
  onSelectResult,
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
        <div className="editor-workspace-search__header">
          <div className="editor-workspace-search__title">
            <Search size={16} aria-hidden />
            Workspace search
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className="editor-workspace-search__inputs">
          <label className="editor-workspace-search__field">
            <span>Query</span>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="Search text or regex..."
            />
          </label>
          <label className="editor-workspace-search__field">
            <span>Include folders (comma-separated globs)</span>
            <input
              type="text"
              value={includeGlobs}
              onChange={(event) => onIncludeChange(event.target.value)}
              placeholder="src/**, apps/**"
            />
          </label>
          <label className="editor-workspace-search__field">
            <span>Exclude folders (comma-separated globs)</span>
            <input
              type="text"
              value={excludeGlobs}
              onChange={(event) => onExcludeChange(event.target.value)}
              placeholder="node_modules/**, dist/**"
            />
          </label>
          <div className="editor-workspace-search__summary">{summary}</div>
        </div>
        <div className="editor-workspace-search__results">
          {results.map((result) => (
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
          ))}
        </div>
      </div>
    </div>
  );
}
