import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Plus from "lucide-react/dist/esm/icons/plus";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import X from "lucide-react/dist/esm/icons/x";
import { Markdown } from "../../messages/components/Markdown";
import type {
  LocalUsageSnapshot,
  TaskEntry,
  TaskStatus,
  TaskView,
} from "../../../types";
import { formatRelativeTime } from "../../../utils/time";
import { useGitHubIssuesByWorkspaceId } from "../../git/hooks/useGitHubIssues";

type ExternalRef = {
  label: string;
  url: string;
};

const extractExternalRefs = (content: string): ExternalRef[] => {
  const refs: ExternalRef[] = [];
  const seen = new Set<string>();

  const githubIssueRegex =
    /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)(?:[^\s]*)/gi;
  const linearIssueRegex =
    /https?:\/\/linear\.app\/[^/\s]+\/issue\/([A-Z][A-Z0-9]+-\d+)(?:[^\s]*)/g;

  const push = (label: string, url: string) => {
    if (seen.has(url)) {
      return;
    }
    seen.add(url);
    refs.push({ label, url });
  };

  for (const match of content.matchAll(githubIssueRegex)) {
    const url = match[0];
    const number = match[1];
    push(`GH #${number}`, url);
  }

  for (const match of content.matchAll(linearIssueRegex)) {
    const url = match[0];
    const key = match[1];
    push(key, url);
  }

  return refs;
};

type LatestAgentRun = {
  message: string;
  timestamp: number;
  projectName: string;
  groupName?: string | null;
  workspaceId: string;
  threadId: string;
  isProcessing: boolean;
};

type UsageMetric = "tokens" | "time";

type UsageWorkspaceOption = {
  id: string;
  label: string;
};

type TaskWorkspaceOption = {
  id: string;
  label: string;
};

type TaskDialogState =
  | {
      mode: "create";
      workspaceId: string | null;
      status: TaskStatus;
      title: string;
      content: string;
      showGitHubIssues: boolean;
    }
  | {
      mode: "edit";
      id: string;
      workspaceId: string | null;
      status: TaskStatus;
      title: string;
      content: string;
      showGitHubIssues: boolean;
    };

type HomeProps = {
  onOpenProject: () => void;
  onAddWorkspace: () => void;
  latestAgentRuns: LatestAgentRun[];
  isLoadingLatestAgents: boolean;
  localUsageSnapshot: LocalUsageSnapshot | null;
  isLoadingLocalUsage: boolean;
  localUsageError: string | null;
  onRefreshLocalUsage: () => void;
  usageMetric: UsageMetric;
  onUsageMetricChange: (metric: UsageMetric) => void;
  usageWorkspaceId: string | null;
  usageWorkspaceOptions: UsageWorkspaceOption[];
  onUsageWorkspaceChange: (workspaceId: string | null) => void;
  tasks: TaskEntry[];
  isLoadingTasks: boolean;
  tasksError: string | null;
  tasksView: TaskView;
  onTasksViewChange: (view: TaskView) => void;
  tasksWorkspaceId: string | null;
  tasksWorkspaceOptions: TaskWorkspaceOption[];
  onTasksWorkspaceChange: (workspaceId: string | null) => void;
  onTaskCreate: (input: {
    title: string;
    content: string;
    workspaceId?: string | null;
  }) => Promise<void>;
  onTaskUpdate: (input: {
    id: string;
    title: string;
    content: string;
  }) => Promise<void>;
  onTaskDelete: (id: string) => void | Promise<void>;
  onTaskStatusChange: (id: string, status: TaskStatus) => Promise<void>;
  onSelectThread: (workspaceId: string, threadId: string) => void;
};

