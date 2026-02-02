import { useCallback, useEffect, useState } from "react";
import type { AppSettings } from "../../../types";
import { getAppSettings, runCodexDoctor, updateAppSettings } from "../../../services/tauri";
import { clampUiScale, UI_SCALE_DEFAULT } from "../../../utils/uiScale";
import {
  DEFAULT_CODE_FONT_FAMILY,
  DEFAULT_INTER_FONT_FEATURES,
  DEFAULT_UI_FONT_FAMILY,
  CODE_FONT_SIZE_DEFAULT,
  clampCodeFontSize,
  normalizeInterFontFeatures,
} from "../../../utils/fonts";
import {
  DEFAULT_OPEN_APP_ID,
  DEFAULT_OPEN_APP_TARGETS,
  OPEN_APP_STORAGE_KEY,
} from "../../app/constants";
import { normalizeOpenAppTargets } from "../../app/utils/openApp";
import { getDefaultInterruptShortcut } from "../../../utils/shortcuts";

const allowedThemes = new Set(["system", "light", "dark", "dim"]);
const allowedEditorKeymaps = new Set(["jetbrains", "vscode", "default"]);
const LEGACY_UI_FONT_FAMILY =
  "\"SF Pro Text\", \"SF Pro Display\", -apple-system, \"Helvetica Neue\", sans-serif";
const LEGACY_CODE_FONT_FAMILY =
  "\"SF Mono\", \"SFMono-Regular\", Menlo, Monaco, monospace";

const defaultSettings: AppSettings = {
  codexBin: null,
  codexArgs: null,
  backendMode: "local",
  remoteBackendHost: "127.0.0.1:4732",
  remoteBackendToken: null,
  otherAiProviders: [
    {
      id: "claude",
      label: "Claude",
      provider: "claude",
      enabled: false,
      apiKey: null,
      command: "claude",
      args: null,
      models: ["claude-4.5-opus", "claude-4.5-sonnet"],
      defaultModel: null,
    },
    {
      id: "gemini",
      label: "Gemini",
      provider: "gemini",
      enabled: false,
      apiKey: null,
      command: "gemini",
      args: null,
      models: [],
      defaultModel: null,
    },
  ],
  defaultAccessMode: "current",
  composerModelShortcut: "cmd+shift+m",
  composerAccessShortcut: "cmd+shift+a",
  composerReasoningShortcut: "cmd+shift+r",
  composerCollaborationShortcut: "shift+tab",
  interruptShortcut: getDefaultInterruptShortcut(),
  newAgentShortcut: "cmd+n",
  newWorktreeAgentShortcut: "cmd+shift+n",
  newCloneAgentShortcut: "cmd+alt+n",
  archiveThreadShortcut: "cmd+ctrl+a",
  toggleProjectsSidebarShortcut: "cmd+shift+p",
  toggleGitSidebarShortcut: "cmd+shift+g",
  toggleDebugPanelShortcut: "cmd+shift+d",
  toggleTerminalShortcut: "cmd+shift+t",
  cycleAgentNextShortcut: "cmd+ctrl+down",
  cycleAgentPrevShortcut: "cmd+ctrl+up",
  cycleWorkspaceNextShortcut: "cmd+shift+down",
  cycleWorkspacePrevShortcut: "cmd+shift+up",
  editorKeymap: "jetbrains",
  lastComposerModelId: null,
  lastComposerReasoningEffort: null,
  uiScale: UI_SCALE_DEFAULT,
  theme: "system",
  usageShowRemaining: false,
  uiFontFamily: DEFAULT_UI_FONT_FAMILY,
  interFontFeatures: DEFAULT_INTER_FONT_FEATURES,
  codeFontFamily: DEFAULT_CODE_FONT_FAMILY,
  codeFontSize: CODE_FONT_SIZE_DEFAULT,
  notificationSoundsEnabled: true,
  preloadGitDiffs: true,
  experimentalCollabEnabled: false,
  experimentalCollaborationModesEnabled: false,
  experimentalSteerEnabled: false,
  experimentalUnifiedExecEnabled: false,
  dictationEnabled: false,
  dictationModelId: "base",
  dictationPreferredLanguage: null,
  dictationHoldKey: "alt",
  composerEditorPreset: "default",
  composerFenceExpandOnSpace: false,
  composerFenceExpandOnEnter: false,
  composerFenceLanguageTags: false,
  composerFenceWrapSelection: false,
  composerFenceAutoWrapPasteMultiline: false,
  composerFenceAutoWrapPasteCodeLike: false,
  composerListContinuation: false,
  composerCodeBlockCopyUseModifier: false,
  workspaceGroups: [],
  openAppTargets: DEFAULT_OPEN_APP_TARGETS,
  selectedOpenAppId: DEFAULT_OPEN_APP_ID,
};

