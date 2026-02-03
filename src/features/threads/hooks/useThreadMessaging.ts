import { useCallback } from "react";
import type { Dispatch, MutableRefObject } from "react";
import * as Sentry from "@sentry/react";
import type {
  AccessMode,
  RateLimitSnapshot,
  CustomPromptOption,
  DebugEntry,
  OtherAiProvider,
  ReviewTarget,
  WorkspaceInfo,
} from "../../../types";
import {
  sendUserMessage as sendUserMessageService,
  startReview as startReviewService,
  interruptTurn as interruptTurnService,
  sendClaudeMessage,
  sendClaudeCliMessage,
  sendClaudeMessageSync,
  sendGeminiCliMessageSync,
  sendGeminiMessageSync,
  acpStartSession,
  acpSendStream,
  acpStopSession,
  type ClaudeMessage,
  type ClaudeRateLimits,
  type ClaudeUsage,
  listMcpServerStatus as listMcpServerStatusService,
} from "../../../services/tauri";
import { subscribeAcpEvents } from "../../../services/events";
import type { Unsubscribe } from "../../../services/events";
import { expandCustomPromptText } from "../../../utils/customPrompts";
import {
  asString,
  extractRpcErrorMessage,
  normalizePlanUpdate,
  parseReviewTarget,
} from "../utils/threadNormalize";
import type { ThreadAction, ThreadState } from "./useThreadsReducer";
import { useReviewPrompt } from "./useReviewPrompt";
import { formatRelativeTime } from "../../../utils/time";

type SendMessageOptions = {
  skipPromptExpansion?: boolean;
  model?: string | null;
  effort?: string | null;
  collaborationMode?: Record<string, unknown> | null;
  accessMode?: AccessMode;
};

type UseThreadMessagingOptions = {
  activeWorkspace: WorkspaceInfo | null;
  activeThreadId: string | null;
  accessMode?: "read-only" | "current" | "full-access";
  model?: string | null;
  effort?: string | null;
  collaborationMode?: Record<string, unknown> | null;
  steerEnabled: boolean;
  customPrompts: CustomPromptOption[];
  otherAiProviders: OtherAiProvider[];
  threadStatusById: ThreadState["threadStatusById"];
  activeTurnIdByThread: ThreadState["activeTurnIdByThread"];
  rateLimitsByWorkspace: Record<string, RateLimitSnapshot | null>;
  pendingInterruptsRef: MutableRefObject<Set<string>>;
  dispatch: Dispatch<ThreadAction>;
  getCustomName: (workspaceId: string, threadId: string) => string | undefined;
  markProcessing: (threadId: string, isProcessing: boolean) => void;
  markReviewing: (threadId: string, isReviewing: boolean) => void;
  setActiveTurnId: (threadId: string, turnId: string | null) => void;
  recordThreadActivity: (
    workspaceId: string,
    threadId: string,
    timestamp?: number,
  ) => void;
  safeMessageActivity: () => void;
  onDebug?: (entry: DebugEntry) => void;
  onClaudeRateLimits?: (limits: ClaudeRateLimits) => void;
  onClaudeUsage?: (usage: ClaudeUsage) => void;
  onAssistantMessageCompleted?: (
    workspaceId: string,
    threadId: string,
    text: string,
  ) => void;
  pushThreadErrorMessage: (threadId: string, message: string) => void;
  ensureThreadForActiveWorkspace: () => Promise<string | null>;
  ensureThreadForWorkspace: (workspaceId: string) => Promise<string | null>;
  refreshThread: (workspaceId: string, threadId: string) => Promise<string | null>;
  forkThreadForWorkspace: (workspaceId: string, threadId: string) => Promise<string | null>;
  updateThreadParent: (parentId: string, childIds: string[]) => void;
};

type PlanJsonStep = {
  step?: unknown;
  status?: unknown;
};

type PlanJsonPayload = {
  explanation?: unknown;
  steps?: unknown;
  plan?: unknown;
};

const PLAN_MODE_ID = "plan";

function extractPlanJson(text: string): PlanJsonPayload | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as PlanJsonPayload;
  } catch {
    return null;
  }
}

function normalizePlanPayload(turnId: string, payload: PlanJsonPayload | null) {
  if (!payload) {
    return null;
  }
  const explanation =
    typeof payload.explanation === "string" ? payload.explanation : "";
  const rawSteps = Array.isArray(payload.steps)
    ? payload.steps
    : Array.isArray(payload.plan)
      ? payload.plan
      : [];
  const steps = rawSteps
    .map((step): PlanJsonStep | null => {
      if (!step) {
        return null;
      }
      if (typeof step === "string") {
        return { step, status: "pending" };
      }
      if (typeof step === "object") {
        return step as PlanJsonStep;
      }
      return null;
    })
    .filter(Boolean);
  return normalizePlanUpdate(turnId, explanation, steps);
}

function formatPlanAsMessage(plan: ReturnType<typeof normalizePlanUpdate>) {
  if (!plan) {
    return "";
  }
  const header = plan.explanation ? `Plan: ${plan.explanation}` : "Plan:";
  const lines = plan.steps.map((step, index) => {
    const status =
      step.status === "inProgress"
        ? "in_progress"
        : step.status ?? "pending";
    return `${index + 1}. [${status}] ${step.step}`;
  });
  return [header, ...lines].join("\n");
}

