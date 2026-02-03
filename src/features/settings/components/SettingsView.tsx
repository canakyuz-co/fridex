import { useCallback, useEffect, useMemo, useState } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up";
import LayoutGrid from "lucide-react/dist/esm/icons/layout-grid";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal";
import Mic from "lucide-react/dist/esm/icons/mic";
import Sparkles from "lucide-react/dist/esm/icons/sparkles";
import Keyboard from "lucide-react/dist/esm/icons/keyboard";
import Stethoscope from "lucide-react/dist/esm/icons/stethoscope";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import TerminalSquare from "lucide-react/dist/esm/icons/terminal-square";
import FileText from "lucide-react/dist/esm/icons/file-text";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import X from "lucide-react/dist/esm/icons/x";
import FlaskConical from "lucide-react/dist/esm/icons/flask-conical";
import ExternalLink from "lucide-react/dist/esm/icons/external-link";
import type {
  AppSettings,
  CodexDoctorResult,
  DictationModelStatus,
  WorkspaceSettings,
  OpenAppTarget,
  WorkspaceGroup,
  WorkspaceInfo,
} from "../../../types";
import { formatDownloadSize } from "../../../utils/formatting";
import {
  buildShortcutValue,
  formatShortcut,
  getDefaultInterruptShortcut,
} from "../../../utils/shortcuts";
import { clampUiScale } from "../../../utils/uiScale";
import { getCodexConfigPath, listOtherAiModels, speakText } from "../../../services/tauri";
import { pushErrorToast } from "../../../services/toasts";
import {
  CODE_FONT_FAMILY_OPTIONS,
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_UI_FONT_FAMILY,
  INTER_FONT_FEATURES,
  UI_FONT_FAMILY_OPTIONS,
  CODE_FONT_SIZE_DEFAULT,
  CODE_FONT_SIZE_MAX,
  CODE_FONT_SIZE_MIN,
  clampCodeFontSize,
  isInterFontFamily,
  normalizeFontFamily,
} from "../../../utils/fonts";
import { DEFAULT_OPEN_APP_ID, OPEN_APP_STORAGE_KEY } from "../../app/constants";
import { GENERIC_APP_ICON, getKnownOpenAppIcon } from "../../app/utils/openAppIcons";
import { useGlobalAgentsMd } from "../hooks/useGlobalAgentsMd";
import { useGlobalCodexConfigToml } from "../hooks/useGlobalCodexConfigToml";
import { FileEditorCard } from "../../shared/components/FileEditorCard";

const DICTATION_MODELS = [
  { id: "tiny", label: "Tiny", size: "75 MB", note: "Fastest, least accurate." },
  { id: "base", label: "Base", size: "142 MB", note: "Balanced default." },
  { id: "small", label: "Small", size: "466 MB", note: "Better accuracy." },
  { id: "medium", label: "Medium", size: "1.5 GB", note: "High accuracy." },
  { id: "large-v3", label: "Large V3", size: "3.0 GB", note: "Best accuracy, heavy download." },
];

type ComposerPreset = AppSettings["composerEditorPreset"];

type ComposerPresetSettings = Pick<
  AppSettings,
  | "composerFenceExpandOnSpace"
  | "composerFenceExpandOnEnter"
  | "composerFenceLanguageTags"
  | "composerFenceWrapSelection"
  | "composerFenceAutoWrapPasteMultiline"
  | "composerFenceAutoWrapPasteCodeLike"
  | "composerListContinuation"
  | "composerCodeBlockCopyUseModifier"
>;

const COMPOSER_PRESET_LABELS: Record<ComposerPreset, string> = {
  default: "Default (no helpers)",
  helpful: "Helpful",
  smart: "Smart",
};

const COMPOSER_PRESET_CONFIGS: Record<ComposerPreset, ComposerPresetSettings> = {
  default: {
    composerFenceExpandOnSpace: false,
    composerFenceExpandOnEnter: false,
    composerFenceLanguageTags: false,
    composerFenceWrapSelection: false,
    composerFenceAutoWrapPasteMultiline: false,
    composerFenceAutoWrapPasteCodeLike: false,
    composerListContinuation: false,
    composerCodeBlockCopyUseModifier: false,
  },
  helpful: {
    composerFenceExpandOnSpace: true,
    composerFenceExpandOnEnter: false,
    composerFenceLanguageTags: true,
    composerFenceWrapSelection: true,
    composerFenceAutoWrapPasteMultiline: true,
    composerFenceAutoWrapPasteCodeLike: false,
    composerListContinuation: true,
    composerCodeBlockCopyUseModifier: false,
  },
  smart: {
    composerFenceExpandOnSpace: true,
    composerFenceExpandOnEnter: false,
    composerFenceLanguageTags: true,
    composerFenceWrapSelection: true,
    composerFenceAutoWrapPasteMultiline: true,
    composerFenceAutoWrapPasteCodeLike: true,
    composerListContinuation: true,
    composerCodeBlockCopyUseModifier: false,
  },
};

const EDITOR_KEYMAP_OPTIONS: Array<{
  id: AppSettings["editorKeymap"];
  label: string;
}> = [
  { id: "jetbrains", label: "JetBrains (default)" },
  { id: "vscode", label: "VS Code" },
  { id: "default", label: "Monaco Default" },
];

const normalizeOverrideValue = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const buildWorkspaceOverrideDrafts = (
  projects: WorkspaceInfo[],
  prev: Record<string, string>,
  getValue: (workspace: WorkspaceInfo) => string | null | undefined,
): Record<string, string> => {
  const next: Record<string, string> = {};
  projects.forEach((workspace) => {
    const existing = prev[workspace.id];
    next[workspace.id] = existing ?? getValue(workspace) ?? "";
  });
  return next;
};

type OtherAiDraft = {
  id: string;
  label: string;
  provider: string;
  enabled: boolean;
  apiKey: string;
  command: string;
  args: string;
  modelsText: string;
  protocol: string;
  envText: string;
};

const normalizeTextValue = (value: string) => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const parseModelList = (value: string) =>
  Array.from(
    new Set(
      value
        .split(/[\n,]+/g)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );

const formatEnvText = (value: Record<string, string> | null | undefined) => {
  if (!value) {
    return "";
  }
  return Object.entries(value)
    .map(([key, val]) => `${key}=${val}`)
    .join("\n");
};

const parseEnvText = (value: string) => {
  const env: Record<string, string> = {};
  value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .forEach((line) => {
      const index = line.indexOf("=");
      if (index <= 0) {
        return;
      }
      const key = line.slice(0, index).trim();
      const val = line.slice(index + 1).trim();
      if (!key) {
        return;
      }
      env[key] = val;
    });
  return env;
};

const normalizeProviderType = (
  value: string,
  fallback: AppSettings["otherAiProviders"][number]["provider"],
) => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "claude" || normalized === "gemini" || normalized === "custom") {
    return normalized;
  }
  return fallback;
};

const normalizeProtocol = (value: string): "acp" | "api" | "cli" => {
  const normalized = value.trim().toLowerCase();
  if (normalized === "acp" || normalized === "api" || normalized === "cli") {
    return normalized;
  }
  return "acp";
};

const buildOtherAiDrafts = (providers: AppSettings["otherAiProviders"]) =>
  providers.reduce<Record<string, OtherAiDraft>>((acc, provider) => {
    acc[provider.id] = {
      id: provider.id,
      label: provider.label ?? provider.id,
      provider: provider.provider,
      enabled: provider.enabled,
      apiKey: provider.apiKey ?? "",
      command: provider.command ?? "",
      args: provider.args ?? "",
      modelsText: (provider.models ?? []).join("\n"),
      protocol: provider.protocol ?? "acp",
      envText: formatEnvText(provider.env),
    };
    return acc;
  }, {});

export type SettingsViewProps = {
  workspaceGroups: WorkspaceGroup[];
  groupedWorkspaces: Array<{
    id: string | null;
    name: string;
    workspaces: WorkspaceInfo[];
  }>;
  ungroupedLabel: string;
  onClose: () => void;
  onMoveWorkspace: (id: string, direction: "up" | "down") => void;
  onDeleteWorkspace: (id: string) => void;
  onCreateWorkspaceGroup: (name: string) => Promise<WorkspaceGroup | null>;
  onRenameWorkspaceGroup: (id: string, name: string) => Promise<boolean | null>;
  onMoveWorkspaceGroup: (id: string, direction: "up" | "down") => Promise<boolean | null>;
  onDeleteWorkspaceGroup: (id: string) => Promise<boolean | null>;
  onAssignWorkspaceGroup: (
    workspaceId: string,
    groupId: string | null,
  ) => Promise<boolean | null>;
  reduceTransparency: boolean;
  onToggleTransparency: (value: boolean) => void;
  appSettings: AppSettings;
  openAppIconById: Record<string, string>;
  onUpdateAppSettings: (next: AppSettings) => Promise<void>;
  onRunDoctor: (
    codexBin: string | null,
    codexArgs: string | null,
  ) => Promise<CodexDoctorResult>;
  onUpdateWorkspaceCodexBin: (id: string, codexBin: string | null) => Promise<void>;
  onUpdateWorkspaceSettings: (
    id: string,
    settings: Partial<WorkspaceSettings>,
  ) => Promise<void>;
  scaleShortcutTitle: string;
  scaleShortcutText: string;
  onTestNotificationSound: () => void;
  dictationModelStatus?: DictationModelStatus | null;
  onDownloadDictationModel?: () => void;
  onCancelDictationDownload?: () => void;
  onRemoveDictationModel?: () => void;
  voiceAssistantModelStatus?: DictationModelStatus | null;
  onDownloadVoiceAssistantModel?: () => void;
  onCancelVoiceAssistantDownload?: () => void;
  onRemoveVoiceAssistantModel?: () => void;
  initialSection?: CodexSection;
};

type SettingsSection =
  | "projects"
  | "display"
  | "composer"
  | "voice-assistant"
  | "dictation"
  | "shortcuts"
  | "open-apps"
  | "git"
  | "other-ai";
type CodexSection = SettingsSection | "codex" | "experimental";
type ShortcutSettingKey =
  | "composerModelShortcut"
  | "composerAccessShortcut"
  | "composerReasoningShortcut"
  | "composerCollaborationShortcut"
  | "interruptShortcut"
  | "newAgentShortcut"
  | "newWorktreeAgentShortcut"
  | "newCloneAgentShortcut"
  | "archiveThreadShortcut"
  | "toggleProjectsSidebarShortcut"
  | "toggleGitSidebarShortcut"
  | "toggleDebugPanelShortcut"
  | "toggleTerminalShortcut"
  | "cycleAgentNextShortcut"
  | "cycleAgentPrevShortcut"
  | "cycleWorkspaceNextShortcut"
  | "cycleWorkspacePrevShortcut";
type ShortcutDraftKey =
  | "model"
  | "access"
  | "reasoning"
  | "collaboration"
  | "interrupt"
  | "newAgent"
  | "newWorktreeAgent"
  | "newCloneAgent"
  | "archiveThread"
  | "projectsSidebar"
  | "gitSidebar"
  | "debugPanel"
  | "terminal"
  | "cycleAgentNext"
  | "cycleAgentPrev"
  | "cycleWorkspaceNext"
  | "cycleWorkspacePrev";

type OpenAppDraft = OpenAppTarget & { argsText: string };

const shortcutDraftKeyBySetting: Record<ShortcutSettingKey, ShortcutDraftKey> = {
  composerModelShortcut: "model",
  composerAccessShortcut: "access",
  composerReasoningShortcut: "reasoning",
  composerCollaborationShortcut: "collaboration",
  interruptShortcut: "interrupt",
  newAgentShortcut: "newAgent",
  newWorktreeAgentShortcut: "newWorktreeAgent",
  newCloneAgentShortcut: "newCloneAgent",
  archiveThreadShortcut: "archiveThread",
  toggleProjectsSidebarShortcut: "projectsSidebar",
  toggleGitSidebarShortcut: "gitSidebar",
  toggleDebugPanelShortcut: "debugPanel",
  toggleTerminalShortcut: "terminal",
  cycleAgentNextShortcut: "cycleAgentNext",
  cycleAgentPrevShortcut: "cycleAgentPrev",
  cycleWorkspaceNextShortcut: "cycleWorkspaceNext",
  cycleWorkspacePrevShortcut: "cycleWorkspacePrev",
};

const buildOpenAppDrafts = (targets: OpenAppTarget[]): OpenAppDraft[] =>
  targets.map((target) => ({
    ...target,
    argsText: target.args.join(" "),
  }));