export function Home({
  onOpenProject,
  onAddWorkspace,
  latestAgentRuns,
  isLoadingLatestAgents,
  localUsageSnapshot,
  isLoadingLocalUsage,
  localUsageError,
  onRefreshLocalUsage,
  usageMetric,
  onUsageMetricChange,
  usageWorkspaceId,
  usageWorkspaceOptions,
  onUsageWorkspaceChange,
  tasks,
  isLoadingTasks,
  tasksError,
  tasksView,
  onTasksViewChange,
  tasksWorkspaceId,
  tasksWorkspaceOptions,
  onTasksWorkspaceChange,
  onTaskCreate,
  onTaskUpdate,
  onTaskDelete,
  onTaskStatusChange,
  onSelectThread,
}: HomeProps) {
  const [activeTab, setActiveTab] = useState<"tasks" | "usage">("tasks");
  const [taskQuery, setTaskQuery] = useState("");
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [taskDialog, setTaskDialog] = useState<TaskDialogState | null>(null);
  const [githubIssueDraft, setGitHubIssueDraft] = useState("");
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);
  const [isPointerDraggingTask, setIsPointerDraggingTask] = useState(false);
  const pointerDragRef = useRef<{
    taskId: string;
    fromStatus: TaskStatus;
    pointerId: number;
    startX: number;
    startY: number;
    hasMoved: boolean;
  } | null>(null);

  const taskWorkspaceLabelById = useMemo(() => {
    const map = new Map<string, string>();
    tasksWorkspaceOptions.forEach((option) => {
      if (!option.id) {
        return;
      }
      map.set(option.id, option.label);
    });
    return map;
  }, [tasksWorkspaceOptions]);

  const visibleTasks = useMemo(() => {
    const query = taskQuery.trim().toLowerCase();
    const filtered = query
      ? tasks.filter((task) => {
          const title = task.title.toLowerCase();
          const content = (task.content ?? "").toLowerCase();
          return title.includes(query) || content.includes(query);
        })
      : tasks;

    const sorted = [...filtered];
    // Default: updated desc.
    sorted.sort((a, b) => b.updatedAt - a.updatedAt);
    return sorted;
  }, [taskQuery, tasks]);

  const tasksByStatus = useMemo(() => {
    const grouped: Record<TaskStatus, TaskEntry[]> = {
      todo: [],
      doing: [],
      done: [],
    };
    visibleTasks.forEach((task) => {
      grouped[task.status].push(task);
    });
    return grouped;
  }, [visibleTasks]);

  const taskComposerWorkspaceId = taskDialog?.workspaceId ?? tasksWorkspaceId ?? null;
  const {
    issues: githubIssues,
    isLoading: githubIssuesLoading,
    error: githubIssuesError,
    refresh: refreshGitHubIssues,
  } = useGitHubIssuesByWorkspaceId(
    taskDialog ? taskComposerWorkspaceId : null,
    false,
  );

  const handleLoadGitHubIssues = async () => {
    if (!taskDialog) {
      return;
    }
    if (!taskComposerWorkspaceId) {
      return;
    }
    setTaskDialog((prev) => (prev ? { ...prev, showGitHubIssues: true } : prev));
    setGitHubIssueDraft("");
    await refreshGitHubIssues();
  };

  const closeTaskDialog = () => {
    setTaskDialog(null);
    setGitHubIssueDraft("");
  };

  useEffect(() => {
    if (!taskDialog) {
      return;
    }

    // Avoid scrolling the underlying page while a modal is open.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [taskDialog]);

  useEffect(() => {
    if (!isPointerDraggingTask) {
      return;
    }

    const getStatusFromPoint = (x: number, y: number): TaskStatus | null => {
      const element = document.elementFromPoint(x, y) as HTMLElement | null;
      const column = element?.closest?.(".home-tasks-column") as HTMLElement | null;
      const next = column?.dataset?.status ?? null;
      if (next === "todo" || next === "doing" || next === "done") {
        return next;
      }
      return null;
    };

    const handlePointerMove = (event: PointerEvent) => {
      const state = pointerDragRef.current;
      if (!state || event.pointerId !== state.pointerId) {
        return;
      }

      const dx = event.clientX - state.startX;
      const dy = event.clientY - state.startY;
      if (!state.hasMoved && dx * dx + dy * dy < 16) {
        return;
      }
      if (!state.hasMoved) {
        state.hasMoved = true;
      }

      setDragOverStatus(getStatusFromPoint(event.clientX, event.clientY));
    };

    const handlePointerUp = (event: PointerEvent) => {
      const state = pointerDragRef.current;
      if (!state || event.pointerId !== state.pointerId) {
        return;
      }

      const nextStatus = getStatusFromPoint(event.clientX, event.clientY);
      pointerDragRef.current = null;
      setIsPointerDraggingTask(false);
      setDraggingTaskId(null);
      setDragOverStatus(null);

      if (!state.hasMoved || !nextStatus || nextStatus === state.fromStatus) {
        return;
      }
      void onTaskStatusChange(state.taskId, nextStatus);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isPointerDraggingTask, onTaskStatusChange]);

  const toggleTaskExpanded = (taskId: string) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const openCreateTaskDialog = () => {
    setTaskDialog({
      mode: "create",
      workspaceId: tasksWorkspaceId ?? null,
      status: "todo",
      title: "",
      content: "",
      showGitHubIssues: false,
    });
    setGitHubIssueDraft("");
  };

  const openEditTaskDialog = (task: TaskEntry) => {
    setTaskDialog({
      mode: "edit",
      id: task.id,
      workspaceId: task.workspaceId ?? null,
      status: task.status,
      title: task.title,
      content: task.content ?? "",
      showGitHubIssues: false,
    });
    setGitHubIssueDraft("");
  };

  const canSaveTaskDialog = Boolean(taskDialog?.title.trim());

  const saveTaskDialog = async () => {
    if (!taskDialog || !canSaveTaskDialog) {
      return;
    }
    const title = taskDialog.title.trim();
    const content = taskDialog.content;
    if (taskDialog.mode === "create") {
      await onTaskCreate({ title, content, workspaceId: taskDialog.workspaceId });
      closeTaskDialog();
      return;
    }

    // Update title/content first; status change is separate.
    await onTaskUpdate({ id: taskDialog.id, title, content });
    if (taskDialog.status) {
      await onTaskStatusChange(taskDialog.id, taskDialog.status);
    }
    closeTaskDialog();
  };
  const formatCompactNumber = (value: number | null | undefined) => {
    if (value === null || value === undefined) {
      return "--";
    }
    if (value >= 1_000_000_000) {
      const scaled = value / 1_000_000_000;
      return `${scaled.toFixed(scaled >= 10 ? 0 : 1)}b`;
    }
    if (value >= 1_000_000) {
      const scaled = value / 1_000_000;
      return `${scaled.toFixed(scaled >= 10 ? 0 : 1)}m`;
    }
    if (value >= 1_000) {
      const scaled = value / 1_000;
      return `${scaled.toFixed(scaled >= 10 ? 0 : 1)}k`;
    }
    return String(value);
  };

  const formatCount = (value: number | null | undefined) => {
    if (value === null || value === undefined) {
      return "--";
    }
    return new Intl.NumberFormat().format(value);
  };

  const formatDuration = (valueMs: number | null | undefined) => {
    if (valueMs === null || valueMs === undefined) {
      return "--";
    }
    const totalSeconds = Math.max(0, Math.round(valueMs / 1000));
    const totalMinutes = Math.floor(totalSeconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    if (totalMinutes > 0) {
      return `${totalMinutes}m`;
    }
    return `${totalSeconds}s`;
  };

  const formatDurationCompact = (valueMs: number | null | undefined) => {
    if (valueMs === null || valueMs === undefined) {
      return "--";
    }
    const totalMinutes = Math.max(0, Math.round(valueMs / 60000));
    if (totalMinutes >= 60) {
      const hours = totalMinutes / 60;
      return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
    }
    if (totalMinutes > 0) {
      return `${totalMinutes}m`;
    }
    const seconds = Math.max(0, Math.round(valueMs / 1000));
    return `${seconds}s`;
  };

  const formatDayLabel = (value: string | null | undefined) => {
    if (!value) {
      return "--";
    }
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) {
      return value;
    }
    const date = new Date(year, month - 1, day);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(date);
  };

  const usageTotals = localUsageSnapshot?.totals ?? null;
  const usageDays = localUsageSnapshot?.days ?? [];
  const last7Days = usageDays.slice(-7);
  const last7AgentMs = last7Days.reduce(
    (total, day) => total + (day.agentTimeMs ?? 0),
    0,
  );
  const last30AgentMs = usageDays.reduce(
    (total, day) => total + (day.agentTimeMs ?? 0),
    0,
  );
  const averageDailyAgentMs =
    last7Days.length > 0 ? Math.round(last7AgentMs / last7Days.length) : 0;
  const last7AgentRuns = last7Days.reduce(
    (total, day) => total + (day.agentRuns ?? 0),
    0,
  );
  const peakAgentDay = usageDays.reduce<
    | { day: string; agentTimeMs: number }
    | null
  >((best, day) => {
    const value = day.agentTimeMs ?? 0;
    if (value <= 0) {
      return best;
    }
    if (!best || value > best.agentTimeMs) {
      return { day: day.day, agentTimeMs: value };
    }
    return best;
  }, null);
  const peakAgentDayLabel = peakAgentDay?.day ?? null;
  const peakAgentTimeMs = peakAgentDay?.agentTimeMs ?? 0;
  const maxUsageValue = Math.max(
    1,
    ...last7Days.map((day) =>
      usageMetric === "tokens" ? day.totalTokens : day.agentTimeMs ?? 0,
    ),
  );
  const updatedLabel = localUsageSnapshot
    ? `Updated ${formatRelativeTime(localUsageSnapshot.updatedAt)}`
    : null;
  const showUsageSkeleton = isLoadingLocalUsage && !localUsageSnapshot;
  const showUsageEmpty = !isLoadingLocalUsage && !localUsageSnapshot;
  const showTasksEmpty = !isLoadingTasks && visibleTasks.length === 0;

  return (
    <div className="home">
      <div className="home-hero">
        <div className="home-title">Fridex</div>
        <div className="home-subtitle">
          Orchestrate agents across your local projects.
        </div>
      </div>
      <div className="home-latest">
        <div className="home-latest-header">
          <div className="home-latest-label">Latest agents</div>
        </div>
        {latestAgentRuns.length > 0 ? (
          <div className="home-latest-grid">
            {latestAgentRuns.map((run) => (
              <button
                className="home-latest-card home-latest-card-button"
                key={run.threadId}
                onClick={() => onSelectThread(run.workspaceId, run.threadId)}
                type="button"
              >
                <div className="home-latest-card-header">
                  <div className="home-latest-project">
                    <span className="home-latest-project-name">{run.projectName}</span>
                    {run.groupName && (
                      <span className="home-latest-group">{run.groupName}</span>
                    )}
                  </div>
                  <div className="home-latest-time">
                    {formatRelativeTime(run.timestamp)}
                  </div>
                </div>
                <div className="home-latest-message">
                  {run.message.trim() || "Agent replied."}
                </div>
                {run.isProcessing && (
                  <div className="home-latest-status">Running</div>
                )}
              </button>
            ))}
          </div>
        ) : isLoadingLatestAgents ? (
          <div className="home-latest-grid home-latest-grid-loading" aria-label="Loading agents">
            {Array.from({ length: 3 }).map((_, index) => (
              <div className="home-latest-card home-latest-card-skeleton" key={index}>
                <div className="home-latest-card-header">
                  <span className="home-latest-skeleton home-latest-skeleton-title" />
                  <span className="home-latest-skeleton home-latest-skeleton-time" />
                </div>
                <span className="home-latest-skeleton home-latest-skeleton-line" />
                <span className="home-latest-skeleton home-latest-skeleton-line short" />
              </div>
            ))}
          </div>
        ) : (
          <div className="home-latest-empty">
            <div className="home-latest-empty-title">No agent activity yet</div>
            <div className="home-latest-empty-subtitle">
              Start a thread to see the latest responses here.
            </div>
          </div>
        )}
      </div>
      <div className="home-actions">
        <button
          className="home-button primary"
          onClick={onOpenProject}
          data-tauri-drag-region="false"
        >
          <span className="home-icon" aria-hidden>
            ⌘
          </span>
          Open Project
        </button>
        <button
          className="home-button secondary"
          onClick={onAddWorkspace}
          data-tauri-drag-region="false"
        >
          <span className="home-icon" aria-hidden>
            +
          </span>
          Add Workspace
        </button>
      </div>
      <div className="home-primary">
        <div className="home-primary-tabs" role="tablist" aria-label="Home tabs">
          <button
            type="button"
            className={
              activeTab === "tasks"
                ? "home-primary-tab is-active"
                : "home-primary-tab"
            }
            role="tab"
            aria-selected={activeTab === "tasks"}
            onClick={() => setActiveTab("tasks")}
          >
            Tasks
          </button>
          <button
            type="button"
            className={
              activeTab === "usage"
                ? "home-primary-tab is-active"
                : "home-primary-tab"
            }
            role="tab"
            aria-selected={activeTab === "usage"}
            onClick={() => setActiveTab("usage")}
          >
            Usage
          </button>
        </div>
        {activeTab === "tasks" ? (
          <div className="home-tasks" role="tabpanel">
            <div className="home-section-header home-section-header--compact">
              <div className="home-tasks-controls">
                <div className="home-tasks-controls-left">
                  <div
                    className="home-usage-toggle"
                    role="group"
                    aria-label="Task view"
                  >
                    <button
                      className={`home-usage-toggle-button${
                        tasksView === "checklist" ? " is-active" : ""
                      }`}
                      type="button"
                      onClick={() => onTasksViewChange("checklist")}
                    >
                      Checklist
                    </button>
                    <button
                      className={`home-usage-toggle-button${
                        tasksView === "kanban" ? " is-active" : ""
                      }`}
                      type="button"
                      onClick={() => onTasksViewChange("kanban")}
                    >
                      Kanban
                    </button>
                  </div>
                  <div className="home-usage-select-wrap">
                    <select
                      className="home-usage-select"
                      value={tasksWorkspaceId ?? ""}
                      onChange={(event) =>
                        onTasksWorkspaceChange(event.target.value || null)
                      }
                      aria-label="Filter tasks by project"
                    >
                      {tasksWorkspaceOptions.map((option) => (
                        <option key={option.id || "all"} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="home-tasks-controls-right">
                  <div className="home-usage-select-wrap home-tasks-search-wrap">
                    <input
                      className="home-tasks-search-input"
                      value={taskQuery}
                      onChange={(event) => setTaskQuery(event.target.value)}
                      placeholder="Search tasks…"
                      aria-label="Search tasks"
                    />
                  </div>
                  <button
                    className="home-tasks-new-button"
                    type="button"
                    onClick={openCreateTaskDialog}
                    aria-label="Add task"
                  >
                    <Plus size={14} aria-hidden />
                    New
                  </button>
                </div>
              </div>
            </div>
            {isLoadingTasks ? (
              <div className="home-tasks-loading">Loading tasks...</div>
            ) : showTasksEmpty ? (
              <div className="home-tasks-empty">
                <div className="home-tasks-empty-title">No tasks yet</div>
                <div className="home-tasks-empty-subtitle">
                  Capture your next step and keep it visible here.
                </div>
              </div>
            ) : tasksView === "checklist" ? (
              <div className="home-tasks-list">
                {visibleTasks.map((task) => (
                  <div className="home-tasks-item" key={task.id}>
                    <div className="home-tasks-row">
                      <label className="home-tasks-checkbox">
                        <input
                          type="checkbox"
                          checked={task.status === "done"}
                          onChange={(event) =>
                            onTaskStatusChange(
                              task.id,
                              event.target.checked ? "done" : "todo",
                            )
                          }
                        />
                        <span className="home-tasks-title">{task.title}</span>
                      </label>
                      <div className="home-tasks-item-actions">
                        <button
                          type="button"
                          className="ghost icon-button home-tasks-icon-action"
                          onClick={() => openEditTaskDialog(task)}
                          aria-label="Edit task"
                          title="Edit"
                        >
                          <Pencil size={14} aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="ghost icon-button home-tasks-icon-action"
                          onClick={() => onTaskDelete(task.id)}
                          aria-label="Remove task"
                          title="Remove"
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                        {task.content && (
                          <button
                            type="button"
                            className={`home-tasks-expand${expandedTasks.has(task.id) ? " is-expanded" : ""}`}
                            onClick={() => toggleTaskExpanded(task.id)}
                            aria-label={expandedTasks.has(task.id) ? "Collapse" : "Expand"}
                          >
                            <ChevronDown size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="home-tasks-meta">
                      <span className={`home-tasks-status home-tasks-status--${task.status}`}>
                        {task.status === "todo"
                          ? "To do"
                          : task.status === "doing"
                            ? "Doing"
                            : "Done"}
                      </span>
                      {!tasksWorkspaceId && (
                        <span className="home-tasks-project">
                          {task.workspaceId
                            ? taskWorkspaceLabelById.get(task.workspaceId) ?? "Unknown project"
                            : "Global"}
                        </span>
                      )}
                      {extractExternalRefs(task.content).map((ref) => (
                        <a
                          key={ref.url}
                          className="home-tasks-ref"
                          href={ref.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {ref.label}
                        </a>
                      ))}
                      <span className="home-tasks-updated">
                        Updated {formatRelativeTime(task.updatedAt)}
                      </span>
                    </div>
                    {task.content && expandedTasks.has(task.id) && (
                      <Markdown value={task.content} className="home-tasks-content" />
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="home-tasks-board">
                {(["todo", "doing", "done"] as TaskStatus[]).map((status) => (
                  <div
                    className={`home-tasks-column${
                      draggingTaskId && dragOverStatus === status ? " is-drop-target" : ""
                    }`}
                    key={status}
                    data-status={status}
                  >
                    <div className="home-tasks-column-title">
                      {(status === "todo"
                        ? "To do"
                        : status === "doing"
                          ? "Doing"
                          : "Done") + ` (${tasksByStatus[status].length})`}
                    </div>
                    <div className="home-tasks-column-list">
                      {tasksByStatus[status].map((task) => (
                        <div
                          className={`home-tasks-card${
                            isPointerDraggingTask && draggingTaskId === task.id
                              ? " is-dragging"
                              : ""
                          }`}
                          key={task.id}
                          onPointerDown={(event) => {
                            if (event.button !== 0) {
                              return;
                            }

                            const target = event.target as HTMLElement | null;
                            if (
                              target?.closest?.(
                                "button, a, input, textarea, select, [role='button']",
                              )
                            ) {
                              return;
                            }

                            pointerDragRef.current = {
                              taskId: task.id,
                              fromStatus: task.status,
                              pointerId: event.pointerId,
                              startX: event.clientX,
                              startY: event.clientY,
                              hasMoved: false,
                            };
                            setDraggingTaskId(task.id);
                            setDragOverStatus(status);
                            setIsPointerDraggingTask(true);
                            (event.currentTarget as HTMLElement).setPointerCapture?.(
                              event.pointerId,
                            );
                          }}
                        >
                          <div className="home-tasks-card-header">
                            <div className="home-tasks-card-title">{task.title}</div>
                            <div className="home-tasks-item-actions">
                              <button
                                type="button"
                                className="ghost icon-button home-tasks-icon-action"
                                onClick={() => openEditTaskDialog(task)}
                                aria-label="Edit task"
                                title="Edit"
                              >
                                <Pencil size={14} aria-hidden />
                              </button>
                              <button
                                type="button"
                                className="ghost icon-button home-tasks-icon-action"
                                onClick={() => onTaskDelete(task.id)}
                                aria-label="Remove task"
                                title="Remove"
                              >
                                <Trash2 size={14} aria-hidden />
                              </button>
                              {task.content && (
                                <button
                                  type="button"
                                  className={`home-tasks-expand${expandedTasks.has(task.id) ? " is-expanded" : ""}`}
                                  onClick={() => toggleTaskExpanded(task.id)}
                                  aria-label={expandedTasks.has(task.id) ? "Collapse" : "Expand"}
                                >
                                  <ChevronDown size={14} />
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="home-tasks-meta">
                            {!tasksWorkspaceId && (
                              <span className="home-tasks-project">
                                {task.workspaceId
                                  ? taskWorkspaceLabelById.get(task.workspaceId) ?? "Unknown project"
                                  : "Global"}
                              </span>
                            )}
                            {extractExternalRefs(task.content).map((ref) => (
                              <a
                                key={ref.url}
                                className="home-tasks-ref"
                                href={ref.url}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {ref.label}
                              </a>
                            ))}
                            <span className="home-tasks-updated">
                              Updated {formatRelativeTime(task.updatedAt)}
                            </span>
                          </div>
                          {task.content && expandedTasks.has(task.id) && (
                            <Markdown
                              value={task.content}
                              className="home-tasks-card-content"
                            />
                          )}
                        </div>
                      ))}
                      {tasksByStatus[status].length === 0 && (
                        <div className="home-tasks-column-empty">No tasks</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {taskDialog &&
              createPortal(
                <div
                  className="home-task-dialog-backdrop"
                  role="presentation"
                  onMouseDown={(event) => {
                    if (event.target === event.currentTarget) {
                      closeTaskDialog();
                    }
                  }}
                >
                  <div
                    className="home-task-dialog"
                    role="dialog"
                    aria-modal="true"
                    aria-label={taskDialog.mode === "create" ? "New task" : "Edit task"}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        closeTaskDialog();
                        return;
                      }
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        void saveTaskDialog();
                      }
                    }}
                  >
                    <div className="home-task-dialog-header">
                      <div className="home-task-dialog-title">
                        {taskDialog.mode === "create" ? "New task" : "Edit task"}
                      </div>
                      <button
                        type="button"
                        className="ghost icon-button"
                        onClick={closeTaskDialog}
                        aria-label="Close"
                        title="Close"
                      >
                        <X size={14} aria-hidden />
                      </button>
                    </div>

                    <div className="home-task-dialog-body">
                      <div className="home-task-dialog-row">
                        <div className="home-task-dialog-field">
                          <div className="home-task-dialog-label">Status</div>
                          <div className="home-task-dialog-status">
                            {(["todo", "doing", "done"] as TaskStatus[]).map((status) => (
                              <button
                                key={status}
                                type="button"
                                className={
                                  taskDialog.status === status
                                    ? "home-task-dialog-status-button is-active"
                                    : "home-task-dialog-status-button"
                                }
                                onClick={() =>
                                  setTaskDialog((prev) =>
                                    prev ? { ...prev, status } : prev,
                                  )
                                }
                                aria-pressed={taskDialog.status === status}
                              >
                                {status === "todo"
                                  ? "To do"
                                  : status === "doing"
                                    ? "Doing"
                                    : "Done"}
                              </button>
                            ))}
                          </div>
                        </div>

                        {taskDialog.mode === "create" ? (
                          <div className="home-task-dialog-field">
                            <div className="home-task-dialog-label">Project</div>
                            <select
                              className="home-task-dialog-select"
                              value={taskDialog.workspaceId ?? ""}
                              onChange={(event) => {
                                const next = event.target.value || null;
                                setTaskDialog((prev) =>
                                  prev ? { ...prev, workspaceId: next } : prev,
                                );
                              }}
                            >
                              <option value="">Global</option>
                              {tasksWorkspaceOptions
                                .filter((option) => option.id)
                                .map((option) => (
                                  <option key={option.id} value={option.id}>
                                    {option.label}
                                  </option>
                                ))}
                            </select>
                          </div>
                        ) : (
                          <div className="home-task-dialog-field">
                            <div className="home-task-dialog-label">Project</div>
                            <div className="home-task-dialog-static">
                              {taskDialog.workspaceId
                                ? taskWorkspaceLabelById.get(taskDialog.workspaceId) ??
                                  "Unknown"
                                : "Global"}
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="home-task-dialog-field">
                        <div className="home-task-dialog-label">Title</div>
                        <input
                          className="home-task-dialog-input"
                          value={taskDialog.title}
                          onChange={(event) =>
                            setTaskDialog((prev) =>
                              prev ? { ...prev, title: event.target.value } : prev,
                            )
                          }
                          placeholder="What needs to get done?"
                        />
                      </div>

                      <div className="home-task-dialog-field">
                        <div className="home-task-dialog-label">Details</div>
                        <textarea
                          className="home-task-dialog-textarea"
                          value={taskDialog.content}
                          onChange={(event) =>
                            setTaskDialog((prev) =>
                              prev ? { ...prev, content: event.target.value } : prev,
                            )
                          }
                          placeholder="Add context, links, acceptance criteria…"
                          rows={8}
                        />
                      </div>

                      <div className="home-task-dialog-field">
                        <div className="home-task-dialog-label">GitHub issues</div>
                        <div className="home-task-dialog-inline">
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => void handleLoadGitHubIssues()}
                            disabled={!taskDialog.workspaceId || githubIssuesLoading}
                          >
                            {githubIssuesLoading ? "Loading…" : "Load"}
                          </button>
                          {githubIssuesError && (
                            <span className="home-tasks-error">{githubIssuesError}</span>
                          )}
                        </div>
                        {taskDialog.showGitHubIssues && githubIssues.length > 0 && (
                          <div className="home-task-dialog-issues">
                            {githubIssues.map((issue) => (
                              <button
                                key={issue.url}
                                type="button"
                                className={
                                  githubIssueDraft === String(issue.number)
                                    ? "home-task-dialog-issue is-active"
                                    : "home-task-dialog-issue"
                                }
                                onClick={() => {
                                  setGitHubIssueDraft(String(issue.number));
                                  setTaskDialog((prev) => {
                                    if (!prev) {
                                      return prev;
                                    }
                                    const linkLine = `GitHub: ${issue.url}`;
                                    const nextContent = prev.content.includes(issue.url)
                                      ? prev.content
                                      : prev.content.trim().length > 0
                                        ? `${linkLine}\n\n${prev.content.trim()}`
                                        : linkLine;
                                    return {
                                      ...prev,
                                      title: issue.title,
                                      content: nextContent,
                                    };
                                  });
                                }}
                              >
                                <span className="home-task-dialog-issue-number">
                                  #{issue.number}
                                </span>
                                <span className="home-task-dialog-issue-title">
                                  {issue.title}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                        {!taskDialog.workspaceId && (
                          <div className="home-task-dialog-hint">
                            Select a project to load GitHub issues.
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="home-task-dialog-actions">
                      {tasksError && <div className="home-tasks-error">{tasksError}</div>}
                      <button type="button" className="ghost" onClick={closeTaskDialog}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => void saveTaskDialog()}
                        disabled={!canSaveTaskDialog}
                      >
                        {taskDialog.mode === "create" ? "Create" : "Save"}
                      </button>
                    </div>
                  </div>
                </div>,
                document.body,
              )}
          </div>
        ) : (
          <div className="home-usage" role="tabpanel">
            <div className="home-section-header">
              <div className="home-section-title">Usage snapshot</div>
              <div className="home-section-meta-row">
                {updatedLabel && (
                  <div className="home-section-meta">{updatedLabel}</div>
                )}
                <button
                  type="button"
                  className={
                    isLoadingLocalUsage
                      ? "home-usage-refresh is-loading"
                      : "home-usage-refresh"
                  }
                  onClick={onRefreshLocalUsage}
                  disabled={isLoadingLocalUsage}
                  aria-label="Refresh usage"
                  title="Refresh usage"
                >
                  <RefreshCw
                    className={
                      isLoadingLocalUsage
                        ? "home-usage-refresh-icon spinning"
                        : "home-usage-refresh-icon"
                    }
                    aria-hidden
                  />
                </button>
              </div>
            </div>
            <div className="home-usage-controls">
              <div className="home-usage-control-group">
                <span className="home-usage-control-label">Workspace</span>
                <div className="home-usage-select-wrap">
                  <select
                    className="home-usage-select"
                    value={usageWorkspaceId ?? ""}
                    onChange={(event) =>
                      onUsageWorkspaceChange(event.target.value || null)
                    }
                    disabled={usageWorkspaceOptions.length === 0}
                  >
                    <option value="">All workspaces</option>
                    {usageWorkspaceOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="home-usage-control-group">
                <span className="home-usage-control-label">View</span>
                <div
                  className="home-usage-toggle"
                  role="group"
                  aria-label="Usage view"
                >
                  <button
                    type="button"
                    className={
                      usageMetric === "tokens"
                        ? "home-usage-toggle-button is-active"
                        : "home-usage-toggle-button"
                    }
                    onClick={() => onUsageMetricChange("tokens")}
                    aria-pressed={usageMetric === "tokens"}
                  >
                    Tokens
                  </button>
                  <button
                    type="button"
                    className={
                      usageMetric === "time"
                        ? "home-usage-toggle-button is-active"
                        : "home-usage-toggle-button"
                    }
                    onClick={() => onUsageMetricChange("time")}
                    aria-pressed={usageMetric === "time"}
                  >
                    Time
                  </button>
                </div>
              </div>
            </div>
            {showUsageSkeleton ? (
              <div className="home-usage-skeleton">
                <div className="home-usage-grid">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div className="home-usage-card" key={index}>
                      <span className="home-latest-skeleton home-usage-skeleton-label" />
                      <span className="home-latest-skeleton home-usage-skeleton-value" />
                    </div>
                  ))}
                </div>
                <div className="home-usage-chart-card">
                  <span className="home-latest-skeleton home-usage-skeleton-chart" />
                </div>
              </div>
            ) : showUsageEmpty ? (
              <div className="home-usage-empty">
                <div className="home-usage-empty-title">No usage data yet</div>
                <div className="home-usage-empty-subtitle">
                  Run a Codex session to start tracking local usage.
                </div>
                {localUsageError && (
                  <div className="home-usage-error">{localUsageError}</div>
                )}
              </div>
            ) : (
              <>
                <div className="home-usage-grid">
                  {usageMetric === "tokens" ? (
                    <>
                      <div className="home-usage-card">
                        <div className="home-usage-label">Last 7 days</div>
                        <div className="home-usage-value">
                          <span className="home-usage-number">
                            {formatCompactNumber(usageTotals?.last7DaysTokens)}
                          </span>
                          <span className="home-usage-suffix">tokens</span>
                        </div>
                        <div className="home-usage-caption">
                          Avg {formatCompactNumber(usageTotals?.averageDailyTokens)}{" "}
                          / day
                        </div>
                      </div>
                      <div className="home-usage-card">
                        <div className="home-usage-label">Last 30 days</div>
                        <div className="home-usage-value">
                          <span className="home-usage-number">
                            {formatCompactNumber(usageTotals?.last30DaysTokens)}
                          </span>
                          <span className="home-usage-suffix">tokens</span>
                        </div>
                        <div className="home-usage-caption">
                          Total {formatCount(usageTotals?.last30DaysTokens)}
                        </div>
                      </div>
                      <div className="home-usage-card">
                        <div className="home-usage-label">Cache hit rate</div>
                        <div className="home-usage-value">
                          <span className="home-usage-number">
                            {usageTotals
                              ? `${usageTotals.cacheHitRatePercent.toFixed(1)}%`
                              : "--"}
                          </span>
                        </div>
                        <div className="home-usage-caption">Last 7 days</div>
                      </div>
                      <div className="home-usage-card">
                        <div className="home-usage-label">Peak day</div>
                        <div className="home-usage-value">
                          <span className="home-usage-number">
                            {formatDayLabel(usageTotals?.peakDay)}
                          </span>
                        </div>
                        <div className="home-usage-caption">
                          {formatCompactNumber(usageTotals?.peakDayTokens)} tokens
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="home-usage-card">
                        <div className="home-usage-label">Last 7 days</div>
                        <div className="home-usage-value">
                          <span className="home-usage-number">
                            {formatDurationCompact(last7AgentMs)}
                          </span>
                          <span className="home-usage-suffix">agent time</span>
                        </div>
                        <div className="home-usage-caption">
                          Avg {formatDurationCompact(averageDailyAgentMs)} / day
                        </div>
                      </div>
                      <div className="home-usage-card">
                        <div className="home-usage-label">Last 30 days</div>
                        <div className="home-usage-value">
                          <span className="home-usage-number">
                            {formatDurationCompact(last30AgentMs)}
                          </span>
                          <span className="home-usage-suffix">agent time</span>
                        </div>
                        <div className="home-usage-caption">
                          Total {formatDuration(last30AgentMs)}
                        </div>
                      </div>
                      <div className="home-usage-card">
                        <div className="home-usage-label">Runs</div>
                        <div className="home-usage-value">
                          <span className="home-usage-number">
                            {formatCount(last7AgentRuns)}
                          </span>
                          <span className="home-usage-suffix">runs</span>
                        </div>
                        <div className="home-usage-caption">Last 7 days</div>
                      </div>
                      <div className="home-usage-card">
                        <div className="home-usage-label">Peak day</div>
                        <div className="home-usage-value">
                          <span className="home-usage-number">
                            {formatDayLabel(peakAgentDayLabel)}
                          </span>
                        </div>
                        <div className="home-usage-caption">
                          {formatDurationCompact(peakAgentTimeMs)} agent time
                        </div>
                      </div>
                    </>
                  )}
                </div>
                <div className="home-usage-chart-card">
                  <div className="home-usage-chart">
                    {last7Days.map((day) => {
                      const value =
                        usageMetric === "tokens"
                          ? day.totalTokens
                          : day.agentTimeMs ?? 0;
                      const height = Math.max(
                        6,
                        Math.round((value / maxUsageValue) * 100),
                      );
                      const tooltip =
                        usageMetric === "tokens"
                          ? `${formatDayLabel(day.day)} · ${formatCount(day.totalTokens)} tokens`
                          : `${formatDayLabel(day.day)} · ${formatDuration(day.agentTimeMs ?? 0)} agent time`;
                      return (
                        <div
                          className="home-usage-bar"
                          key={day.day}
                          data-value={tooltip}
                        >
                          <span
                            className="home-usage-bar-fill"
                            style={{ height: `${height}%` }}
                          />
                          <span className="home-usage-bar-label">
                            {formatDayLabel(day.day)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="home-usage-models">
                  <div className="home-usage-models-label">
                    Top models
                    {usageMetric === "time" && (
                      <span className="home-usage-models-hint">Tokens</span>
                    )}
                  </div>
                  <div className="home-usage-models-list">
                    {localUsageSnapshot?.topModels?.length ? (
                      localUsageSnapshot.topModels.map((model) => (
                        <span
                          className="home-usage-model-chip"
                          key={model.model}
                          title={`${model.model}: ${formatCount(model.tokens)} tokens`}
                        >
                          {model.model}
                          <span className="home-usage-model-share">
                            {model.sharePercent.toFixed(1)}%
                          </span>
                        </span>
                      ))
                    ) : (
                      <span className="home-usage-model-empty">
                        No models yet
                      </span>
                    )}
                  </div>
                  {localUsageError && (
                    <div className="home-usage-error">{localUsageError}</div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