function buildPlanPrompt(userText: string, attempt: number) {
  const baseInstruction = [
    "You are in PLAN mode.",
    "Return ONLY valid JSON with this shape:",
    "{ \"explanation\": \"...\", \"steps\": [{ \"step\": \"...\", \"status\": \"pending|in_progress|completed\" }] }",
    "No markdown, no prose, no code fences.",
  ];
  const retry =
    attempt > 0
      ? [
          "Your previous response was invalid.",
          "Return STRICT JSON only. Do not include any extra text.",
        ]
      : [];
  return [...baseInstruction, ...retry, "", "User request:", userText].join("\n");
}

function extractAcpText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const value = (payload as Record<string, unknown>).result ?? payload;
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.content === "string") {
      return record.content;
    }
    if (typeof record.text === "string") {
      return record.text;
    }
    const message = record.message;
    if (message && typeof message === "object") {
      const msgRecord = message as Record<string, unknown>;
      if (typeof msgRecord.content === "string") {
        return msgRecord.content;
      }
    }
    const choices = record.choices;
    if (Array.isArray(choices) && choices[0]) {
      const first = choices[0] as Record<string, unknown>;
      const firstMessage = first.message as Record<string, unknown> | undefined;
      if (firstMessage && typeof firstMessage.content === "string") {
        return firstMessage.content;
      }
    }
  }
  return null;
}

function extractAcpDelta(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const value = (payload as Record<string, unknown>).params ?? payload;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const delta =
      (typeof record.delta === "string" && record.delta) ||
      (typeof record.contentDelta === "string" && record.contentDelta) ||
      (typeof record.content_delta === "string" && record.content_delta) ||
      (typeof record.textDelta === "string" && record.textDelta) ||
      (typeof record.text_delta === "string" && record.text_delta) ||
      (typeof record.chunk === "string" && record.chunk);
    if (delta) {
      return delta;
    }
  }
  return null;
}

