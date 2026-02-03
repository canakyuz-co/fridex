import { memo } from "react";
import AlignLeft from "lucide-react/dist/esm/icons/align-left";
import Columns2 from "lucide-react/dist/esm/icons/columns-2";
import Code from "lucide-react/dist/esm/icons/code";
import Mic from "lucide-react/dist/esm/icons/mic";
import type { SidebarToggleProps } from "../../layout/components/SidebarToggleControls";
import { RightPanelCollapseButton } from "../../layout/components/SidebarToggleControls";

type MainHeaderActionsProps = {
  centerMode: "chat" | "diff";
  gitDiffViewStyle: "split" | "unified";
  onSelectDiffViewStyle: (style: "split" | "unified") => void;
  activeTab: "projects" | "codex" | "git" | "log" | "editor";
  onSelectTab: (tab: "projects" | "codex" | "git" | "log" | "editor") => void;
  isCompact: boolean;
  rightPanelCollapsed: boolean;
  sidebarToggleProps: SidebarToggleProps;
  voiceAssistantActive: boolean;
  voiceAssistantReady: boolean;
  onToggleVoiceAssistant: () => void;
};

export const MainHeaderActions = memo(function MainHeaderActions({
  centerMode,
  gitDiffViewStyle,
  onSelectDiffViewStyle,
  activeTab,
  onSelectTab,
  isCompact,
  rightPanelCollapsed,
  sidebarToggleProps,
  voiceAssistantActive,
  voiceAssistantReady,
  onToggleVoiceAssistant,
}: MainHeaderActionsProps) {
  const editorActive = activeTab === "editor";
  return (
    <>
      <button
        type="button"
        className={`icon-button voice-assistant-toggle${
          voiceAssistantActive ? " is-active" : ""
        }`}
        onClick={onToggleVoiceAssistant}
        aria-pressed={voiceAssistantActive}
        aria-disabled={!voiceAssistantReady}
        title={
          voiceAssistantReady
            ? voiceAssistantActive
              ? "Stop listening"
              : "Start listening"
            : "Dictation model not ready"
        }
        disabled={!voiceAssistantReady}
        data-tauri-drag-region="false"
      >
        <Mic size={14} aria-hidden />
      </button>
      <button
        type="button"
        className={`icon-button editor-toggle${editorActive ? " is-active" : ""}`}
        onClick={() => onSelectTab(editorActive ? "codex" : "editor")}
        aria-pressed={editorActive}
        title="Editor"
        data-tauri-drag-region="false"
      >
        <Code size={14} aria-hidden />
      </button>
      {centerMode === "diff" && (
        <div className="diff-view-toggle" role="group" aria-label="Diff view">
          <button
            type="button"
            className={`diff-view-toggle-button${
              gitDiffViewStyle === "split" ? " is-active" : ""
            }`}
            onClick={() => onSelectDiffViewStyle("split")}
            aria-pressed={gitDiffViewStyle === "split"}
            title="Dual-panel diff"
            data-tauri-drag-region="false"
          >
            <Columns2 size={14} aria-hidden />
          </button>
          <button
            type="button"
            className={`diff-view-toggle-button${
              gitDiffViewStyle === "unified" ? " is-active" : ""
            }`}
            onClick={() => onSelectDiffViewStyle("unified")}
            aria-pressed={gitDiffViewStyle === "unified"}
            title="Single-column diff"
            data-tauri-drag-region="false"
          >
            <AlignLeft size={14} aria-hidden />
          </button>
        </div>
      )}
      {!isCompact && !rightPanelCollapsed ? (
        <RightPanelCollapseButton {...sidebarToggleProps} />
      ) : null}
    </>
  );
});