function normalizeAppSettings(settings: AppSettings): AppSettings {
  const normalizedTargets =
    settings.openAppTargets && settings.openAppTargets.length
      ? normalizeOpenAppTargets(settings.openAppTargets)
      : DEFAULT_OPEN_APP_TARGETS;
  const storedOpenAppId =
    typeof window === "undefined"
      ? null
      : window.localStorage.getItem(OPEN_APP_STORAGE_KEY);
  const hasPersistedSelection = normalizedTargets.some(
    (target) => target.id === settings.selectedOpenAppId,
  );
  const hasStoredSelection =
    !hasPersistedSelection &&
    storedOpenAppId !== null &&
    normalizedTargets.some((target) => target.id === storedOpenAppId);
  const selectedOpenAppId = hasPersistedSelection
    ? settings.selectedOpenAppId
    : hasStoredSelection
      ? storedOpenAppId
      : normalizedTargets[0]?.id ?? DEFAULT_OPEN_APP_ID;
  const normalizeProtocol = (
    value: string | null | undefined,
  ): "acp" | "api" | "cli" => {
    const normalized = value?.trim().toLowerCase();
    if (normalized === "acp" || normalized === "api" || normalized === "cli") {
      return normalized;
    }
    return "acp";
  };
  const normalizedOtherAiProviders = (settings.otherAiProviders ?? []).map(
    (provider) => ({
      ...provider,
      label: provider.label?.trim() ? provider.label.trim() : provider.id,
      command: provider.command?.trim() ? provider.command.trim() : null,
      args: provider.args?.trim() ? provider.args.trim() : null,
      models: Array.isArray(provider.models)
        ? provider.models
            .map((model) => model.trim())
            .filter((model) => model.length > 0)
        : [],
      defaultModel: provider.defaultModel?.trim() ? provider.defaultModel.trim() : null,
      protocol: normalizeProtocol(provider.protocol),
      env: provider.env && typeof provider.env === "object" ? provider.env : null,
    }),
  );
  const normalizeFontWithLegacy = (
    value: string | null | undefined,
    fallback: string,
    legacy: string[],
  ) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return fallback;
    }
    return legacy.includes(trimmed) ? fallback : trimmed;
  };
  return {
    ...settings,
    codexBin: settings.codexBin?.trim() ? settings.codexBin.trim() : null,
    codexArgs: settings.codexArgs?.trim() ? settings.codexArgs.trim() : null,
    uiScale: clampUiScale(settings.uiScale),
    theme: allowedThemes.has(settings.theme) ? settings.theme : "system",
    uiFontFamily: normalizeFontWithLegacy(
      settings.uiFontFamily,
      DEFAULT_UI_FONT_FAMILY,
      [LEGACY_UI_FONT_FAMILY],
    ),
    interFontFeatures: normalizeInterFontFeatures(settings.interFontFeatures),
    codeFontFamily: normalizeFontWithLegacy(
      settings.codeFontFamily,
      DEFAULT_CODE_FONT_FAMILY,
      [LEGACY_CODE_FONT_FAMILY],
    ),
    codeFontSize: clampCodeFontSize(settings.codeFontSize),
    editorKeymap: allowedEditorKeymaps.has(settings.editorKeymap)
      ? settings.editorKeymap
      : "jetbrains",
    otherAiProviders: normalizedOtherAiProviders,
    openAppTargets: normalizedTargets,
    selectedOpenAppId,
  };
}

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await getAppSettings();
        if (active) {
          setSettings(
            normalizeAppSettings({
              ...defaultSettings,
              ...response,
            }),
          );
        }
      } catch {
        // Defaults stay in place if loading settings fails.
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const saveSettings = useCallback(async (next: AppSettings) => {
    const normalized = normalizeAppSettings(next);
    const saved = await updateAppSettings(normalized);
    setSettings(
      normalizeAppSettings({
        ...defaultSettings,
        ...saved,
      }),
    );
    return saved;
  }, []);

  const doctor = useCallback(
    async (codexBin: string | null, codexArgs: string | null) => {
      return runCodexDoctor(codexBin, codexArgs);
    },
    [],
  );

  return {
    settings,
    setSettings,
    saveSettings,
    doctor,
    isLoading,
  };
}