export function useThreadMessaging({
  activeWorkspace,
  activeThreadId,
  accessMode,
  model,
  effort,
  collaborationMode,
  steerEnabled,
  customPrompts,
  otherAiProviders,
  threadStatusById,
  activeTurnIdByThread,
  rateLimitsByWorkspace,
  pendingInterruptsRef,
  dispatch,
  getCustomName,
  markProcessing,
  markReviewing,
  setActiveTurnId,
  recordThreadActivity,
  safeMessageActivity,
  onDebug,
  onClaudeRateLimits,
  onClaudeUsage,
  onAssistantMessageCompleted,
  pushThreadErrorMessage,
  ensureThreadForActiveWorkspace,
  ensureThreadForWorkspace,
  refreshThread,
  forkThreadForWorkspace,
  updateThreadParent,
}: UseThreadMessagingOptions) {
  const sendMessageToThread = useCallback(
    async (
      workspace: WorkspaceInfo,
      threadId: string,
      text: string,
      images: string[] = [],
      options?: SendMessageOptions,
    ) => {
      const languageDirective =
        "Always respond in the same language as the user's most recent message.";
      const messageText = text.trim();
      if (!messageText && images.length === 0) {
        return;
      }
      let finalText = messageText;
      if (!options?.skipPromptExpansion) {
        const promptExpansion = expandCustomPromptText(messageText, customPrompts);
        if (promptExpansion && "error" in promptExpansion) {
          pushThreadErrorMessage(threadId, promptExpansion.error);
          safeMessageActivity();
          return;
        }
        finalText = promptExpansion?.expanded ?? messageText;
      }
      const resolvedModel =
        options?.model !== undefined ? options.model : model;
      const resolvedEffort =
        options?.effort !== undefined ? options.effort : effort;
      const resolvedCollaborationMode =
        options?.collaborationMode !== undefined
          ? options.collaborationMode
          : collaborationMode;
      const collaborationModeId =
        resolvedCollaborationMode &&
        typeof resolvedCollaborationMode === "object" &&
        "mode" in resolvedCollaborationMode
          ? String(
              (resolvedCollaborationMode as Record<string, unknown>).mode ?? "",
            )
          : "";
      const isPlanMode = collaborationModeId === PLAN_MODE_ID;
      const sanitizedCollaborationMode =
        resolvedCollaborationMode &&
        typeof resolvedCollaborationMode === "object" &&
        "settings" in resolvedCollaborationMode
          ? resolvedCollaborationMode
          : null;
      const languageAwareCollaborationMode = sanitizedCollaborationMode
        ? (() => {
            const rawSettings =
              "settings" in sanitizedCollaborationMode
                ? (sanitizedCollaborationMode.settings as Record<string, unknown>)
                : {};
            const existingInstructions =
              typeof rawSettings.developer_instructions === "string"
                ? rawSettings.developer_instructions.trim()
                : "";
            const hasLanguageDirective = existingInstructions
              .toLowerCase()
              .includes("same language");
            const mergedInstructions = hasLanguageDirective
              ? existingInstructions
              : existingInstructions
                ? `${existingInstructions}\n\n${languageDirective}`
                : languageDirective;
            return {
              ...sanitizedCollaborationMode,
              settings: {
                ...rawSettings,
                developer_instructions: mergedInstructions,
              },
            };
          })()
        : null;
      const resolvedAccessMode =
        options?.accessMode !== undefined ? options.accessMode : accessMode;

      const wasProcessing =
        (threadStatusById[threadId]?.isProcessing ?? false) && steerEnabled;
      if (wasProcessing) {
        const optimisticText = finalText;
        if (optimisticText || images.length > 0) {
          dispatch({
            type: "upsertItem",
            workspaceId: workspace.id,
            threadId,
            item: {
              id: `optimistic-user-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
              kind: "message",
              role: "user",
              text: optimisticText,
              images: images.length > 0 ? images : undefined,
            },
            hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
          });
        }
      }
      Sentry.metrics.count("prompt_sent", 1, {
        attributes: {
          workspace_id: workspace.id,
          thread_id: threadId,
          has_images: images.length > 0 ? "true" : "false",
          text_length: String(finalText.length),
          model: resolvedModel ?? "unknown",
          effort: resolvedEffort ?? "unknown",
          collaboration_mode: sanitizedCollaborationMode ?? "unknown",
        },
      });
      const timestamp = Date.now();
      recordThreadActivity(workspace.id, threadId, timestamp);
      dispatch({
        type: "setThreadTimestamp",
        workspaceId: workspace.id,
        threadId,
        timestamp,
      });
      markProcessing(threadId, true);
      safeMessageActivity();
      onDebug?.({
        id: `${Date.now()}-client-turn-start`,
        timestamp: Date.now(),
        source: "client",
        label: "turn/start",
        payload: {
          workspaceId: workspace.id,
          threadId,
          text: finalText,
          images,
          model: resolvedModel,
          effort: resolvedEffort,
          collaborationMode: sanitizedCollaborationMode,
        },
      });
      try {
        // Check if this is a Claude model (format: "providerId:model-name")
      const isOtherAiModel = resolvedModel?.includes(":") ?? false;
      const colonIndex = resolvedModel?.indexOf(":") ?? -1;
      const providerId = isOtherAiModel ? resolvedModel!.slice(0, colonIndex) : null;
      const provider = providerId ? otherAiProviders.find((p) => p.id === providerId) : null;
      const modelName = isOtherAiModel ? resolvedModel!.slice(colonIndex + 1) : null;

        if (provider && provider.protocol === "acp") {
        const command = provider.command?.trim();
        if (!command) {
          markProcessing(threadId, false);
          pushThreadErrorMessage(
            threadId,
            "ACP not configured. Set a CLI command in Settings > Other AI.",
          );
          safeMessageActivity();
          return;
        }

        dispatch({
          type: "upsertItem",
          workspaceId: workspace.id,
          threadId,
          item: {
            id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: "message",
            role: "user",
            text: finalText,
          },
          hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
        });

        const promptText = isPlanMode
          ? buildPlanPrompt(finalText, 0)
          : `${languageDirective}\n\n${finalText}`;
        const requestId = `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const request = {
          jsonrpc: "2.0",
          id: requestId,
          method: "prompt",
          params: {
            prompt: promptText,
            model: modelName,
          },
        };
        try {
          const sessionId = await acpStartSession({
            command,
            args: provider.args?.trim() ? provider.args.trim().split(/\\s+/) : [],
            env: provider.env ?? undefined,
          });
          let response: unknown;
          let accumulatedText = "";
          let unsubscribe: Unsubscribe | null = null;
          const assistantMessageId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          if (!isPlanMode) {
            dispatch({
              type: "upsertItem",
              workspaceId: workspace.id,
              threadId,
              item: {
                id: assistantMessageId,
                kind: "message",
                role: "assistant",
                text: "",
              },
              hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
            });
          }
          try {
            unsubscribe = subscribeAcpEvents((event) => {
              if (event.sessionId !== sessionId) {
                return;
              }
              const delta = extractAcpDelta(event.payload);
              if (!delta) {
                return;
              }
              accumulatedText += delta;
              if (isPlanMode) {
                return;
              }
              dispatch({
                type: "upsertItem",
                workspaceId: workspace.id,
                threadId,
                item: {
                  id: assistantMessageId,
                  kind: "message",
                  role: "assistant",
                  text: accumulatedText,
                },
                hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
              });
            });
            response = await acpSendStream(sessionId, request);
          } finally {
            if (unsubscribe) {
              unsubscribe();
            }
            await acpStopSession(sessionId).catch(() => {});
          }
          const responseText = accumulatedText || extractAcpText(response);
          if (!responseText) {
            throw new Error("ACP response did not include text.");
          }
          if (isPlanMode) {
            const turnId = activeTurnIdByThread[threadId] ?? "pending";
            const parsed = normalizePlanPayload(
              turnId,
              extractPlanJson(responseText),
            );
            if (!parsed) {
              markProcessing(threadId, false);
              pushThreadErrorMessage(
                threadId,
                "Plan mode failed: invalid response from ACP agent. Try again.",
              );
              safeMessageActivity();
              return;
            }
            dispatch({
              type: "setThreadPlan",
              threadId,
              plan: parsed,
            });
            dispatch({
              type: "upsertItem",
              workspaceId: workspace.id,
              threadId,
              item: {
                id: assistantMessageId,
                kind: "message",
                role: "assistant",
                text: formatPlanAsMessage(parsed),
              },
              hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
            });
          } else {
            dispatch({
              type: "upsertItem",
              workspaceId: workspace.id,
              threadId,
              item: {
                id: assistantMessageId,
                kind: "message",
                role: "assistant",
                text: responseText,
              },
              hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
            });
            onAssistantMessageCompleted?.(workspace.id, threadId, responseText);
          }
          markProcessing(threadId, false);
          safeMessageActivity();
          return;
        } catch (error) {
          onDebug?.({
            id: `${Date.now()}-acp-error`,
            timestamp: Date.now(),
            source: "error",
            label: "acp/send error",
            payload: error instanceof Error ? error.message : String(error),
          });
          if (!provider.command) {
            markProcessing(threadId, false);
            pushThreadErrorMessage(
              threadId,
              "ACP request failed and no CLI fallback is configured.",
            );
            safeMessageActivity();
            return;
          }
        }
      }

      if (provider && provider.provider === "claude") {
        // Claude provider - use CLI or API
        const useCli = Boolean(provider.command);
          const useApi = Boolean(provider.apiKey) && !useCli;

          if (!useCli && !useApi) {
            markProcessing(threadId, false);
            pushThreadErrorMessage(
              threadId,
              "Claude not configured. Set CLI command or API key in Settings > Other AI."
            );
            safeMessageActivity();
            return;
          }

          // Add user message to thread immediately
          dispatch({
            type: "upsertItem",
            workspaceId: workspace.id,
            threadId,
            item: {
              id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: "message",
              role: "user",
              text: finalText,
            },
            hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
          });

          const assistantMessageId = `assistant-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;

          if (useCli) {
            // Use Claude CLI
            let accumulatedText = "";
            const promptText = isPlanMode
              ? buildPlanPrompt(finalText, 0)
              : finalText;
            await sendClaudeCliMessage(
              provider.command!,
              provider.args,
              promptText,
              workspace.path,
              {
                onInit: (sessionId, model) => {
                  onDebug?.({
                    id: `${Date.now()}-claude-cli-init`,
                    timestamp: Date.now(),
                    source: "client",
                    label: "claude-cli/init",
                    payload: { sessionId, model },
                  });
                },
                onContent: (text) => {
                  accumulatedText += text;
                  if (!isPlanMode) {
                    dispatch({
                      type: "upsertItem",
                      workspaceId: workspace.id,
                      threadId,
                      item: {
                        id: assistantMessageId,
                        kind: "message",
                        role: "assistant",
                        text: accumulatedText,
                      },
                      hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
                    });
                    safeMessageActivity();
                  }
                },
                onComplete: (_text, usage) => {
                  if (usage) {
                    onClaudeUsage?.({
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                    });
                  }
                  if (isPlanMode) {
                    const turnId =
                      activeTurnIdByThread[threadId] ?? "pending";
                    const parsed = normalizePlanPayload(
                      turnId,
                      extractPlanJson(accumulatedText),
                    );
                    if (!parsed) {
                      markProcessing(threadId, false);
                      pushThreadErrorMessage(
                        threadId,
                        "Plan mode failed: invalid response from Claude CLI. Try again."
                      );
                      safeMessageActivity();
                      return;
                    }
                    dispatch({
                      type: "setThreadPlan",
                      threadId,
                      plan: parsed,
                    });
                    dispatch({
                      type: "upsertItem",
                      workspaceId: workspace.id,
                      threadId,
                      item: {
                        id: assistantMessageId,
                        kind: "message",
                        role: "assistant",
                        text: formatPlanAsMessage(parsed),
                      },
                      hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
                    });
                  }
                  markProcessing(threadId, false);
                  safeMessageActivity();
                },
                onError: (error) => {
                  markProcessing(threadId, false);
                  pushThreadErrorMessage(threadId, error);
                  safeMessageActivity();
                },
              }
            );
          } else {
            // Use Claude API
            const modelName = resolvedModel!.slice(colonIndex + 1);
            if (isPlanMode) {
              let attempt = 0;
              let plan = null;
              while (attempt < 2 && !plan) {
                const promptText = buildPlanPrompt(finalText, attempt);
                const claudeMessages: ClaudeMessage[] = [
                  { role: "user", content: promptText },
                ];
                const response = await sendClaudeMessageSync(
                  provider.apiKey!,
                  modelName,
                  claudeMessages,
                );
                plan = normalizePlanPayload(
                  activeTurnIdByThread[threadId] ?? "pending",
                  extractPlanJson(response.content),
                );
                if (response.usage) {
                  onClaudeUsage?.(response.usage);
                }
                attempt += 1;
              }
              if (!plan) {
                markProcessing(threadId, false);
                pushThreadErrorMessage(
                  threadId,
                  "Plan mode failed: invalid response from Claude. Try again."
                );
                safeMessageActivity();
                return;
              }
              dispatch({
                type: "setThreadPlan",
                threadId,
                plan,
              });
              dispatch({
                type: "upsertItem",
                workspaceId: workspace.id,
                threadId,
                item: {
                  id: assistantMessageId,
                  kind: "message",
                  role: "assistant",
                  text: formatPlanAsMessage(plan),
                },
                hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
              });
              markProcessing(threadId, false);
              safeMessageActivity();
            } else {
              const claudeMessages: ClaudeMessage[] = [
                { role: "user", content: finalText },
              ];

              let accumulatedText = "";

              await sendClaudeMessage(provider.apiKey!, modelName, claudeMessages, {
                onContent: (text) => {
                  accumulatedText += text;
                  dispatch({
                    type: "upsertItem",
                    workspaceId: workspace.id,
                    threadId,
                    item: {
                      id: assistantMessageId,
                      kind: "message",
                      role: "assistant",
                      text: accumulatedText,
                    },
                    hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
                  });
                  safeMessageActivity();
                },
                onComplete: (_fullText, usage) => {
                  if (usage) {
                    onClaudeUsage?.(usage);
                  }
                  markProcessing(threadId, false);
                  safeMessageActivity();
                },
                onRateLimits: (limits) => {
                  onClaudeRateLimits?.(limits);
                },
                onError: (error) => {
                  markProcessing(threadId, false);
                  pushThreadErrorMessage(threadId, error);
                  safeMessageActivity();
                },
              });
            }
          }

          onDebug?.({
            id: `${Date.now()}-claude-message-sent`,
            timestamp: Date.now(),
            source: "client",
            label: "claude/message",
            payload: { model: resolvedModel, textLength: finalText.length },
          });

          return;
        }

        if (provider && provider.provider === "gemini") {
          const useCli = Boolean(provider.command);
          const useApi = Boolean(provider.apiKey) && !useCli;

          if (!useCli && !useApi) {
            markProcessing(threadId, false);
            pushThreadErrorMessage(
              threadId,
              "Gemini not configured. Set CLI command or API key in Settings > Other AI."
            );
            safeMessageActivity();
            return;
          }

          dispatch({
            type: "upsertItem",
            workspaceId: workspace.id,
            threadId,
            item: {
              id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: "message",
              role: "user",
              text: finalText,
            },
            hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
          });

          const assistantMessageId = `assistant-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          const modelName = resolvedModel!.slice(colonIndex + 1);

          if (isPlanMode) {
            let attempt = 0;
            let plan = null;
            while (attempt < 2 && !plan) {
              const promptText = buildPlanPrompt(finalText, attempt);
              const response = useCli
                ? await sendGeminiCliMessageSync(
                    provider.command!,
                    provider.args ?? null,
                    promptText,
                    workspace.path,
                  )
                : await sendGeminiMessageSync(
                    provider.apiKey!,
                    modelName,
                    promptText,
                  );
              plan = normalizePlanPayload(
                activeTurnIdByThread[threadId] ?? "pending",
                extractPlanJson(response.content),
              );
              attempt += 1;
            }
            if (!plan) {
              markProcessing(threadId, false);
              pushThreadErrorMessage(
                threadId,
                "Plan mode failed: invalid response from Gemini. Try again."
              );
              safeMessageActivity();
              return;
            }
            dispatch({
              type: "setThreadPlan",
              threadId,
              plan,
            });
            dispatch({
              type: "upsertItem",
              workspaceId: workspace.id,
              threadId,
              item: {
                id: assistantMessageId,
                kind: "message",
                role: "assistant",
                text: formatPlanAsMessage(plan),
              },
              hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
            });
            markProcessing(threadId, false);
            safeMessageActivity();
            return;
          }

          const promptText = isPlanMode
            ? buildPlanPrompt(finalText, 0)
            : `${languageDirective}\n\n${finalText}`;
          const response = useCli
            ? await sendGeminiCliMessageSync(
                provider.command!,
                provider.args ?? null,
                promptText,
                workspace.path,
              )
            : await sendGeminiMessageSync(
                provider.apiKey!,
                modelName,
                promptText,
              );
          dispatch({
            type: "upsertItem",
            workspaceId: workspace.id,
            threadId,
            item: {
              id: assistantMessageId,
              kind: "message",
              role: "assistant",
              text: response.content,
            },
            hasCustomName: Boolean(getCustomName(workspace.id, threadId)),
          });
          onAssistantMessageCompleted?.(workspace.id, threadId, response.content);
          markProcessing(threadId, false);
          safeMessageActivity();
          return;
        }

        // Existing Codex flow
        const response =
          (await sendUserMessageService(
            workspace.id,
            threadId,
            finalText,
            {
              model: resolvedModel,
              effort: resolvedEffort,
              collaborationMode: languageAwareCollaborationMode,
              accessMode: resolvedAccessMode,
              images,
            },
          )) as Record<string, unknown>;
        onDebug?.({
          id: `${Date.now()}-server-turn-start`,
          timestamp: Date.now(),
          source: "server",
          label: "turn/start response",
          payload: response,
        });
        const rpcError = extractRpcErrorMessage(response);
        if (rpcError) {
          markProcessing(threadId, false);
          setActiveTurnId(threadId, null);
          pushThreadErrorMessage(threadId, `Turn failed to start: ${rpcError}`);
          safeMessageActivity();
          return;
        }
        const result = (response?.result ?? response) as Record<string, unknown>;
        const turn = (result?.turn ?? response?.turn ?? null) as
          | Record<string, unknown>
          | null;
        const turnId = asString(turn?.id ?? "");
        if (!turnId) {
          markProcessing(threadId, false);
          setActiveTurnId(threadId, null);
          pushThreadErrorMessage(threadId, "Turn failed to start.");
          safeMessageActivity();
          return;
        }
        setActiveTurnId(threadId, turnId);
      } catch (error) {
        markProcessing(threadId, false);
        setActiveTurnId(threadId, null);
        onDebug?.({
          id: `${Date.now()}-client-turn-start-error`,
          timestamp: Date.now(),
          source: "error",
          label: "turn/start error",
          payload: error instanceof Error ? error.message : String(error),
        });
        pushThreadErrorMessage(
          threadId,
          error instanceof Error ? error.message : String(error),
        );
        safeMessageActivity();
      }
    },
    [
      accessMode,
      activeTurnIdByThread,
      collaborationMode,
      customPrompts,
      dispatch,
      effort,
      getCustomName,
      markProcessing,
      model,
      onClaudeRateLimits,
      onClaudeUsage,
      onAssistantMessageCompleted,
      onDebug,
      otherAiProviders,
      pushThreadErrorMessage,
      recordThreadActivity,
      safeMessageActivity,
      setActiveTurnId,
      steerEnabled,
      threadStatusById,
    ],
  );

  const sendUserMessage = useCallback(
    async (text: string, images: string[] = []) => {
      if (!activeWorkspace) {
        return;
      }
      const messageText = text.trim();
      if (!messageText && images.length === 0) {
        return;
      }
      const promptExpansion = expandCustomPromptText(messageText, customPrompts);
      if (promptExpansion && "error" in promptExpansion) {
        if (activeThreadId) {
          pushThreadErrorMessage(activeThreadId, promptExpansion.error);
          safeMessageActivity();
        } else {
          onDebug?.({
            id: `${Date.now()}-client-prompt-expand-error`,
            timestamp: Date.now(),
            source: "error",
            label: "prompt/expand error",
            payload: promptExpansion.error,
          });
        }
        return;
      }
      const finalText = promptExpansion?.expanded ?? messageText;
      const threadId = await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return;
      }
      await sendMessageToThread(activeWorkspace, threadId, finalText, images, {
        skipPromptExpansion: true,
      });
    },
    [
      activeThreadId,
      activeWorkspace,
      customPrompts,
      ensureThreadForActiveWorkspace,
      onDebug,
      pushThreadErrorMessage,
      safeMessageActivity,
      sendMessageToThread,
    ],
  );

  const sendUserMessageToThread = useCallback(
    async (
      workspace: WorkspaceInfo,
      threadId: string,
      text: string,
      images: string[] = [],
      options?: SendMessageOptions,
    ) => {
      await sendMessageToThread(workspace, threadId, text, images, options);
    },
    [sendMessageToThread],
  );

  const interruptTurn = useCallback(async () => {
    if (!activeWorkspace || !activeThreadId) {
      return;
    }
    const activeTurnId = activeTurnIdByThread[activeThreadId] ?? null;
    const turnId = activeTurnId ?? "pending";
    markProcessing(activeThreadId, false);
    setActiveTurnId(activeThreadId, null);
    dispatch({
      type: "addAssistantMessage",
      threadId: activeThreadId,
      text: "Session stopped.",
    });
    if (!activeTurnId) {
      pendingInterruptsRef.current.add(activeThreadId);
    }
    onDebug?.({
      id: `${Date.now()}-client-turn-interrupt`,
      timestamp: Date.now(),
      source: "client",
      label: "turn/interrupt",
      payload: {
        workspaceId: activeWorkspace.id,
        threadId: activeThreadId,
        turnId,
        queued: !activeTurnId,
      },
    });
    try {
      const response = await interruptTurnService(
        activeWorkspace.id,
        activeThreadId,
        turnId,
      );
      onDebug?.({
        id: `${Date.now()}-server-turn-interrupt`,
        timestamp: Date.now(),
        source: "server",
        label: "turn/interrupt response",
        payload: response,
      });
    } catch (error) {
      onDebug?.({
        id: `${Date.now()}-client-turn-interrupt-error`,
        timestamp: Date.now(),
        source: "error",
        label: "turn/interrupt error",
        payload: error instanceof Error ? error.message : String(error),
      });
    }
  }, [
    activeThreadId,
    activeTurnIdByThread,
    activeWorkspace,
    dispatch,
    markProcessing,
    onDebug,
    pendingInterruptsRef,
    setActiveTurnId,
  ]);

  const startReviewTarget = useCallback(
    async (target: ReviewTarget, workspaceIdOverride?: string): Promise<boolean> => {
      const workspaceId = workspaceIdOverride ?? activeWorkspace?.id ?? null;
      if (!workspaceId) {
        return false;
      }
      const threadId = workspaceIdOverride
        ? await ensureThreadForWorkspace(workspaceId)
        : await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return false;
      }

      markProcessing(threadId, true);
      markReviewing(threadId, true);
      safeMessageActivity();
      onDebug?.({
        id: `${Date.now()}-client-review-start`,
        timestamp: Date.now(),
        source: "client",
        label: "review/start",
        payload: {
          workspaceId,
          threadId,
          target,
        },
      });
      try {
        const response = await startReviewService(
          workspaceId,
          threadId,
          target,
          "inline",
        );
        onDebug?.({
          id: `${Date.now()}-server-review-start`,
          timestamp: Date.now(),
          source: "server",
          label: "review/start response",
          payload: response,
        });
        const rpcError = extractRpcErrorMessage(response);
        if (rpcError) {
          markProcessing(threadId, false);
          markReviewing(threadId, false);
          setActiveTurnId(threadId, null);
          pushThreadErrorMessage(threadId, `Review failed to start: ${rpcError}`);
          safeMessageActivity();
          return false;
        }
        return true;
      } catch (error) {
        markProcessing(threadId, false);
        markReviewing(threadId, false);
        onDebug?.({
          id: `${Date.now()}-client-review-start-error`,
          timestamp: Date.now(),
          source: "error",
          label: "review/start error",
          payload: error instanceof Error ? error.message : String(error),
        });
        pushThreadErrorMessage(
          threadId,
          error instanceof Error ? error.message : String(error),
        );
        safeMessageActivity();
        return false;
      }
    },
    [
      activeWorkspace,
      ensureThreadForActiveWorkspace,
      ensureThreadForWorkspace,
      markProcessing,
      markReviewing,
      onDebug,
      pushThreadErrorMessage,
      safeMessageActivity,
      setActiveTurnId,
    ],
  );

  const {
    reviewPrompt,
    openReviewPrompt,
    closeReviewPrompt,
    showPresetStep,
    choosePreset,
    highlightedPresetIndex,
    setHighlightedPresetIndex,
    highlightedBranchIndex,
    setHighlightedBranchIndex,
    highlightedCommitIndex,
    setHighlightedCommitIndex,
    handleReviewPromptKeyDown,
    confirmBranch,
    selectBranch,
    selectBranchAtIndex,
    selectCommit,
    selectCommitAtIndex,
    confirmCommit,
    updateCustomInstructions,
    confirmCustom,
  } = useReviewPrompt({
    activeWorkspace,
    activeThreadId,
    onDebug,
    startReviewTarget,
  });

  const startReview = useCallback(
    async (text: string) => {
      if (!activeWorkspace || !text.trim()) {
        return;
      }
      const trimmed = text.trim();
      const rest = trimmed.replace(/^\/review\b/i, "").trim();
      if (!rest) {
        openReviewPrompt();
        return;
      }

      const target = parseReviewTarget(trimmed);
      await startReviewTarget(target);
    },
    [
      activeWorkspace,
      openReviewPrompt,
      startReviewTarget,
    ],
  );

  const startStatus = useCallback(
    async (_text: string) => {
      if (!activeWorkspace) {
        return;
      }
      const threadId = await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return;
      }

      const rateLimits = rateLimitsByWorkspace[activeWorkspace.id] ?? null;
      const primaryUsed = rateLimits?.primary?.usedPercent;
      const secondaryUsed = rateLimits?.secondary?.usedPercent;
      const primaryReset = rateLimits?.primary?.resetsAt;
      const secondaryReset = rateLimits?.secondary?.resetsAt;
      const credits = rateLimits?.credits ?? null;

      const normalizeReset = (value?: number | null) => {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return null;
        }
        return value > 1_000_000_000_000 ? value : value * 1000;
      };

      const resetLabel = (value?: number | null) => {
        const resetAt = normalizeReset(value);
        return resetAt ? formatRelativeTime(resetAt) : null;
      };

      const collabId =
        collaborationMode &&
        typeof collaborationMode === "object" &&
        "settings" in collaborationMode &&
        collaborationMode.settings &&
        typeof collaborationMode.settings === "object" &&
        "id" in collaborationMode.settings
          ? String(collaborationMode.settings.id ?? "")
          : "";

      const lines = [
        "Session status:",
        `- Model: ${model ?? "default"}`,
        `- Reasoning effort: ${effort ?? "default"}`,
        `- Access: ${accessMode ?? "current"}`,
        `- Collaboration: ${collabId || "off"}`,
      ];

      if (typeof primaryUsed === "number") {
        const reset = resetLabel(primaryReset);
        lines.push(
          `- Session usage: ${Math.round(primaryUsed)}%${
            reset ? ` (resets ${reset})` : ""
          }`,
        );
      }
      if (typeof secondaryUsed === "number") {
        const reset = resetLabel(secondaryReset);
        lines.push(
          `- Weekly usage: ${Math.round(secondaryUsed)}%${
            reset ? ` (resets ${reset})` : ""
          }`,
        );
      }
      if (credits?.hasCredits) {
        if (credits.unlimited) {
          lines.push("- Credits: unlimited");
        } else if (credits.balance) {
          lines.push(`- Credits: ${credits.balance}`);
        }
      }

      const timestamp = Date.now();
      recordThreadActivity(activeWorkspace.id, threadId, timestamp);
      dispatch({
        type: "addAssistantMessage",
        threadId,
        text: lines.join("\n"),
      });
      safeMessageActivity();
    },
    [
      accessMode,
      activeWorkspace,
      collaborationMode,
      dispatch,
      effort,
      ensureThreadForActiveWorkspace,
      model,
      rateLimitsByWorkspace,
      recordThreadActivity,
      safeMessageActivity,
    ],
  );

  const startMcp = useCallback(
    async (_text: string) => {
      if (!activeWorkspace) {
        return;
      }
      const threadId = await ensureThreadForActiveWorkspace();
      if (!threadId) {
        return;
      }

      try {
        const response = (await listMcpServerStatusService(
          activeWorkspace.id,
          null,
          null,
        )) as Record<string, unknown> | null;
        const result = (response?.result ?? response) as
          | Record<string, unknown>
          | null;
        const data = Array.isArray(result?.data)
          ? (result?.data as Array<Record<string, unknown>>)
          : [];

        const lines: string[] = ["MCP tools:"];
        if (data.length === 0) {
          lines.push("- No MCP servers configured.");
        } else {
          const servers = [...data].sort((a, b) =>
            String(a.name ?? "").localeCompare(String(b.name ?? "")),
          );
          for (const server of servers) {
            const name = String(server.name ?? "unknown");
            const authStatus = server.authStatus ?? server.auth_status ?? null;
            const authLabel =
              typeof authStatus === "string"
                ? authStatus
                : authStatus &&
                    typeof authStatus === "object" &&
                    "status" in authStatus
                  ? String((authStatus as { status?: unknown }).status ?? "")
                  : "";
            lines.push(`- ${name}${authLabel ? ` (auth: ${authLabel})` : ""}`);

            const toolsRecord =
              server.tools && typeof server.tools === "object"
                ? (server.tools as Record<string, unknown>)
                : {};
            const prefix = `mcp__${name}__`;
            const toolNames = Object.keys(toolsRecord)
              .map((toolName) =>
                toolName.startsWith(prefix)
                  ? toolName.slice(prefix.length)
                  : toolName,
              )
              .sort((a, b) => a.localeCompare(b));
            lines.push(
              toolNames.length > 0
                ? `  tools: ${toolNames.join(", ")}`
                : "  tools: none",
            );

            const resources = Array.isArray(server.resources)
              ? server.resources.length
              : 0;
            const templates = Array.isArray(server.resourceTemplates)
              ? server.resourceTemplates.length
              : Array.isArray(server.resource_templates)
                ? server.resource_templates.length
                : 0;
            if (resources > 0 || templates > 0) {
              lines.push(`  resources: ${resources}, templates: ${templates}`);
            }
          }
        }

        const timestamp = Date.now();
        recordThreadActivity(activeWorkspace.id, threadId, timestamp);
        dispatch({
          type: "addAssistantMessage",
          threadId,
          text: lines.join("\n"),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to load MCP status.";
        dispatch({
          type: "addAssistantMessage",
          threadId,
          text: `MCP tools:\n- ${message}`,
        });
      } finally {
        safeMessageActivity();
      }
    },
    [
      activeWorkspace,
      dispatch,
      ensureThreadForActiveWorkspace,
      recordThreadActivity,
      safeMessageActivity,
    ],
  );

  const startFork = useCallback(
    async (text: string) => {
      if (!activeWorkspace || !activeThreadId) {
        return;
      }
      const trimmed = text.trim();
      const rest = trimmed.replace(/^\/fork\b/i, "").trim();
      const threadId = await forkThreadForWorkspace(activeWorkspace.id, activeThreadId);
      if (!threadId) {
        return;
      }
      updateThreadParent(activeThreadId, [threadId]);
      if (rest) {
        await sendMessageToThread(activeWorkspace, threadId, rest, []);
      }
    },
    [
      activeThreadId,
      activeWorkspace,
      forkThreadForWorkspace,
      sendMessageToThread,
      updateThreadParent,
    ],
  );

  const startResume = useCallback(
    async (_text: string) => {
      if (!activeWorkspace) {
        return;
      }
      if (activeThreadId && threadStatusById[activeThreadId]?.isProcessing) {
        return;
      }
      const threadId = activeThreadId ?? (await ensureThreadForActiveWorkspace());
      if (!threadId) {
        return;
      }
      await refreshThread(activeWorkspace.id, threadId);
      safeMessageActivity();
    },
    [
      activeThreadId,
      activeWorkspace,
      ensureThreadForActiveWorkspace,
      refreshThread,
      safeMessageActivity,
      threadStatusById,
    ],
  );

  return {
    interruptTurn,
    sendUserMessage,
    sendUserMessageToThread,
    startFork,
    startReview,
    startResume,
    startMcp,
    startStatus,
    reviewPrompt,
    openReviewPrompt,
    closeReviewPrompt,
    showPresetStep,
    choosePreset,
    highlightedPresetIndex,
    setHighlightedPresetIndex,
    highlightedBranchIndex,
    setHighlightedBranchIndex,
    highlightedCommitIndex,
    setHighlightedCommitIndex,
    handleReviewPromptKeyDown,
    confirmBranch,
    selectBranch,
    selectBranchAtIndex,
    selectCommit,
    selectCommitAtIndex,
    confirmCommit,
    updateCustomInstructions,
    confirmCustom,
  };
}