const createOpenAppId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `open-app-${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

export function SettingsView({
  workspaceGroups,
  groupedWorkspaces,
  ungroupedLabel,
  onClose,
  onMoveWorkspace,
  onDeleteWorkspace,
  onCreateWorkspaceGroup,
  onRenameWorkspaceGroup,
  onMoveWorkspaceGroup,
  onDeleteWorkspaceGroup,
  onAssignWorkspaceGroup,
  reduceTransparency,
  onToggleTransparency,
  appSettings,
  openAppIconById,
  onUpdateAppSettings,
  onRunDoctor,
  onUpdateWorkspaceCodexBin,
  onUpdateWorkspaceSettings,
  scaleShortcutTitle,
  scaleShortcutText,
  onTestNotificationSound,
  dictationModelStatus,
  onDownloadDictationModel,
  onCancelDictationDownload,
  onRemoveDictationModel,
  voiceAssistantModelStatus,
  onDownloadVoiceAssistantModel,
  onCancelVoiceAssistantDownload,
  onRemoveVoiceAssistantModel,
  initialSection,
}: SettingsViewProps) {
  const [activeSection, setActiveSection] = useState<CodexSection>("projects");
  const [activeShortcutsTab, setActiveShortcutsTab] = useState<"chat" | "editor">("chat");
  const [codexPathDraft, setCodexPathDraft] = useState(appSettings.codexBin ?? "");
  const [codexArgsDraft, setCodexArgsDraft] = useState(appSettings.codexArgs ?? "");
  const [remoteHostDraft, setRemoteHostDraft] = useState(appSettings.remoteBackendHost);
  const [remoteTokenDraft, setRemoteTokenDraft] = useState(appSettings.remoteBackendToken ?? "");
  const [scaleDraft, setScaleDraft] = useState(
    `${Math.round(clampUiScale(appSettings.uiScale) * 100)}%`,
  );
  const [uiFontDraft, setUiFontDraft] = useState(appSettings.uiFontFamily);
  const [codeFontDraft, setCodeFontDraft] = useState(appSettings.codeFontFamily);
  const [codeFontSizeDraft, setCodeFontSizeDraft] = useState(appSettings.codeFontSize);
  const [codexBinOverrideDrafts, setCodexBinOverrideDrafts] = useState<
    Record<string, string>
  >({});
  const [codexHomeOverrideDrafts, setCodexHomeOverrideDrafts] = useState<
    Record<string, string>
  >({});
  const [codexArgsOverrideDrafts, setCodexArgsOverrideDrafts] = useState<
    Record<string, string>
  >({});
  const [groupDrafts, setGroupDrafts] = useState<Record<string, string>>({});
  const [newGroupName, setNewGroupName] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  const [openAppDrafts, setOpenAppDrafts] = useState<OpenAppDraft[]>(() =>
    buildOpenAppDrafts(appSettings.openAppTargets),
  );
  const [openAppSelectedId, setOpenAppSelectedId] = useState(
    appSettings.selectedOpenAppId,
  );
  const [otherAiDrafts, setOtherAiDrafts] = useState<
    Record<string, OtherAiDraft>
  >(() => buildOtherAiDrafts(appSettings.otherAiProviders));
  const [otherAiFetchState, setOtherAiFetchState] = useState<
    Record<string, { loading: boolean }>
  >({});
  const [doctorState, setDoctorState] = useState<{
    status: "idle" | "running" | "done";
    result: CodexDoctorResult | null;
  }>({ status: "idle", result: null });
  const {
    content: globalAgentsContent,
    exists: globalAgentsExists,
    truncated: globalAgentsTruncated,
    isLoading: globalAgentsLoading,
    isSaving: globalAgentsSaving,
    error: globalAgentsError,
    isDirty: globalAgentsDirty,
    setContent: setGlobalAgentsContent,
    refresh: refreshGlobalAgents,
    save: saveGlobalAgents,
  } = useGlobalAgentsMd();
  const {
    content: globalConfigContent,
    exists: globalConfigExists,
    truncated: globalConfigTruncated,
    isLoading: globalConfigLoading,
    isSaving: globalConfigSaving,
    error: globalConfigError,
    isDirty: globalConfigDirty,
    setContent: setGlobalConfigContent,
    refresh: refreshGlobalConfig,
    save: saveGlobalConfig,
  } = useGlobalCodexConfigToml();
  const [openConfigError, setOpenConfigError] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [shortcutDrafts, setShortcutDrafts] = useState({
    model: appSettings.composerModelShortcut ?? "",
    access: appSettings.composerAccessShortcut ?? "",
    reasoning: appSettings.composerReasoningShortcut ?? "",
    collaboration: appSettings.composerCollaborationShortcut ?? "",
    interrupt: appSettings.interruptShortcut ?? "",
    newAgent: appSettings.newAgentShortcut ?? "",
    newWorktreeAgent: appSettings.newWorktreeAgentShortcut ?? "",
    newCloneAgent: appSettings.newCloneAgentShortcut ?? "",
    archiveThread: appSettings.archiveThreadShortcut ?? "",
    projectsSidebar: appSettings.toggleProjectsSidebarShortcut ?? "",
    gitSidebar: appSettings.toggleGitSidebarShortcut ?? "",
    debugPanel: appSettings.toggleDebugPanelShortcut ?? "",
    terminal: appSettings.toggleTerminalShortcut ?? "",
    cycleAgentNext: appSettings.cycleAgentNextShortcut ?? "",
    cycleAgentPrev: appSettings.cycleAgentPrevShortcut ?? "",
    cycleWorkspaceNext: appSettings.cycleWorkspaceNextShortcut ?? "",
    cycleWorkspacePrev: appSettings.cycleWorkspacePrevShortcut ?? "",
  });
  const dictationReady = dictationModelStatus?.state === "ready";
  const dictationProgress = dictationModelStatus?.progress ?? null;
  const voiceAssistantReady = voiceAssistantModelStatus?.state === "ready";
  const voiceAssistantProgress = voiceAssistantModelStatus?.progress ?? null;
  const globalAgentsStatus = globalAgentsLoading
    ? "Loading…"
    : globalAgentsSaving
      ? "Saving…"
      : globalAgentsExists
        ? ""
        : "Not found";
  const globalAgentsMetaParts: string[] = [];
  if (globalAgentsStatus) {
    globalAgentsMetaParts.push(globalAgentsStatus);
  }
  if (globalAgentsTruncated) {
    globalAgentsMetaParts.push("Truncated");
  }
  const globalAgentsMeta = globalAgentsMetaParts.join(" · ");
  const globalAgentsSaveLabel = globalAgentsExists ? "Save" : "Create";
  const globalAgentsSaveDisabled = globalAgentsLoading || globalAgentsSaving || !globalAgentsDirty;
  const globalAgentsRefreshDisabled = globalAgentsLoading || globalAgentsSaving;
  const globalConfigStatus = globalConfigLoading
    ? "Loading…"
    : globalConfigSaving
      ? "Saving…"
      : globalConfigExists
        ? ""
        : "Not found";
  const globalConfigMetaParts: string[] = [];
  if (globalConfigStatus) {
    globalConfigMetaParts.push(globalConfigStatus);
  }
  if (globalConfigTruncated) {
    globalConfigMetaParts.push("Truncated");
  }
  const globalConfigMeta = globalConfigMetaParts.join(" · ");
  const globalConfigSaveLabel = globalConfigExists ? "Save" : "Create";
  const globalConfigSaveDisabled = globalConfigLoading || globalConfigSaving || !globalConfigDirty;
  const globalConfigRefreshDisabled = globalConfigLoading || globalConfigSaving;
  const selectedDictationModel = useMemo(() => {
    return (
      DICTATION_MODELS.find(
        (model) => model.id === appSettings.dictationModelId,
      ) ?? DICTATION_MODELS[1]
    );
  }, [appSettings.dictationModelId]);
  const selectedVoiceAssistantModel = useMemo(() => {
    return (
      DICTATION_MODELS.find(
        (model) => model.id === appSettings.voiceAssistantModelId,
      ) ?? DICTATION_MODELS[1]
    );
  }, [appSettings.voiceAssistantModelId]);

  const projects = useMemo(
    () => groupedWorkspaces.flatMap((group) => group.workspaces),
    [groupedWorkspaces],
  );
  const hasCodexHomeOverrides = useMemo(
    () => projects.some((workspace) => workspace.settings.codexHome != null),
    [projects],
  );

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      onClose();
    };

    const handleCloseShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "w") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleEscape);
    window.addEventListener("keydown", handleCloseShortcut);
    return () => {
      window.removeEventListener("keydown", handleEscape);
      window.removeEventListener("keydown", handleCloseShortcut);
    };
  }, [onClose]);

  useEffect(() => {
    setCodexPathDraft(appSettings.codexBin ?? "");
  }, [appSettings.codexBin]);

  useEffect(() => {
    setCodexArgsDraft(appSettings.codexArgs ?? "");
  }, [appSettings.codexArgs]);

  useEffect(() => {
    setRemoteHostDraft(appSettings.remoteBackendHost);
  }, [appSettings.remoteBackendHost]);

  useEffect(() => {
    setRemoteTokenDraft(appSettings.remoteBackendToken ?? "");
  }, [appSettings.remoteBackendToken]);

  useEffect(() => {
    setScaleDraft(`${Math.round(clampUiScale(appSettings.uiScale) * 100)}%`);
  }, [appSettings.uiScale]);

  useEffect(() => {
    setUiFontDraft(appSettings.uiFontFamily);
  }, [appSettings.uiFontFamily]);

  useEffect(() => {
    setCodeFontDraft(appSettings.codeFontFamily);
  }, [appSettings.codeFontFamily]);

  useEffect(() => {
    setCodeFontSizeDraft(appSettings.codeFontSize);
  }, [appSettings.codeFontSize]);

  useEffect(() => {
    setOpenAppDrafts(buildOpenAppDrafts(appSettings.openAppTargets));
    setOpenAppSelectedId(appSettings.selectedOpenAppId);
  }, [appSettings.openAppTargets, appSettings.selectedOpenAppId]);

  useEffect(() => {
    setOtherAiDrafts(buildOtherAiDrafts(appSettings.otherAiProviders));
  }, [appSettings.otherAiProviders]);

  useEffect(() => {
    setShortcutDrafts({
      model: appSettings.composerModelShortcut ?? "",
      access: appSettings.composerAccessShortcut ?? "",
      reasoning: appSettings.composerReasoningShortcut ?? "",
      collaboration: appSettings.composerCollaborationShortcut ?? "",
      interrupt: appSettings.interruptShortcut ?? "",
      newAgent: appSettings.newAgentShortcut ?? "",
      newWorktreeAgent: appSettings.newWorktreeAgentShortcut ?? "",
      newCloneAgent: appSettings.newCloneAgentShortcut ?? "",
      archiveThread: appSettings.archiveThreadShortcut ?? "",
      projectsSidebar: appSettings.toggleProjectsSidebarShortcut ?? "",
      gitSidebar: appSettings.toggleGitSidebarShortcut ?? "",
      debugPanel: appSettings.toggleDebugPanelShortcut ?? "",
      terminal: appSettings.toggleTerminalShortcut ?? "",
      cycleAgentNext: appSettings.cycleAgentNextShortcut ?? "",
      cycleAgentPrev: appSettings.cycleAgentPrevShortcut ?? "",
      cycleWorkspaceNext: appSettings.cycleWorkspaceNextShortcut ?? "",
      cycleWorkspacePrev: appSettings.cycleWorkspacePrevShortcut ?? "",
    });
  }, [
    appSettings.composerAccessShortcut,
    appSettings.composerModelShortcut,
    appSettings.composerReasoningShortcut,
    appSettings.composerCollaborationShortcut,
    appSettings.interruptShortcut,
    appSettings.newAgentShortcut,
    appSettings.newWorktreeAgentShortcut,
    appSettings.newCloneAgentShortcut,
    appSettings.archiveThreadShortcut,
    appSettings.toggleProjectsSidebarShortcut,
    appSettings.toggleGitSidebarShortcut,
    appSettings.toggleDebugPanelShortcut,
    appSettings.toggleTerminalShortcut,
    appSettings.cycleAgentNextShortcut,
    appSettings.cycleAgentPrevShortcut,
    appSettings.cycleWorkspaceNextShortcut,
    appSettings.cycleWorkspacePrevShortcut,
  ]);

  const handleOpenConfig = useCallback(async () => {
    setOpenConfigError(null);
    try {
      const configPath = await getCodexConfigPath();
      await revealItemInDir(configPath);
    } catch (error) {
      setOpenConfigError(
        error instanceof Error ? error.message : "Unable to open config.",
      );
    }
  }, []);

  useEffect(() => {
    setCodexBinOverrideDrafts((prev) =>
      buildWorkspaceOverrideDrafts(
        projects,
        prev,
        (workspace) => workspace.codex_bin ?? null,
      ),
    );
    setCodexHomeOverrideDrafts((prev) =>
      buildWorkspaceOverrideDrafts(
        projects,
        prev,
        (workspace) => workspace.settings.codexHome ?? null,
      ),
    );
    setCodexArgsOverrideDrafts((prev) =>
      buildWorkspaceOverrideDrafts(
        projects,
        prev,
        (workspace) => workspace.settings.codexArgs ?? null,
      ),
    );
  }, [projects]);

  useEffect(() => {
    setGroupDrafts((prev) => {
      const next: Record<string, string> = {};
      workspaceGroups.forEach((group) => {
        next[group.id] = prev[group.id] ?? group.name;
      });
      return next;
    });
  }, [workspaceGroups]);

  useEffect(() => {
    if (initialSection) {
      setActiveSection(initialSection);
    }
  }, [initialSection]);

  const nextCodexBin = codexPathDraft.trim() ? codexPathDraft.trim() : null;
  const nextCodexArgs = codexArgsDraft.trim() ? codexArgsDraft.trim() : null;
  const codexDirty =
    nextCodexBin !== (appSettings.codexBin ?? null) ||
    nextCodexArgs !== (appSettings.codexArgs ?? null);

  const trimmedScale = scaleDraft.trim();
  const parsedPercent = trimmedScale
    ? Number(trimmedScale.replace("%", ""))
    : Number.NaN;
  const parsedScale = Number.isFinite(parsedPercent) ? parsedPercent / 100 : null;

  const handleSaveCodexSettings = async () => {
    setIsSavingSettings(true);
    try {
      await onUpdateAppSettings({
        ...appSettings,
        codexBin: nextCodexBin,
        codexArgs: nextCodexArgs,
      });
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleCommitRemoteHost = async () => {
    const nextHost = remoteHostDraft.trim() || "127.0.0.1:4732";
    setRemoteHostDraft(nextHost);
    if (nextHost === appSettings.remoteBackendHost) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      remoteBackendHost: nextHost,
    });
  };

  const handleCommitRemoteToken = async () => {
    const nextToken = remoteTokenDraft.trim() ? remoteTokenDraft.trim() : null;
    setRemoteTokenDraft(nextToken ?? "");
    if (nextToken === appSettings.remoteBackendToken) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      remoteBackendToken: nextToken,
    });
  };

  const handleCommitScale = async () => {
    if (parsedScale === null) {
      setScaleDraft(`${Math.round(clampUiScale(appSettings.uiScale) * 100)}%`);
      return;
    }
    const nextScale = clampUiScale(parsedScale);
    setScaleDraft(`${Math.round(nextScale * 100)}%`);
    if (nextScale === appSettings.uiScale) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      uiScale: nextScale,
    });
  };

  const handleResetScale = async () => {
    if (appSettings.uiScale === 1) {
      setScaleDraft("100%");
      return;
    }
    setScaleDraft("100%");
    await onUpdateAppSettings({
      ...appSettings,
      uiScale: 1,
    });
  };

  const commitUiFont = async (nextValue: string) => {
    const nextFont = normalizeFontFamily(
      nextValue,
      DEFAULT_UI_FONT_FAMILY,
    );
    setUiFontDraft(nextFont);
    if (nextFont === appSettings.uiFontFamily) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      uiFontFamily: nextFont,
    });
  };

  const handleCommitUiFont = async () => {
    await commitUiFont(uiFontDraft);
  };

  const commitCodeFont = async (nextValue: string) => {
    const nextFont = normalizeFontFamily(
      nextValue,
      DEFAULT_CODE_FONT_FAMILY,
    );
    setCodeFontDraft(nextFont);
    if (nextFont === appSettings.codeFontFamily) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      codeFontFamily: nextFont,
    });
  };

  const handleCommitCodeFont = async () => {
    await commitCodeFont(codeFontDraft);
  };

  const handleCommitCodeFontSize = async (nextSize: number) => {
    const clampedSize = clampCodeFontSize(nextSize);
    setCodeFontSizeDraft(clampedSize);
    if (clampedSize === appSettings.codeFontSize) {
      return;
    }
    await onUpdateAppSettings({
      ...appSettings,
      codeFontSize: clampedSize,
    });
  };

  const normalizeOpenAppTargets = useCallback(
    (drafts: OpenAppDraft[]): OpenAppTarget[] =>
      drafts.map(({ argsText, ...target }) => ({
        ...target,
        label: target.label.trim(),
        appName: (target.appName?.trim() ?? "") || null,
        command: (target.command?.trim() ?? "") || null,
        args: argsText.trim() ? argsText.trim().split(/\s+/) : [],
      })),
    [],
  );

  const handleCommitOpenApps = useCallback(
    async (drafts: OpenAppDraft[], selectedId = openAppSelectedId) => {
      const nextTargets = normalizeOpenAppTargets(drafts);
      const nextSelectedId =
        nextTargets.find((target) => target.id === selectedId)?.id ??
        nextTargets[0]?.id ??
        DEFAULT_OPEN_APP_ID;
      setOpenAppDrafts(buildOpenAppDrafts(nextTargets));
      setOpenAppSelectedId(nextSelectedId);
      await onUpdateAppSettings({
        ...appSettings,
        openAppTargets: nextTargets,
        selectedOpenAppId: nextSelectedId,
      });
    },
    [
      appSettings,
      normalizeOpenAppTargets,
      onUpdateAppSettings,
      openAppSelectedId,
    ],
  );

  const handleOpenAppDraftChange = (
    index: number,
    updates: Partial<OpenAppDraft>,
  ) => {
    setOpenAppDrafts((prev) => {
      const next = [...prev];
      const current = next[index];
      if (!current) {
        return prev;
      }
      next[index] = { ...current, ...updates };
      return next;
    });
  };

  const handleOpenAppKindChange = (index: number, kind: OpenAppTarget["kind"]) => {
    setOpenAppDrafts((prev) => {
      const next = [...prev];
      const current = next[index];
      if (!current) {
        return prev;
      }
      next[index] = {
        ...current,
        kind,
        appName: kind === "app" ? current.appName ?? "" : null,
        command: kind === "command" ? current.command ?? "" : null,
        argsText: kind === "finder" ? "" : current.argsText,
      };
      void handleCommitOpenApps(next);
      return next;
    });
  };

  const handleMoveOpenApp = (index: number, direction: "up" | "down") => {
    const nextIndex = direction === "up" ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= openAppDrafts.length) {
      return;
    }
    const next = [...openAppDrafts];
    const [moved] = next.splice(index, 1);
    next.splice(nextIndex, 0, moved);
    setOpenAppDrafts(next);
    void handleCommitOpenApps(next);
  };

  const handleDeleteOpenApp = (index: number) => {
    if (openAppDrafts.length <= 1) {
      return;
    }
    const removed = openAppDrafts[index];
    const next = openAppDrafts.filter((_, draftIndex) => draftIndex !== index);
    const nextSelected =
      removed?.id === openAppSelectedId ? next[0]?.id ?? DEFAULT_OPEN_APP_ID : openAppSelectedId;
    setOpenAppDrafts(next);
    void handleCommitOpenApps(next, nextSelected);
  };

  const handleAddOpenApp = () => {
    const newTarget: OpenAppDraft = {
      id: createOpenAppId(),
      label: "New App",
      kind: "app",
      appName: "",
      command: null,
      args: [],
      argsText: "",
    };
    const next = [...openAppDrafts, newTarget];
    setOpenAppDrafts(next);
    void handleCommitOpenApps(next, newTarget.id);
  };

  const normalizeOtherAiProvider = useCallback(
    (
      provider: AppSettings["otherAiProviders"][number],
      draft?: OtherAiDraft,
    ) => {
      const nextLabel = draft?.label ?? provider.label;
      const nextProvider = draft?.provider ?? provider.provider;
      const nextApiKey = draft?.apiKey ?? provider.apiKey ?? "";
      const nextCommand = draft?.command ?? provider.command ?? "";
      const nextArgs = draft?.args ?? provider.args ?? "";
      const nextModelsText = draft?.modelsText ?? (provider.models ?? []).join("\n");
      const nextProtocol = draft?.protocol ?? provider.protocol ?? "acp";
      const nextEnvText = draft?.envText ?? formatEnvText(provider.env);
      return {
        id: provider.id,
        label: (nextLabel ?? provider.id).trim() || provider.id,
        provider: normalizeProviderType(
          nextProvider ?? provider.provider,
          provider.provider,
        ),
        enabled: draft?.enabled ?? provider.enabled,
        apiKey: normalizeTextValue(nextApiKey) ?? null,
        command: normalizeTextValue(nextCommand) ?? null,
        args: normalizeTextValue(nextArgs) ?? null,
        models: parseModelList(nextModelsText),
        defaultModel: null,
        protocol: normalizeProtocol(nextProtocol),
        env: parseEnvText(nextEnvText),
      };
    },
    [],
  );

  const normalizedOtherAiProviders = useMemo(
    () =>
      appSettings.otherAiProviders.map((provider) =>
        normalizeOtherAiProvider(provider),
      ),
    [appSettings.otherAiProviders, normalizeOtherAiProvider],
  );

  const normalizedOtherAiDrafts = useMemo(
    () =>
      appSettings.otherAiProviders.map((provider) =>
        normalizeOtherAiProvider(provider, otherAiDrafts[provider.id]),
      ),
    [appSettings.otherAiProviders, normalizeOtherAiProvider, otherAiDrafts],
  );

  const otherAiDirty = useMemo(
    () => JSON.stringify(normalizedOtherAiDrafts) !== JSON.stringify(normalizedOtherAiProviders),
    [normalizedOtherAiDrafts, normalizedOtherAiProviders],
  );

  const handleOtherAiDraftChange = (id: string, updates: Partial<OtherAiDraft>) => {
    setOtherAiDrafts((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? buildOtherAiDrafts(appSettings.otherAiProviders)[id]), ...updates },
    }));
  };

  const handleOtherAiFetchModels = async (
    provider: AppSettings["otherAiProviders"][number],
    draft: OtherAiDraft,
  ) => {
    const providerType = normalizeProviderType(draft.provider, provider.provider);
    if (providerType === "custom") {
      return;
    }
    const apiKey = (draft.apiKey ?? provider.apiKey ?? "").trim();
    if (!apiKey) {
      pushErrorToast({
        title: "API key required",
        message: `Enter an API key for ${providerType} to fetch models.`,
      });
      return;
    }
    setOtherAiFetchState((prev) => ({
      ...prev,
      [provider.id]: { loading: true },
    }));
    try {
      const models = await listOtherAiModels(providerType, apiKey);
      const normalized = Array.from(
        new Set(
          models
            .map((model) => model.trim())
            .filter((model) => model.length > 0),
        ),
      );
      handleOtherAiDraftChange(provider.id, {
        provider: providerType,
        modelsText: normalized.join("\n"),
      });
    } catch (error) {
      pushErrorToast({
        title: "Couldn’t fetch models",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOtherAiFetchState((prev) => ({
        ...prev,
        [provider.id]: { loading: false },
      }));
    }
  };

  const handleSaveOtherAiProviders = async () => {
    if (!otherAiDirty) {
      return;
    }
    const nextProviders = appSettings.otherAiProviders.map((provider) =>
      normalizeOtherAiProvider(provider, otherAiDrafts[provider.id]),
    );
    await onUpdateAppSettings({
      ...appSettings,
      otherAiProviders: nextProviders,
    });
  };

  const handleAddOtherAiProvider = async () => {
    const id = `custom-${Date.now()}`;
    const newProvider: AppSettings["otherAiProviders"][number] = {
      id,
      label: "Custom",
      provider: "custom",
      enabled: false,
      apiKey: null,
      command: null,
      args: null,
      models: [],
      defaultModel: null,
      protocol: "acp",
      env: null,
    };
    const nextProviders = [
      ...appSettings.otherAiProviders,
      newProvider,
    ];
    setOtherAiDrafts(buildOtherAiDrafts(nextProviders));
    await onUpdateAppSettings({
      ...appSettings,
      otherAiProviders: nextProviders,
    });
  };

  const handleRemoveOtherAiProvider = async (providerId: string) => {
    const target = appSettings.otherAiProviders.find(
      (provider) => provider.id === providerId,
    );
    if (!target || target.provider !== "custom") {
      return;
    }
    const confirmed = await ask(`Remove ${target.label}?`, {
      title: "Remove provider",
      kind: "warning",
    });
    if (!confirmed) {
      return;
    }
    const nextProviders = appSettings.otherAiProviders.filter(
      (provider) => provider.id !== providerId,
    );
    setOtherAiDrafts(buildOtherAiDrafts(nextProviders));
    await onUpdateAppSettings({
      ...appSettings,
      otherAiProviders: nextProviders,
    });
  };

  const handleSelectOpenAppDefault = (id: string) => {
    setOpenAppSelectedId(id);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(OPEN_APP_STORAGE_KEY, id);
    }
    void handleCommitOpenApps(openAppDrafts, id);
  };

  const handleComposerPresetChange = (preset: ComposerPreset) => {
    const config = COMPOSER_PRESET_CONFIGS[preset];
    void onUpdateAppSettings({
      ...appSettings,
      composerEditorPreset: preset,
      ...config,
    });
  };

  const handleBrowseCodex = async () => {
    const selection = await open({ multiple: false, directory: false });
    if (!selection || Array.isArray(selection)) {
      return;
    }
    setCodexPathDraft(selection);
  };

  const handleRunDoctor = async () => {
    setDoctorState({ status: "running", result: null });
    try {
      const result = await onRunDoctor(nextCodexBin, nextCodexArgs);
      setDoctorState({ status: "done", result });
    } catch (error) {
      setDoctorState({
        status: "done",
        result: {
          ok: false,
          codexBin: nextCodexBin,
          version: null,
          appServerOk: false,
          details: error instanceof Error ? error.message : String(error),
          path: null,
          nodeOk: false,
          nodeVersion: null,
          nodeDetails: null,
        },
      });
    }
  };

  const updateShortcut = async (key: ShortcutSettingKey, value: string | null) => {
    const draftKey = shortcutDraftKeyBySetting[key];
    setShortcutDrafts((prev) => ({
      ...prev,
      [draftKey]: value ?? "",
    }));
    await onUpdateAppSettings({
      ...appSettings,
      [key]: value,
    });
  };

  const handleShortcutKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    key: ShortcutSettingKey,
  ) => {
    if (event.key === "Tab" && key !== "composerCollaborationShortcut") {
      return;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      return;
    }
    event.preventDefault();
    if (event.key === "Backspace" || event.key === "Delete") {
      void updateShortcut(key, null);
      return;
    }
    const value = buildShortcutValue(event.nativeEvent);
    if (!value) {
      return;
    }
    void updateShortcut(key, value);
  };

  const trimmedGroupName = newGroupName.trim();
  const canCreateGroup = Boolean(trimmedGroupName);

  const handleCreateGroup = async () => {
    setGroupError(null);
    try {
      const created = await onCreateWorkspaceGroup(newGroupName);
      if (created) {
        setNewGroupName("");
      }
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRenameGroup = async (group: WorkspaceGroup) => {
    const draft = groupDrafts[group.id] ?? "";
    const trimmed = draft.trim();
    if (!trimmed || trimmed === group.name) {
      setGroupDrafts((prev) => ({
        ...prev,
        [group.id]: group.name,
      }));
      return;
    }
    setGroupError(null);
    try {
      await onRenameWorkspaceGroup(group.id, trimmed);
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
      setGroupDrafts((prev) => ({
        ...prev,
        [group.id]: group.name,
      }));
    }
  };

  const updateGroupCopiesFolder = async (
    groupId: string,
    copiesFolder: string | null,
  ) => {
    setGroupError(null);
    try {
      await onUpdateAppSettings({
        ...appSettings,
        workspaceGroups: appSettings.workspaceGroups.map((entry) =>
          entry.id === groupId ? { ...entry, copiesFolder } : entry,
        ),
      });
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleChooseGroupCopiesFolder = async (group: WorkspaceGroup) => {
    const selection = await open({ multiple: false, directory: true });
    if (!selection || Array.isArray(selection)) {
      return;
    }
    await updateGroupCopiesFolder(group.id, selection);
  };

  const handleClearGroupCopiesFolder = async (group: WorkspaceGroup) => {
    if (!group.copiesFolder) {
      return;
    }
    await updateGroupCopiesFolder(group.id, null);
  };

  const handleDeleteGroup = async (group: WorkspaceGroup) => {
    const groupProjects =
      groupedWorkspaces.find((entry) => entry.id === group.id)?.workspaces ?? [];
    const detail =
      groupProjects.length > 0
        ? `\n\nProjects in this group will move to "${ungroupedLabel}".`
        : "";
    const confirmed = await ask(
      `Delete "${group.name}"?${detail}`,
      {
        title: "Delete Group",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      },
    );
    if (!confirmed) {
      return;
    }
    setGroupError(null);
    try {
      await onDeleteWorkspaceGroup(group.id);
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : String(error));
    }
  };

  const uiFontDraftTrimmed = uiFontDraft.trim();
  const codeFontDraftTrimmed = codeFontDraft.trim();
  const uiFontIsCustom =
    uiFontDraftTrimmed.length > 0 &&
    !UI_FONT_FAMILY_OPTIONS.includes(uiFontDraftTrimmed);
  const codeFontIsCustom =
    codeFontDraftTrimmed.length > 0 &&
    !CODE_FONT_FAMILY_OPTIONS.includes(codeFontDraftTrimmed);
  const uiFontSelectValue = UI_FONT_FAMILY_OPTIONS.includes(uiFontDraftTrimmed)
    ? uiFontDraftTrimmed
    : "custom";
  const codeFontSelectValue = CODE_FONT_FAMILY_OPTIONS.includes(codeFontDraftTrimmed)
    ? codeFontDraftTrimmed
    : "custom";
  const isInterFontSelected = isInterFontFamily(
    uiFontSelectValue === "custom" ? uiFontDraftTrimmed : uiFontSelectValue,
  );

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true">
      <div className="settings-backdrop" onClick={onClose} />
      <div className="settings-window">
        <div className="settings-titlebar">
          <div className="settings-title">Settings</div>
          <button
            type="button"
            className="ghost icon-button settings-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X aria-hidden />
          </button>
        </div>
        <div className="settings-body">
          <aside className="settings-sidebar">
            <button
              type="button"
              className={`settings-nav ${activeSection === "projects" ? "active" : ""}`}
              onClick={() => setActiveSection("projects")}
            >
              <LayoutGrid aria-hidden />
              Projects
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "display" ? "active" : ""}`}
              onClick={() => setActiveSection("display")}
            >
              <SlidersHorizontal aria-hidden />
              Display &amp; Sound
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "composer" ? "active" : ""}`}
              onClick={() => setActiveSection("composer")}
            >
              <FileText aria-hidden />
              Composer
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "voice-assistant" ? "active" : ""}`}
              onClick={() => setActiveSection("voice-assistant")}
            >
              <Sparkles aria-hidden />
              Voice Assistant
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "dictation" ? "active" : ""}`}
              onClick={() => setActiveSection("dictation")}
            >
              <Mic aria-hidden />
              Dictation
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "shortcuts" ? "active" : ""}`}
              onClick={() => setActiveSection("shortcuts")}
            >
              <Keyboard aria-hidden />
              Shortcuts
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "open-apps" ? "active" : ""}`}
              onClick={() => setActiveSection("open-apps")}
            >
              <ExternalLink aria-hidden />
              Open in
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "git" ? "active" : ""}`}
              onClick={() => setActiveSection("git")}
            >
              <GitBranch aria-hidden />
              Git
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "codex" ? "active" : ""}`}
              onClick={() => setActiveSection("codex")}
            >
              <TerminalSquare aria-hidden />
              Codex
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "other-ai" ? "active" : ""}`}
              onClick={() => setActiveSection("other-ai")}
            >
              <LayoutGrid aria-hidden />
              Other AI
            </button>
            <button
              type="button"
              className={`settings-nav ${activeSection === "experimental" ? "active" : ""}`}
              onClick={() => setActiveSection("experimental")}
            >
              <FlaskConical aria-hidden />
              Experimental
            </button>
          </aside>
          <div className="settings-content">
            {activeSection === "projects" && (
              <section className="settings-section">
                <div className="settings-section-title">Projects</div>
                <div className="settings-section-subtitle">
                  Group related workspaces and reorder projects within each group.
                </div>
                <div className="settings-subsection-title">Groups</div>
                <div className="settings-subsection-subtitle">
                  Create group labels for related repositories.
                </div>
                <div className="settings-groups">
                  <div className="settings-group-create">
                    <input
                      className="settings-input settings-input--compact"
                      value={newGroupName}
                      placeholder="New group name"
                      onChange={(event) => setNewGroupName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && canCreateGroup) {
                          event.preventDefault();
                          void handleCreateGroup();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => {
                        void handleCreateGroup();
                      }}
                      disabled={!canCreateGroup}
                    >
                      Add group
                    </button>
                  </div>
                  {groupError && <div className="settings-group-error">{groupError}</div>}
                  {workspaceGroups.length > 0 ? (
                    <div className="settings-group-list">
                      {workspaceGroups.map((group, index) => (
                        <div key={group.id} className="settings-group-row">
                          <div className="settings-group-fields">
                            <input
                              className="settings-input settings-input--compact"
                              value={groupDrafts[group.id] ?? group.name}
                              onChange={(event) =>
                                setGroupDrafts((prev) => ({
                                  ...prev,
                                  [group.id]: event.target.value,
                                }))
                              }
                              onBlur={() => {
                                void handleRenameGroup(group);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void handleRenameGroup(group);
                                }
                              }}
                            />
                            <div className="settings-group-copies">
                              <div className="settings-group-copies-label">
                                Copies folder
                              </div>
                              <div className="settings-group-copies-row">
                                <div
                                  className={`settings-group-copies-path${
                                    group.copiesFolder ? "" : " empty"
                                  }`}
                                  title={group.copiesFolder ?? ""}
                                >
                                  {group.copiesFolder ?? "Not set"}
                                </div>
                                <button
                                  type="button"
                                  className="ghost settings-button-compact"
                                  onClick={() => {
                                    void handleChooseGroupCopiesFolder(group);
                                  }}
                                >
                                  Choose…
                                </button>
                                <button
                                  type="button"
                                  className="ghost settings-button-compact"
                                  onClick={() => {
                                    void handleClearGroupCopiesFolder(group);
                                  }}
                                  disabled={!group.copiesFolder}
                                >
                                  Clear
                                </button>
                              </div>
                            </div>
                          </div>
                          <div className="settings-group-actions">
                            <button
                              type="button"
                              className="ghost icon-button"
                              onClick={() => {
                                void onMoveWorkspaceGroup(group.id, "up");
                              }}
                              disabled={index === 0}
                              aria-label="Move group up"
                            >
                              <ChevronUp aria-hidden />
                            </button>
                            <button
                              type="button"
                              className="ghost icon-button"
                              onClick={() => {
                                void onMoveWorkspaceGroup(group.id, "down");
                              }}
                              disabled={index === workspaceGroups.length - 1}
                              aria-label="Move group down"
                            >
                              <ChevronDown aria-hidden />
                            </button>
                            <button
                              type="button"
                              className="ghost icon-button"
                              onClick={() => {
                                void handleDeleteGroup(group);
                              }}
                              aria-label="Delete group"
                            >
                              <Trash2 aria-hidden />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="settings-empty">No groups yet.</div>
                  )}
                </div>
                <div className="settings-subsection-title">Projects</div>
                <div className="settings-subsection-subtitle">
                  Assign projects to groups and adjust their order.
                </div>
                <div className="settings-projects">
                  {groupedWorkspaces.map((group) => (
                    <div key={group.id ?? "ungrouped"} className="settings-project-group">
                      <div className="settings-project-group-label">{group.name}</div>
                      {group.workspaces.map((workspace, index) => {
                        const groupValue =
                          workspaceGroups.some(
                            (entry) => entry.id === workspace.settings.groupId,
                          )
                            ? workspace.settings.groupId ?? ""
                            : "";
                        return (
                          <div key={workspace.id} className="settings-project-row">
                            <div className="settings-project-info">
                              <div className="settings-project-name">{workspace.name}</div>
                              <div className="settings-project-path">{workspace.path}</div>
                            </div>
                            <div className="settings-project-actions">
                              <select
                                className="settings-select settings-select--compact"
                                value={groupValue}
                                onChange={(event) => {
                                  const nextGroupId = event.target.value || null;
                                  void onAssignWorkspaceGroup(
                                    workspace.id,
                                    nextGroupId,
                                  );
                                }}
                              >
                                <option value="">{ungroupedLabel}</option>
                                {workspaceGroups.map((entry) => (
                                  <option key={entry.id} value={entry.id}>
                                    {entry.name}
                                  </option>
                                ))}
                              </select>
                              <button
                                type="button"
                                className="ghost icon-button"
                                onClick={() => onMoveWorkspace(workspace.id, "up")}
                                disabled={index === 0}
                                aria-label="Move project up"
                              >
                                <ChevronUp aria-hidden />
                              </button>
                              <button
                                type="button"
                                className="ghost icon-button"
                                onClick={() => onMoveWorkspace(workspace.id, "down")}
                                disabled={index === group.workspaces.length - 1}
                                aria-label="Move project down"
                              >
                                <ChevronDown aria-hidden />
                              </button>
                              <button
                                type="button"
                                className="ghost icon-button"
                                onClick={() => onDeleteWorkspace(workspace.id)}
                                aria-label="Delete project"
                              >
                                <Trash2 aria-hidden />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {projects.length === 0 && (
                    <div className="settings-empty">No projects yet.</div>
                  )}
                </div>
              </section>
            )}
            {activeSection === "display" && (
              <section className="settings-section">
                <div className="settings-section-title">Display &amp; Sound</div>
                <div className="settings-section-subtitle">
                  Tune visuals and audio alerts to your preferences.
                </div>
                <div className="settings-subsection-title">Display</div>
                <div className="settings-subsection-subtitle">
                  Adjust how the window renders backgrounds and effects.
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="theme-select">
                    Theme
                  </label>
                  <select
                    id="theme-select"
                    className="settings-select"
                    value={appSettings.theme}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        theme: event.target.value as AppSettings["theme"],
                      })
                    }
                  >
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                    <option value="dim">Dim</option>
                  </select>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">
                      Show remaining Codex limits
                    </div>
                    <div className="settings-toggle-subtitle">
                      Display what is left instead of what is used.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${
                      appSettings.usageShowRemaining ? "on" : ""
                    }`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        usageShowRemaining: !appSettings.usageShowRemaining,
                      })
                    }
                    aria-pressed={appSettings.usageShowRemaining}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Reduce transparency</div>
                    <div className="settings-toggle-subtitle">
                      Use solid surfaces instead of glass.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${reduceTransparency ? "on" : ""}`}
                    onClick={() => onToggleTransparency(!reduceTransparency)}
                    aria-pressed={reduceTransparency}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row settings-scale-row">
                  <div>
                    <div className="settings-toggle-title">Interface scale</div>
                    <div
                      className="settings-toggle-subtitle"
                      title={scaleShortcutTitle}
                    >
                      {scaleShortcutText}
                    </div>
                  </div>
                  <div className="settings-scale-controls">
                    <input
                      id="ui-scale"
                      type="text"
                      inputMode="decimal"
                      className="settings-input settings-input--scale"
                      value={scaleDraft}
                      aria-label="Interface scale"
                      onChange={(event) => setScaleDraft(event.target.value)}
                      onBlur={() => {
                        void handleCommitScale();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleCommitScale();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="ghost settings-scale-reset"
                      onClick={() => {
                        void handleResetScale();
                      }}
                    >
                      Reset
                    </button>
                  </div>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="ui-font-family">
                    UI font family
                  </label>
                  <div className="settings-field-row">
                    <select
                      id="ui-font-family"
                      className="settings-select"
                      value={uiFontSelectValue}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        if (nextValue === "custom") {
                          if (!uiFontIsCustom) {
                            setUiFontDraft("");
                          }
                          return;
                        }
                        void commitUiFont(nextValue);
                      }}
                    >
                      {UI_FONT_FAMILY_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                      <option value="custom">Custom…</option>
                    </select>
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => {
                        setUiFontDraft(DEFAULT_UI_FONT_FAMILY);
                        void onUpdateAppSettings({
                          ...appSettings,
                          uiFontFamily: DEFAULT_UI_FONT_FAMILY,
                        });
                      }}
                    >
                      Reset
                    </button>
                  </div>
                  {uiFontSelectValue === "custom" ? (
                    <input
                      aria-label="Custom UI font family"
                      type="text"
                      className="settings-input"
                      value={uiFontDraft}
                      placeholder="Custom UI font family"
                      onChange={(event) => setUiFontDraft(event.target.value)}
                      onBlur={() => {
                        void handleCommitUiFont();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleCommitUiFont();
                        }
                      }}
                    />
                  ) : null}
                  <div className="settings-help">
                    Applies to all UI text. Leave empty to use the default system font stack.
                  </div>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="code-font-family">
                    Code font family
                  </label>
                  <div className="settings-field-row">
                    <select
                      id="code-font-family"
                      className="settings-select"
                      value={codeFontSelectValue}
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        if (nextValue === "custom") {
                          if (!codeFontIsCustom) {
                            setCodeFontDraft("");
                          }
                          return;
                        }
                        void commitCodeFont(nextValue);
                      }}
                    >
                      {CODE_FONT_FAMILY_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                      <option value="custom">Custom…</option>
                    </select>
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => {
                        setCodeFontDraft(DEFAULT_CODE_FONT_FAMILY);
                        void onUpdateAppSettings({
                          ...appSettings,
                          codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
                        });
                      }}
                    >
                      Reset
                    </button>
                  </div>
                  {codeFontSelectValue === "custom" ? (
                    <input
                      aria-label="Custom code font family"
                      type="text"
                      className="settings-input"
                      value={codeFontDraft}
                      placeholder="Custom code font family"
                      onChange={(event) => setCodeFontDraft(event.target.value)}
                      onBlur={() => {
                        void handleCommitCodeFont();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleCommitCodeFont();
                        }
                      }}
                    />
                  ) : null}
                  <div className="settings-help">
                    Applies to git diffs and other mono-spaced readouts.
                  </div>
                </div>
                {isInterFontSelected ? (
                  <div className="settings-field">
                    <div className="settings-field-label">Inter font features</div>
                    <div className="settings-help">
                      Applies only when Inter is selected for UI text.
                    </div>
                    {INTER_FONT_FEATURES.map((feature) => {
                      const isEnabled =
                        appSettings.interFontFeatures?.[feature.tag] ?? feature.enabledByDefault;
                      return (
                        <div key={feature.tag} className="settings-toggle-row">
                          <div>
                            <div className="settings-toggle-title">
                              {feature.tag} {feature.label}
                            </div>
                          </div>
                          <button
                            type="button"
                            className={`settings-toggle ${isEnabled ? "on" : ""}`}
                            onClick={() => {
                              void onUpdateAppSettings({
                                ...appSettings,
                                interFontFeatures: {
                                  ...appSettings.interFontFeatures,
                                  [feature.tag]: !isEnabled,
                                },
                              });
                            }}
                          >
                            <span className="settings-toggle-knob" />
                          </button>
                        </div>
                      );
                    })}
                    <div className="settings-field-row">
                      <button
                        type="button"
                        className="ghost settings-button-compact"
                        onClick={() => {
                          void onUpdateAppSettings({
                            ...appSettings,
                            interFontFeatures: INTER_FONT_FEATURES.reduce(
                              (acc, feature) => {
                                acc[feature.tag] = feature.enabledByDefault;
                                return acc;
                              },
                              {} as Record<string, boolean>,
                            ),
                          });
                        }}
                      >
                        Reset features
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="code-font-size">
                    Code font size
                  </label>
                  <div className="settings-field-row">
                    <input
                      id="code-font-size"
                      type="range"
                      min={CODE_FONT_SIZE_MIN}
                      max={CODE_FONT_SIZE_MAX}
                      step={1}
                      className="settings-input settings-input--range"
                      value={codeFontSizeDraft}
                      onChange={(event) => {
                        const nextValue = Number(event.target.value);
                        setCodeFontSizeDraft(nextValue);
                        void handleCommitCodeFontSize(nextValue);
                      }}
                    />
                    <div className="settings-scale-value">{codeFontSizeDraft}px</div>
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() => {
                        setCodeFontSizeDraft(CODE_FONT_SIZE_DEFAULT);
                        void handleCommitCodeFontSize(CODE_FONT_SIZE_DEFAULT);
                      }}
                    >
                      Reset
                    </button>
                  </div>
                  <div className="settings-help">
                    Adjusts code and diff text size.
                  </div>
                </div>
                <div className="settings-subsection-title">Sounds</div>
                <div className="settings-subsection-subtitle">
                  Control notification audio alerts.
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Notification sounds</div>
                    <div className="settings-toggle-subtitle">
                      Play a sound when a long-running agent finishes while the window is unfocused.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.notificationSoundsEnabled ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        notificationSoundsEnabled: !appSettings.notificationSoundsEnabled,
                      })
                    }
                    aria-pressed={appSettings.notificationSoundsEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-sound-actions">
                  <button
                    type="button"
                    className="ghost settings-button-compact"
                    onClick={onTestNotificationSound}
                  >
                    Test sound
                  </button>
                </div>
              </section>
            )}
            {activeSection === "composer" && (
              <section className="settings-section">
                <div className="settings-section-title">Composer</div>
                <div className="settings-section-subtitle">
                  Control helpers and formatting behavior inside the message editor.
                </div>
                <div className="settings-subsection-title">Presets</div>
                <div className="settings-subsection-subtitle">
                  Choose a starting point and fine-tune the toggles below.
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="composer-preset">
                    Preset
                  </label>
                  <select
                    id="composer-preset"
                    className="settings-select"
                    value={appSettings.composerEditorPreset}
                    onChange={(event) =>
                      handleComposerPresetChange(
                        event.target.value as ComposerPreset,
                      )
                    }
                  >
                    {Object.entries(COMPOSER_PRESET_LABELS).map(([preset, label]) => (
                      <option key={preset} value={preset}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <div className="settings-help">
                    Presets update the toggles below. Customize any setting after selecting.
                  </div>
                </div>
                <div className="settings-divider" />
                <div className="settings-subsection-title">Code fences</div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Expand fences on Space</div>
                    <div className="settings-toggle-subtitle">
                      Typing ``` then Space inserts a fenced block.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerFenceExpandOnSpace ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerFenceExpandOnSpace: !appSettings.composerFenceExpandOnSpace,
                      })
                    }
                    aria-pressed={appSettings.composerFenceExpandOnSpace}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Expand fences on Enter</div>
                    <div className="settings-toggle-subtitle">
                      Use Enter to expand ``` lines when enabled.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerFenceExpandOnEnter ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerFenceExpandOnEnter: !appSettings.composerFenceExpandOnEnter,
                      })
                    }
                    aria-pressed={appSettings.composerFenceExpandOnEnter}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Support language tags</div>
                    <div className="settings-toggle-subtitle">
                      Allows ```lang + Space to include a language.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerFenceLanguageTags ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerFenceLanguageTags: !appSettings.composerFenceLanguageTags,
                      })
                    }
                    aria-pressed={appSettings.composerFenceLanguageTags}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Wrap selection in fences</div>
                    <div className="settings-toggle-subtitle">
                      Wraps selected text when creating a fence.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerFenceWrapSelection ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerFenceWrapSelection: !appSettings.composerFenceWrapSelection,
                      })
                    }
                    aria-pressed={appSettings.composerFenceWrapSelection}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Copy blocks without fences</div>
                    <div className="settings-toggle-subtitle">
                      When enabled, Copy is plain text. Hold Option to include ``` fences.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerCodeBlockCopyUseModifier ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerCodeBlockCopyUseModifier:
                          !appSettings.composerCodeBlockCopyUseModifier,
                      })
                    }
                    aria-pressed={appSettings.composerCodeBlockCopyUseModifier}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-divider" />
                <div className="settings-subsection-title">Pasting</div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Auto-wrap multi-line paste</div>
                    <div className="settings-toggle-subtitle">
                      Wraps multi-line paste inside a fenced block.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerFenceAutoWrapPasteMultiline ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerFenceAutoWrapPasteMultiline:
                          !appSettings.composerFenceAutoWrapPasteMultiline,
                      })
                    }
                    aria-pressed={appSettings.composerFenceAutoWrapPasteMultiline}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Auto-wrap code-like single lines</div>
                    <div className="settings-toggle-subtitle">
                      Wraps long single-line code snippets on paste.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerFenceAutoWrapPasteCodeLike ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerFenceAutoWrapPasteCodeLike:
                          !appSettings.composerFenceAutoWrapPasteCodeLike,
                      })
                    }
                    aria-pressed={appSettings.composerFenceAutoWrapPasteCodeLike}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-divider" />
                <div className="settings-subsection-title">Lists</div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Continue lists on Shift+Enter</div>
                    <div className="settings-toggle-subtitle">
                      Continues numbered and bulleted lists when the line has content.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.composerListContinuation ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        composerListContinuation: !appSettings.composerListContinuation,
                      })
                    }
                    aria-pressed={appSettings.composerListContinuation}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
              </section>
            )}
            {activeSection === "voice-assistant" && (
              <section className="settings-section">
                <div className="settings-section-title">Voice Assistant</div>
                <div className="settings-section-subtitle">
                  Friday listens only when you click the microphone in the top bar.
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="voice-assistant-model">
                    Voice assistant model
                  </label>
                  <select
                    id="voice-assistant-model"
                    className="settings-select"
                    value={appSettings.voiceAssistantModelId}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        voiceAssistantModelId: event.target.value,
                      })
                    }
                  >
                    {DICTATION_MODELS.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label} ({model.size})
                      </option>
                    ))}
                  </select>
                  <div className="settings-help">
                    {selectedVoiceAssistantModel.note} Download size:{" "}
                    {selectedVoiceAssistantModel.size}.
                  </div>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="voice-assistant-language">
                    Preferred listening language
                  </label>
                  <select
                    id="voice-assistant-language"
                    className="settings-select"
                    value={appSettings.voiceAssistantPreferredLanguage ?? ""}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        voiceAssistantPreferredLanguage: event.target.value || null,
                      })
                    }
                  >
                    <option value="">Auto-detect only</option>
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="it">Italian</option>
                    <option value="pt">Portuguese</option>
                    <option value="nl">Dutch</option>
                    <option value="sv">Swedish</option>
                    <option value="no">Norwegian</option>
                    <option value="da">Danish</option>
                    <option value="fi">Finnish</option>
                    <option value="pl">Polish</option>
                    <option value="tr">Turkish</option>
                    <option value="ru">Russian</option>
                    <option value="uk">Ukrainian</option>
                    <option value="ja">Japanese</option>
                    <option value="ko">Korean</option>
                    <option value="zh">Chinese</option>
                  </select>
                  <div className="settings-help">
                    Select a language to force transcription, or leave empty for auto-detect.
                  </div>
                </div>
                <div className="settings-subsection-title">Speech</div>
                <div className="settings-subsection-subtitle">
                  Speak assistant responses aloud.
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Enable voice replies</div>
                    <div className="settings-toggle-subtitle">
                      Uses macOS system voices via the built-in speech engine.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.ttsEnabled ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        ttsEnabled: !appSettings.ttsEnabled,
                      })
                    }
                    aria-pressed={appSettings.ttsEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="tts-voice">
                    Voice (optional)
                  </label>
                  <div className="settings-field-row">
                    <input
                      id="tts-voice"
                      className="settings-input"
                      value={appSettings.ttsVoice ?? ""}
                      onChange={(event) =>
                        void onUpdateAppSettings({
                          ...appSettings,
                          ttsVoice: event.target.value || null,
                        })
                      }
                      placeholder="Samantha"
                    />
                    <button
                      type="button"
                      className="ghost settings-button-compact"
                      onClick={() =>
                        void speakText(
                          "Friday online. Voice check complete.",
                          appSettings.ttsVoice,
                        ).catch(() => {
                          pushErrorToast({
                            title: "Voice preview failed",
                            message: "Unable to play the preview voice.",
                          });
                        })
                      }
                    >
                      Preview
                    </button>
                  </div>
                  <div className="settings-help">
                    Leave empty to use the system default voice.
                  </div>
                </div>
                {voiceAssistantModelStatus && (
                  <div className="settings-field">
                    <div className="settings-field-label">
                      Model status ({selectedVoiceAssistantModel.label})
                    </div>
                    <div className="settings-help">
                      {voiceAssistantModelStatus.state === "ready" &&
                        "Ready for the voice assistant."}
                      {voiceAssistantModelStatus.state === "missing" &&
                        "Model not downloaded yet."}
                      {voiceAssistantModelStatus.state === "downloading" &&
                        "Downloading model..."}
                      {voiceAssistantModelStatus.state === "error" &&
                        (voiceAssistantModelStatus.error ?? "Download error.")}
                    </div>
                    {voiceAssistantProgress && (
                      <div className="settings-download-progress">
                        <div className="settings-download-bar">
                          <div
                            className="settings-download-fill"
                            style={{
                              width: voiceAssistantProgress.totalBytes
                                ? `${Math.min(
                                    100,
                                    (voiceAssistantProgress.downloadedBytes /
                                      voiceAssistantProgress.totalBytes) *
                                      100,
                                  )}%`
                                : "0%",
                            }}
                          />
                        </div>
                        <div className="settings-download-meta">
                          {formatDownloadSize(voiceAssistantProgress.downloadedBytes)}
                        </div>
                      </div>
                    )}
                    <div className="settings-field-actions">
                      {voiceAssistantModelStatus.state === "missing" && (
                        <button
                          type="button"
                          className="primary"
                          onClick={onDownloadVoiceAssistantModel}
                          disabled={!onDownloadVoiceAssistantModel}
                        >
                          Download model
                        </button>
                      )}
                      {voiceAssistantModelStatus.state === "downloading" && (
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={onCancelVoiceAssistantDownload}
                          disabled={!onCancelVoiceAssistantDownload}
                        >
                          Cancel download
                        </button>
                      )}
                      {voiceAssistantReady && (
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={onRemoveVoiceAssistantModel}
                          disabled={!onRemoveVoiceAssistantModel}
                        >
                          Remove model
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}
            {activeSection === "dictation" && (
              <section className="settings-section">
                <div className="settings-section-title">Dictation</div>
                <div className="settings-section-subtitle">
                  Turn speech into text for the composer and notes.
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Enable dictation</div>
                    <div className="settings-toggle-subtitle">
                      Downloads the selected Whisper model on first use.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.dictationEnabled ? "on" : ""}`}
                    onClick={() => {
                      const nextEnabled = !appSettings.dictationEnabled;
                      void onUpdateAppSettings({
                        ...appSettings,
                        dictationEnabled: nextEnabled,
                      });
                      if (
                        !nextEnabled &&
                        dictationModelStatus?.state === "downloading" &&
                        onCancelDictationDownload
                      ) {
                        onCancelDictationDownload();
                      }
                      if (
                        nextEnabled &&
                        dictationModelStatus?.state === "missing" &&
                        onDownloadDictationModel
                      ) {
                        onDownloadDictationModel();
                      }
                    }}
                    aria-pressed={appSettings.dictationEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="dictation-model">
                    Dictation model
                  </label>
                  <select
                    id="dictation-model"
                    className="settings-select"
                    value={appSettings.dictationModelId}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        dictationModelId: event.target.value,
                      })
                    }
                  >
                    {DICTATION_MODELS.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label} ({model.size})
                      </option>
                    ))}
                  </select>
                  <div className="settings-help">
                    {selectedDictationModel.note} Download size: {selectedDictationModel.size}.
                  </div>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="dictation-language">
                    Preferred dictation language
                  </label>
                  <select
                    id="dictation-language"
                    className="settings-select"
                    value={appSettings.dictationPreferredLanguage ?? ""}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        dictationPreferredLanguage: event.target.value || null,
                      })
                    }
                  >
                    <option value="">Auto-detect only</option>
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="it">Italian</option>
                    <option value="pt">Portuguese</option>
                    <option value="nl">Dutch</option>
                    <option value="sv">Swedish</option>
                    <option value="no">Norwegian</option>
                    <option value="da">Danish</option>
                    <option value="fi">Finnish</option>
                    <option value="pl">Polish</option>
                    <option value="tr">Turkish</option>
                    <option value="ru">Russian</option>
                    <option value="uk">Ukrainian</option>
                    <option value="ja">Japanese</option>
                    <option value="ko">Korean</option>
                    <option value="zh">Chinese</option>
                  </select>
                  <div className="settings-help">
                    Select a language to force transcription, or leave empty for auto-detect.
                  </div>
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="dictation-hold-key">
                    Hold-to-dictate key
                  </label>
                  <select
                    id="dictation-hold-key"
                    className="settings-select"
                    value={appSettings.dictationHoldKey ?? ""}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        dictationHoldKey: event.target.value,
                      })
                    }
                  >
                    <option value="">Off</option>
                    <option value="alt">Option / Alt</option>
                    <option value="shift">Shift</option>
                    <option value="control">Control</option>
                    <option value="meta">Command / Meta</option>
                  </select>
                  <div className="settings-help">
                    Hold the key to start dictation, release to stop and process.
                  </div>
                </div>
                {dictationModelStatus && (
                  <div className="settings-field">
                    <div className="settings-field-label">
                      Model status ({selectedDictationModel.label})
                    </div>
                    <div className="settings-help">
                      {dictationModelStatus.state === "ready" && "Ready for dictation."}
                      {dictationModelStatus.state === "missing" && "Model not downloaded yet."}
                      {dictationModelStatus.state === "downloading" &&
                        "Downloading model..."}
                      {dictationModelStatus.state === "error" &&
                        (dictationModelStatus.error ?? "Download error.")}
                    </div>
                    {dictationProgress && (
                      <div className="settings-download-progress">
                        <div className="settings-download-bar">
                          <div
                            className="settings-download-fill"
                            style={{
                              width: dictationProgress.totalBytes
                                ? `${Math.min(
                                    100,
                                    (dictationProgress.downloadedBytes /
                                      dictationProgress.totalBytes) *
                                      100,
                                  )}%`
                                : "0%",
                            }}
                          />
                        </div>
                        <div className="settings-download-meta">
                          {formatDownloadSize(dictationProgress.downloadedBytes)}
                        </div>
                      </div>
                    )}
                    <div className="settings-field-actions">
                      {dictationModelStatus.state === "missing" && (
                        <button
                          type="button"
                          className="primary"
                          onClick={onDownloadDictationModel}
                          disabled={!onDownloadDictationModel}
                        >
                          Download model
                        </button>
                      )}
                      {dictationModelStatus.state === "downloading" && (
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={onCancelDictationDownload}
                          disabled={!onCancelDictationDownload}
                        >
                          Cancel download
                        </button>
                      )}
                      {dictationReady && (
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={onRemoveDictationModel}
                          disabled={!onRemoveDictationModel}
                        >
                          Remove model
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}
            {activeSection === "shortcuts" && (
              <section className="settings-section">
                <div className="settings-section-title">Shortcuts</div>
                <div className="settings-section-subtitle">
                  Customize keyboard shortcuts for file actions, composer, panels, and navigation.
                </div>
                <div className="settings-shortcuts-tabs" role="tablist" aria-label="Shortcut tabs">
                  <button
                    type="button"
                    className={`settings-shortcuts-tab${
                      activeShortcutsTab === "chat" ? " active" : ""
                    }`}
                    role="tab"
                    aria-selected={activeShortcutsTab === "chat"}
                    onClick={() => setActiveShortcutsTab("chat")}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    className={`settings-shortcuts-tab${
                      activeShortcutsTab === "editor" ? " active" : ""
                    }`}
                    role="tab"
                    aria-selected={activeShortcutsTab === "editor"}
                    onClick={() => setActiveShortcutsTab("editor")}
                  >
                    Editor
                  </button>
                </div>
                {activeShortcutsTab === "chat" ? (
                  <>
                    <div className="settings-subsection-title">File</div>
                    <div className="settings-subsection-subtitle">
                      Create agents and worktrees from the keyboard.
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">New Agent</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.newAgent)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "newAgentShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("newAgentShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+n")}
                      </div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">New Worktree Agent</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.newWorktreeAgent)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "newWorktreeAgentShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("newWorktreeAgentShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+shift+n")}
                      </div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">New Clone Agent</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.newCloneAgent)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "newCloneAgentShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("newCloneAgentShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+alt+n")}
                      </div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Archive active thread</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.archiveThread)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "archiveThreadShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("archiveThreadShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+ctrl+a")}
                      </div>
                    </div>
                    <div className="settings-divider" />
                    <div className="settings-subsection-title">Composer</div>
                    <div className="settings-subsection-subtitle">
                      Cycle between model, access, reasoning, and collaboration modes.
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Cycle model</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.model)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "composerModelShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("composerModelShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Press a new shortcut while focused. Default:{" "}
                        {formatShortcut("cmd+shift+m")}
                      </div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Cycle access mode</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.access)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "composerAccessShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("composerAccessShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+shift+a")}
                      </div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Cycle reasoning mode</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.reasoning)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "composerReasoningShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("composerReasoningShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+shift+r")}
                      </div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Cycle collaboration mode</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.collaboration)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "composerCollaborationShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("composerCollaborationShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("shift+tab")}
                      </div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Stop active run</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.interrupt)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "interruptShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("interruptShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut(getDefaultInterruptShortcut())}
                      </div>
                    </div>
                    <div className="settings-divider" />
                    <div className="settings-subsection-title">Panels</div>
                    <div className="settings-subsection-subtitle">
                      Toggle sidebars and panels.
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Toggle projects sidebar</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.projectsSidebar)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "toggleProjectsSidebarShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("toggleProjectsSidebarShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+shift+p")}
                      </div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Toggle git sidebar</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.gitSidebar)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "toggleGitSidebarShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("toggleGitSidebarShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+shift+g")}
                      </div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Toggle debug panel</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.debugPanel)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "toggleDebugPanelShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("toggleDebugPanelShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+shift+d")}
                      </div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Toggle terminal panel</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.terminal)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "toggleTerminalShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("toggleTerminalShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+shift+t")}
                      </div>
                    </div>
                    <div className="settings-divider" />
                    <div className="settings-subsection-title">Navigation</div>
                    <div className="settings-subsection-subtitle">
                      Cycle between agents and workspaces.
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Next agent</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.cycleAgentNext)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "cycleAgentNextShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("cycleAgentNextShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+ctrl+down")}
                      </div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Previous agent</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.cycleAgentPrev)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "cycleAgentPrevShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("cycleAgentPrevShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+ctrl+up")}
                      </div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Next workspace</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.cycleWorkspaceNext)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "cycleWorkspaceNextShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("cycleWorkspaceNextShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+shift+down")}
                      </div>
                    </div>
                    <div className="settings-field">
                      <div className="settings-field-label">Previous workspace</div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input settings-input--shortcut"
                          value={formatShortcut(shortcutDrafts.cycleWorkspacePrev)}
                          onKeyDown={(event) =>
                            handleShortcutKeyDown(event, "cycleWorkspacePrevShortcut")
                          }
                          placeholder="Type shortcut"
                          readOnly
                        />
                        <button
                          type="button"
                          className="ghost settings-button-compact"
                          onClick={() => void updateShortcut("cycleWorkspacePrevShortcut", null)}
                        >
                          Clear
                        </button>
                      </div>
                      <div className="settings-help">
                        Default: {formatShortcut("cmd+shift+up")}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="settings-subsection-title">Editor</div>
                    <div className="settings-subsection-subtitle">
                      Choose the keymap used inside the code editor.
                    </div>
                    <div className="settings-field">
                      <label className="settings-field-label" htmlFor="editor-keymap">
                        Keymap
                      </label>
                      <select
                        id="editor-keymap"
                        className="settings-select"
                        value={appSettings.editorKeymap}
                        onChange={(event) =>
                          void onUpdateAppSettings({
                            ...appSettings,
                            editorKeymap: event.target.value as AppSettings["editorKeymap"],
                          })
                        }
                      >
                        {EDITOR_KEYMAP_OPTIONS.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <div className="settings-help">Default: JetBrains</div>
                    </div>
                  </>
                )}
              </section>
            )}
            {activeSection === "open-apps" && (
              <section className="settings-section">
                <div className="settings-section-title">Open in</div>
                <div className="settings-section-subtitle">
                  Customize the Open in menu shown in the title bar and file previews.
                </div>
                <div className="settings-open-apps">
                  {openAppDrafts.map((target, index) => {
                    const iconSrc =
                      getKnownOpenAppIcon(target.id) ??
                      openAppIconById[target.id] ??
                      GENERIC_APP_ICON;
                    return (
                      <div key={target.id} className="settings-open-app-row">
                        <div className="settings-open-app-icon-wrap" aria-hidden>
                          <img
                            className="settings-open-app-icon"
                            src={iconSrc}
                            alt=""
                            width={18}
                            height={18}
                          />
                        </div>
                        <div className="settings-open-app-fields">
                          <label className="settings-open-app-field settings-open-app-field--label">
                            <span className="settings-visually-hidden">Label</span>
                            <input
                              className="settings-input settings-input--compact settings-open-app-input settings-open-app-input--label"
                              value={target.label}
                              placeholder="Label"
                              onChange={(event) =>
                                handleOpenAppDraftChange(index, {
                                  label: event.target.value,
                                })
                              }
                              onBlur={() => {
                                void handleCommitOpenApps(openAppDrafts);
                              }}
                              aria-label={`Open app label ${index + 1}`}
                            />
                          </label>
                          <label className="settings-open-app-field settings-open-app-field--type">
                            <span className="settings-visually-hidden">Type</span>
                            <select
                              className="settings-select settings-select--compact settings-open-app-kind"
                              value={target.kind}
                              onChange={(event) =>
                                handleOpenAppKindChange(
                                  index,
                                  event.target.value as OpenAppTarget["kind"],
                                )
                              }
                              aria-label={`Open app type ${index + 1}`}
                            >
                              <option value="app">App</option>
                              <option value="command">Command</option>
                              <option value="finder">Finder</option>
                            </select>
                          </label>
                          {target.kind === "app" && (
                            <label className="settings-open-app-field settings-open-app-field--appname">
                              <span className="settings-visually-hidden">App name</span>
                              <input
                                className="settings-input settings-input--compact settings-open-app-input settings-open-app-input--appname"
                                value={target.appName ?? ""}
                                placeholder="App name"
                                onChange={(event) =>
                                  handleOpenAppDraftChange(index, {
                                    appName: event.target.value,
                                  })
                                }
                                onBlur={() => {
                                  void handleCommitOpenApps(openAppDrafts);
                                }}
                                aria-label={`Open app name ${index + 1}`}
                              />
                            </label>
                          )}
                          {target.kind === "command" && (
                            <label className="settings-open-app-field settings-open-app-field--command">
                              <span className="settings-visually-hidden">Command</span>
                              <input
                                className="settings-input settings-input--compact settings-open-app-input settings-open-app-input--command"
                                value={target.command ?? ""}
                                placeholder="Command"
                                onChange={(event) =>
                                  handleOpenAppDraftChange(index, {
                                    command: event.target.value,
                                  })
                                }
                                onBlur={() => {
                                  void handleCommitOpenApps(openAppDrafts);
                                }}
                                aria-label={`Open app command ${index + 1}`}
                              />
                            </label>
                          )}
                          {target.kind !== "finder" && (
                            <label className="settings-open-app-field settings-open-app-field--args">
                              <span className="settings-visually-hidden">Args</span>
                              <input
                                className="settings-input settings-input--compact settings-open-app-input settings-open-app-input--args"
                                value={target.argsText}
                                placeholder="Args"
                                onChange={(event) =>
                                  handleOpenAppDraftChange(index, {
                                    argsText: event.target.value,
                                  })
                                }
                                onBlur={() => {
                                  void handleCommitOpenApps(openAppDrafts);
                                }}
                                aria-label={`Open app args ${index + 1}`}
                              />
                            </label>
                          )}
                        </div>
                        <div className="settings-open-app-actions">
                          <label className="settings-open-app-default">
                            <input
                              type="radio"
                              name="open-app-default"
                              checked={target.id === openAppSelectedId}
                              onChange={() => handleSelectOpenAppDefault(target.id)}
                            />
                            Default
                          </label>
                          <div className="settings-open-app-order">
                            <button
                              type="button"
                              className="ghost icon-button"
                              onClick={() => handleMoveOpenApp(index, "up")}
                              disabled={index === 0}
                              aria-label="Move up"
                            >
                              <ChevronUp aria-hidden />
                            </button>
                            <button
                              type="button"
                              className="ghost icon-button"
                              onClick={() => handleMoveOpenApp(index, "down")}
                              disabled={index === openAppDrafts.length - 1}
                              aria-label="Move down"
                            >
                              <ChevronDown aria-hidden />
                            </button>
                          </div>
                          <button
                            type="button"
                            className="ghost icon-button"
                            onClick={() => handleDeleteOpenApp(index)}
                            disabled={openAppDrafts.length <= 1}
                            aria-label="Remove app"
                            title="Remove app"
                          >
                            <Trash2 aria-hidden />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="settings-open-app-footer">
                  <button
                    type="button"
                    className="ghost"
                    onClick={handleAddOpenApp}
                  >
                    Add app
                  </button>
                  <div className="settings-help">
                    Commands receive the selected path as the final argument. Apps use macOS open
                    with optional args.
                  </div>
                </div>
              </section>
            )}
            {activeSection === "git" && (
              <section className="settings-section">
                <div className="settings-section-title">Git</div>
                <div className="settings-section-subtitle">
                  Manage how diffs are loaded in the Git sidebar.
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Preload git diffs</div>
                    <div className="settings-toggle-subtitle">
                      Make viewing git diff faster.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.preloadGitDiffs ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        preloadGitDiffs: !appSettings.preloadGitDiffs,
                      })
                    }
                    aria-pressed={appSettings.preloadGitDiffs}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
              </section>
            )}
            {activeSection === "codex" && (
              <section className="settings-section">
                <div className="settings-section-title">Codex</div>
                <div className="settings-section-subtitle">
                  Configure the Codex CLI used by Friday and validate the install.
                </div>
                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="codex-path">
                    Default Codex path
                  </label>
                  <div className="settings-field-row">
                    <input
                      id="codex-path"
                      className="settings-input"
                      value={codexPathDraft}
                      placeholder="codex"
                      onChange={(event) => setCodexPathDraft(event.target.value)}
                    />
                    <button type="button" className="ghost" onClick={handleBrowseCodex}>
                      Browse
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setCodexPathDraft("")}
                    >
                      Use PATH
                    </button>
                  </div>
                  <div className="settings-help">
                    Leave empty to use the system PATH resolution.
                  </div>
                  <label className="settings-field-label" htmlFor="codex-args">
                    Default Codex args
                  </label>
                  <div className="settings-field-row">
                    <input
                      id="codex-args"
                      className="settings-input"
                      value={codexArgsDraft}
                      placeholder="--profile personal"
                      onChange={(event) => setCodexArgsDraft(event.target.value)}
                    />
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setCodexArgsDraft("")}
                    >
                      Clear
                    </button>
                  </div>
                  <div className="settings-help">
                    Extra flags passed before <code>app-server</code>. Use quotes for values with
                    spaces.
                  </div>
                <div className="settings-field-actions">
                  {codexDirty && (
                    <button
                      type="button"
                      className="primary"
                      onClick={handleSaveCodexSettings}
                      disabled={isSavingSettings}
                    >
                      {isSavingSettings ? "Saving..." : "Save"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="ghost settings-button-compact"
                    onClick={handleRunDoctor}
                    disabled={doctorState.status === "running"}
                  >
                    <Stethoscope aria-hidden />
                    {doctorState.status === "running" ? "Running..." : "Run doctor"}
                  </button>
                </div>

                {doctorState.result && (
                  <div
                    className={`settings-doctor ${doctorState.result.ok ? "ok" : "error"}`}
                  >
                    <div className="settings-doctor-title">
                      {doctorState.result.ok ? "Codex looks good" : "Codex issue detected"}
                    </div>
                    <div className="settings-doctor-body">
                      <div>
                        Version: {doctorState.result.version ?? "unknown"}
                      </div>
                      <div>
                        App-server: {doctorState.result.appServerOk ? "ok" : "failed"}
                      </div>
                      <div>
                        Node:{" "}
                        {doctorState.result.nodeOk
                          ? `ok (${doctorState.result.nodeVersion ?? "unknown"})`
                          : "missing"}
                      </div>
                      {doctorState.result.details && (
                        <div>{doctorState.result.details}</div>
                      )}
                      {doctorState.result.nodeDetails && (
                        <div>{doctorState.result.nodeDetails}</div>
                      )}
                      {doctorState.result.path && (
                        <div className="settings-doctor-path">
                          PATH: {doctorState.result.path}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="default-access">
                    Default access mode
                  </label>
                  <select
                    id="default-access"
                    className="settings-select"
                    value={appSettings.defaultAccessMode}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        defaultAccessMode: event.target.value as AppSettings["defaultAccessMode"],
                      })
                    }
                  >
                    <option value="read-only">Read only</option>
                    <option value="current">On-request</option>
                    <option value="full-access">Full access</option>
                  </select>
                </div>

                <div className="settings-field">
                  <label className="settings-field-label" htmlFor="backend-mode">
                    Backend mode
                  </label>
                  <select
                    id="backend-mode"
                    className="settings-select"
                    value={appSettings.backendMode}
                    onChange={(event) =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        backendMode: event.target.value as AppSettings["backendMode"],
                      })
                    }
                  >
                    <option value="local">Local (default)</option>
                    <option value="remote">Remote (daemon)</option>
                  </select>
                  <div className="settings-help">
                    Remote mode connects to a separate daemon running the backend on another machine (e.g. WSL2/Linux).
                  </div>
                </div>

                {appSettings.backendMode === "remote" && (
                  <div className="settings-field">
                    <div className="settings-field-label">Remote backend</div>
                    <div className="settings-field-row">
                      <input
                        className="settings-input settings-input--compact"
                        value={remoteHostDraft}
                        placeholder="127.0.0.1:4732"
                        onChange={(event) => setRemoteHostDraft(event.target.value)}
                        onBlur={() => {
                          void handleCommitRemoteHost();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void handleCommitRemoteHost();
                          }
                        }}
                        aria-label="Remote backend host"
                      />
                      <input
                        type="password"
                        className="settings-input settings-input--compact"
                        value={remoteTokenDraft}
                        placeholder="Token (optional)"
                        onChange={(event) => setRemoteTokenDraft(event.target.value)}
                        onBlur={() => {
                          void handleCommitRemoteToken();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void handleCommitRemoteToken();
                          }
                        }}
                        aria-label="Remote backend token"
                      />
                    </div>
                    <div className="settings-help">
                      Start the daemon separately and point Friday to it (host:port + token).
                    </div>
                  </div>
                )}

                <FileEditorCard
                  title="Global AGENTS.md"
                  meta={globalAgentsMeta}
                  error={globalAgentsError}
                  value={globalAgentsContent}
                  placeholder="Add global instructions for Codex agents…"
                  disabled={globalAgentsLoading}
                  refreshDisabled={globalAgentsRefreshDisabled}
                  saveDisabled={globalAgentsSaveDisabled}
                  saveLabel={globalAgentsSaveLabel}
                  onChange={setGlobalAgentsContent}
                  onRefresh={() => {
                    void refreshGlobalAgents();
                  }}
                  onSave={() => {
                    void saveGlobalAgents();
                  }}
                  helpText={
                    <>
                      Stored at <code>~/.codex/AGENTS.md</code>.
                    </>
                  }
                  classNames={{
                    container: "settings-field settings-agents",
                    header: "settings-agents-header",
                    title: "settings-field-label",
                    actions: "settings-agents-actions",
                    meta: "settings-help settings-help-inline",
                    iconButton: "ghost settings-icon-button",
                    error: "settings-agents-error",
                    textarea: "settings-agents-textarea",
                    help: "settings-help",
                  }}
                />

                <FileEditorCard
                  title="Global config.toml"
                  meta={globalConfigMeta}
                  error={globalConfigError}
                  value={globalConfigContent}
                  placeholder="Edit the global Codex config.toml…"
                  disabled={globalConfigLoading}
                  refreshDisabled={globalConfigRefreshDisabled}
                  saveDisabled={globalConfigSaveDisabled}
                  saveLabel={globalConfigSaveLabel}
                  onChange={setGlobalConfigContent}
                  onRefresh={() => {
                    void refreshGlobalConfig();
                  }}
                  onSave={() => {
                    void saveGlobalConfig();
                  }}
                  helpText={
                    <>
                      Stored at <code>~/.codex/config.toml</code>.
                    </>
                  }
                  classNames={{
                    container: "settings-field settings-agents",
                    header: "settings-agents-header",
                    title: "settings-field-label",
                    actions: "settings-agents-actions",
                    meta: "settings-help settings-help-inline",
                    iconButton: "ghost settings-icon-button",
                    error: "settings-agents-error",
                    textarea: "settings-agents-textarea",
                    help: "settings-help",
                  }}
                />

                <div className="settings-field">
                  <div className="settings-field-label">Workspace overrides</div>
                  <div className="settings-overrides">
                    {projects.map((workspace) => (
                      <div key={workspace.id} className="settings-override-row">
                        <div className="settings-override-info">
                          <div className="settings-project-name">{workspace.name}</div>
                          <div className="settings-project-path">{workspace.path}</div>
                        </div>
                        <div className="settings-override-actions">
                          <div className="settings-override-field">
                            <input
                              className="settings-input settings-input--compact"
                              value={codexBinOverrideDrafts[workspace.id] ?? ""}
                              placeholder="Codex binary override"
                              onChange={(event) =>
                                setCodexBinOverrideDrafts((prev) => ({
                                  ...prev,
                                  [workspace.id]: event.target.value,
                                }))
                              }
                              onBlur={async () => {
                                const draft = codexBinOverrideDrafts[workspace.id] ?? "";
                                const nextValue = normalizeOverrideValue(draft);
                                if (nextValue === (workspace.codex_bin ?? null)) {
                                  return;
                                }
                                await onUpdateWorkspaceCodexBin(workspace.id, nextValue);
                              }}
                              aria-label={`Codex binary override for ${workspace.name}`}
                            />
                            <button
                              type="button"
                              className="ghost"
                              onClick={async () => {
                                setCodexBinOverrideDrafts((prev) => ({
                                  ...prev,
                                  [workspace.id]: "",
                                }));
                                await onUpdateWorkspaceCodexBin(workspace.id, null);
                              }}
                            >
                              Clear
                            </button>
                          </div>
                          <div className="settings-override-field">
                            <input
                              className="settings-input settings-input--compact"
                              value={codexHomeOverrideDrafts[workspace.id] ?? ""}
                              placeholder="CODEX_HOME override"
                              onChange={(event) =>
                                setCodexHomeOverrideDrafts((prev) => ({
                                  ...prev,
                                  [workspace.id]: event.target.value,
                                }))
                              }
                              onBlur={async () => {
                                const draft = codexHomeOverrideDrafts[workspace.id] ?? "";
                                const nextValue = normalizeOverrideValue(draft);
                                if (nextValue === (workspace.settings.codexHome ?? null)) {
                                  return;
                                }
                                await onUpdateWorkspaceSettings(workspace.id, {
                                  codexHome: nextValue,
                                });
                              }}
                              aria-label={`CODEX_HOME override for ${workspace.name}`}
                            />
                            <button
                              type="button"
                              className="ghost"
                              onClick={async () => {
                                setCodexHomeOverrideDrafts((prev) => ({
                                  ...prev,
                                  [workspace.id]: "",
                                }));
                                await onUpdateWorkspaceSettings(workspace.id, {
                                  codexHome: null,
                                });
                              }}
                            >
                              Clear
                            </button>
                          </div>
                          <div className="settings-override-field">
                            <input
                              className="settings-input settings-input--compact"
                              value={codexArgsOverrideDrafts[workspace.id] ?? ""}
                              placeholder="Codex args override"
                              onChange={(event) =>
                                setCodexArgsOverrideDrafts((prev) => ({
                                  ...prev,
                                  [workspace.id]: event.target.value,
                                }))
                              }
                              onBlur={async () => {
                                const draft = codexArgsOverrideDrafts[workspace.id] ?? "";
                                const nextValue = normalizeOverrideValue(draft);
                                if (nextValue === (workspace.settings.codexArgs ?? null)) {
                                  return;
                                }
                                await onUpdateWorkspaceSettings(workspace.id, {
                                  codexArgs: nextValue,
                                });
                              }}
                              aria-label={`Codex args override for ${workspace.name}`}
                            />
                            <button
                              type="button"
                              className="ghost"
                              onClick={async () => {
                                setCodexArgsOverrideDrafts((prev) => ({
                                  ...prev,
                                  [workspace.id]: "",
                                }));
                                await onUpdateWorkspaceSettings(workspace.id, {
                                  codexArgs: null,
                                });
                              }}
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                    {projects.length === 0 && (
                      <div className="settings-empty">No projects yet.</div>
                    )}
                  </div>
                </div>

              </section>
            )}
            {activeSection === "experimental" && (
              <section className="settings-section">
                <div className="settings-section-title">Experimental</div>
                <div className="settings-section-subtitle">
                  Preview features that may change or be removed.
                </div>
                {hasCodexHomeOverrides && (
                  <div className="settings-help">
                    Experimental flags are stored in the default CODEX_HOME config.toml.
                    <br />
                    Workspace overrides are not updated.
                  </div>
                )}
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Config file</div>
                    <div className="settings-toggle-subtitle">
                      Open the Codex config in Finder.
                    </div>
                  </div>
                  <button type="button" className="ghost" onClick={handleOpenConfig}>
                    Open in Finder
                  </button>
                </div>
                {openConfigError && (
                  <div className="settings-help">{openConfigError}</div>
                )}
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Multi-agent</div>
                    <div className="settings-toggle-subtitle">
                      Enable multi-agent collaboration tools in Codex.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.experimentalCollabEnabled ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        experimentalCollabEnabled: !appSettings.experimentalCollabEnabled,
                      })
                    }
                    aria-pressed={appSettings.experimentalCollabEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Collaboration modes</div>
                    <div className="settings-toggle-subtitle">
                      Enable collaboration mode presets (Code, Plan).
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${
                      appSettings.experimentalCollaborationModesEnabled ? "on" : ""
                    }`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        experimentalCollaborationModesEnabled:
                          !appSettings.experimentalCollaborationModesEnabled,
                      })
                    }
                    aria-pressed={appSettings.experimentalCollaborationModesEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Background terminal</div>
                    <div className="settings-toggle-subtitle">
                      Run long-running terminal commands in the background.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.experimentalUnifiedExecEnabled ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        experimentalUnifiedExecEnabled: !appSettings.experimentalUnifiedExecEnabled,
                      })
                    }
                    aria-pressed={appSettings.experimentalUnifiedExecEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-toggle-row">
                  <div>
                    <div className="settings-toggle-title">Steer mode</div>
                    <div className="settings-toggle-subtitle">
                      Send messages immediately. Use Tab to queue while a run is active.
                    </div>
                  </div>
                  <button
                    type="button"
                    className={`settings-toggle ${appSettings.experimentalSteerEnabled ? "on" : ""}`}
                    onClick={() =>
                      void onUpdateAppSettings({
                        ...appSettings,
                        experimentalSteerEnabled: !appSettings.experimentalSteerEnabled,
                      })
                    }
                    aria-pressed={appSettings.experimentalSteerEnabled}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
              </section>
            )}
            {activeSection === "other-ai" && (
              <section className="settings-section">
                <div className="settings-section-title">Other AI</div>
                <div className="settings-section-subtitle">
                  Configure external providers and expose their models in the composer.
                </div>
                {appSettings.otherAiProviders.map((provider) => {
                  const draft = otherAiDrafts[provider.id] ?? {
                    id: provider.id,
                    label: provider.label ?? provider.id,
                    provider: provider.provider,
                    enabled: provider.enabled,
                    apiKey: provider.apiKey ?? "",
                    command: provider.command ?? "",
                    args: provider.args ?? "",
                    modelsText: (provider.models ?? []).join("\n"),
                    protocol: provider.protocol ?? "acp",
                    envText: formatEnvText(provider.env),
                  };
                  const fetchState = otherAiFetchState[provider.id];
                  return (
                    <div key={provider.id} className="settings-field">
                      <div className="settings-toggle-row">
                        <div>
                          <div className="settings-toggle-title">
                            {draft.label || provider.id}
                          </div>
                          <div className="settings-toggle-subtitle">
                            Provider ID: {provider.id}
                          </div>
                        </div>
                        <button
                          type="button"
                          className={`settings-toggle ${draft.enabled ? "on" : ""}`}
                          onClick={() => {
                            const nextEnabled = !draft.enabled;
                            setOtherAiDrafts((prev) => ({
                              ...prev,
                              [provider.id]: { ...draft, enabled: nextEnabled },
                            }));
                          }}
                        >
                          <span className="settings-toggle-knob" />
                        </button>
                      </div>
                      <div className="settings-field-row">
                        <input
                          className="settings-input"
                          value={draft.label}
                          placeholder="Provider label"
                          onChange={(event) =>
                            handleOtherAiDraftChange(provider.id, {
                              label: event.target.value,
                            })
                          }
                        />
                        <select
                          className="settings-select settings-input--compact"
                          value={draft.provider}
                          onChange={(event) =>
                            handleOtherAiDraftChange(provider.id, {
                              provider: event.target.value,
                            })
                          }
                        >
                          <option value="claude">Claude</option>
                          <option value="gemini">Gemini</option>
                          <option value="custom">Custom</option>
                        </select>
                        {provider.provider === "custom" && (
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => void handleRemoveOtherAiProvider(provider.id)}
                          >
                            Remove
                          </button>
                        )}
                      </div>
                      {draft.provider !== "custom" && (
                        <>
                          <label className="settings-field-label">API Key</label>
                          <input
                            type="password"
                            className="settings-input"
                            value={draft.apiKey}
                            placeholder={draft.provider === "claude" ? "sk-ant-..." : "AI..."}
                            onChange={(event) =>
                              handleOtherAiDraftChange(provider.id, {
                                apiKey: event.target.value,
                              })
                            }
                          />
                          <div className="settings-help">
                            Required for fetching models. Stored locally.
                          </div>
                        </>
                      )}
                      <label className="settings-field-label">CLI command</label>
                      <div className="settings-field-row">
                        <input
                          className="settings-input"
                          value={draft.command}
                          placeholder="claude"
                          onChange={(event) =>
                            handleOtherAiDraftChange(provider.id, {
                              command: event.target.value,
                            })
                          }
                        />
                        <input
                          className="settings-input"
                          value={draft.args}
                          placeholder="--output-format stream-json"
                          onChange={(event) =>
                            handleOtherAiDraftChange(provider.id, {
                              args: event.target.value,
                            })
                          }
                        />
                      </div>
                      <div className="settings-help">
                        Use {"{prompt}"} to inject the prompt into args; otherwise the prompt is sent
                        via stdin. Keep Claude CLI output set to stream JSON.
                      </div>
                      <label className="settings-field-label">Protocol</label>
                      <select
                        className="settings-select"
                        value={draft.protocol}
                        onChange={(event) =>
                          handleOtherAiDraftChange(provider.id, {
                            protocol: event.target.value,
                          })
                        }
                      >
                        <option value="acp">ACP (recommended)</option>
                        <option value="api">API</option>
                        <option value="cli">CLI</option>
                      </select>
                      <label className="settings-field-label">Env (KEY=VALUE)</label>
                      <textarea
                        className="settings-input"
                        rows={3}
                        value={draft.envText}
                        placeholder="API_KEY=...\nREGION=us"
                        onChange={(event) =>
                          handleOtherAiDraftChange(provider.id, {
                            envText: event.target.value,
                          })
                        }
                      />
                      <div className="settings-field-row">
                        <label className="settings-field-label">Models</label>
                        <button
                          type="button"
                          className="ghost"
                          disabled={draft.provider === "custom" || fetchState?.loading}
                          onClick={() => void handleOtherAiFetchModels(provider, draft)}
                        >
                          {fetchState?.loading ? "Fetching..." : "Fetch models"}
                        </button>
                      </div>
                      <textarea
                        className="settings-input"
                        rows={4}
                        value={draft.modelsText}
                        placeholder="model-1&#10;model-2"
                        onChange={(event) =>
                          handleOtherAiDraftChange(provider.id, {
                            modelsText: event.target.value,
                          })
                        }
                      />
                      <div className="settings-help">
                        One model per line or comma-separated. These appear in the model picker.
                        Uses API discovery for Claude/Gemini when you fetch.
                      </div>
                    </div>
                  );
                })}
                <div className="settings-field-actions">
                  {otherAiDirty && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void handleSaveOtherAiProviders()}
                    >
                      Save
                    </button>
                  )}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void handleAddOtherAiProvider()}
                  >
                    Add provider
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
