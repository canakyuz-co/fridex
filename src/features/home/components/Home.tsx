import { useMemo, useState } from "react";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import { Markdown } from "../../messages/components/Markdown";
import type {
  LocalUsageSnapshot,
  GitHubIssue,
  TaskEntry,
  TaskStatus,
  TaskView,
} from "../../../types";
import { formatRelativeTime } from "../../../utils/time";
import { getGitHubIssues } from "../../../services/tauri";

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
  const [isTaskComposerOpen, setTaskComposerOpen] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskContent, setTaskContent] = useState("");
  const [taskWorkspaceDraft, setTaskWorkspaceDraft] = useState<string>("");
  const [taskQuery, setTaskQuery] = useState("");
  const [taskSort, setTaskSort] = useState<"updated" | "created" | "title">("updated");
  const [githubIssuesWorkspaceId, setGitHubIssuesWorkspaceId] = useState<string | null>(null);
  const [githubIssues, setGitHubIssues] = useState<GitHubIssue[]>([]);
  const [githubIssuesLoading, setGitHubIssuesLoading] = useState(false);
  const [githubIssuesError, setGitHubIssuesError] = useState<string | null>(null);
  const [githubIssueDraft, setGitHubIssueDraft] = useState("");
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const canCreateTask = taskTitle.trim().length > 0;
  const canSaveEdit = editTitle.trim().length > 0;

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
    if (taskSort === "title") {
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      return sorted;
    }
    if (taskSort === "created") {
      sorted.sort((a, b) => b.createdAt - a.createdAt);
      return sorted;
    }
    // Default: updated desc.
    sorted.sort((a, b) => b.updatedAt - a.updatedAt);
    return sorted;
  }, [taskQuery, taskSort, tasks]);

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

  const handleCreateTask = async () => {
    if (!canCreateTask) {
      return;
    }
    const workspaceId = getTaskComposerWorkspaceId();
    await onTaskCreate({ title: taskTitle, content: taskContent, workspaceId });
    setTaskTitle("");
    setTaskContent("");
    setTaskWorkspaceDraft("");
    setGitHubIssuesWorkspaceId(null);
    setGitHubIssues([]);
    setGitHubIssuesError(null);
    setGitHubIssueDraft("");
  };

  const getTaskComposerWorkspaceId = () => {
    if (tasksWorkspaceId) {
      return tasksWorkspaceId;
    }
    const trimmed = taskWorkspaceDraft.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const handleLoadGitHubIssues = async () => {
    const workspaceId = getTaskComposerWorkspaceId();
    if (!workspaceId) {
      return;
    }
    if (githubIssuesLoading) {
      return;
    }
    setGitHubIssuesLoading(true);
    setGitHubIssuesError(null);
    setGitHubIssueDraft("");
    try {
      const response = await getGitHubIssues(workspaceId);
      setGitHubIssuesWorkspaceId(workspaceId);
      setGitHubIssues(response.issues ?? []);
    } catch (error) {
      setGitHubIssuesWorkspaceId(workspaceId);
      setGitHubIssues([]);
      setGitHubIssuesError(error instanceof Error ? error.message : String(error));
    } finally {
      setGitHubIssuesLoading(false);
    }
  };

  const handleCloseTaskComposer = () => {
    setTaskComposerOpen(false);
    setTaskTitle("");
    setTaskContent("");
    setTaskWorkspaceDraft("");
    setGitHubIssuesWorkspaceId(null);
    setGitHubIssues([]);
    setGitHubIssuesLoading(false);
    setGitHubIssuesError(null);
    setGitHubIssueDraft("");
  };

  const handleEditTaskStart = (task: TaskEntry) => {
    setEditingTaskId(task.id);
    setEditTitle(task.title);
    setEditContent(task.content ?? "");
  };

  const handleEditTaskCancel = () => {
    setEditingTaskId(null);
    setEditTitle("");
    setEditContent("");
  };

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

  const handleEditTaskSave = async () => {
    if (!editingTaskId || !canSaveEdit) {
      return;
    }
    await onTaskUpdate({
      id: editingTaskId,
      title: editTitle.trim(),
      content: editContent,
    });
    handleEditTaskCancel();
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
            <div className="home-section-header">
              <div className="home-section-title">Tasks</div>
              <div className="home-tasks-controls">
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
                <div className="home-usage-select-wrap">
                  <input
                    className="home-usage-select home-tasks-search"
                    value={taskQuery}
                    onChange={(event) => setTaskQuery(event.target.value)}
                    placeholder="Search tasks…"
                    aria-label="Search tasks"
                  />
                </div>
                <div className="home-usage-select-wrap">
                  <select
                    className="home-usage-select"
                    value={taskSort}
                    onChange={(event) =>
                      setTaskSort(event.target.value as typeof taskSort)
                    }
                    aria-label="Sort tasks"
                  >
                    <option value="updated">Sort: updated</option>
                    <option value="created">Sort: created</option>
                    <option value="title">Sort: title</option>
                  </select>
                </div>
                <button
                  className="home-tasks-add-button"
                  type="button"
                  onClick={() =>
                    setTaskComposerOpen((current) => !current)
                  }
                  aria-expanded={isTaskComposerOpen}
                  aria-label="Add task"
                >
                  +
                </button>
              </div>
            </div>
            {isTaskComposerOpen && (
              <div className="home-tasks-composer">
                {!tasksWorkspaceId && (
                  <select
                    className="home-tasks-input"
                    value={taskWorkspaceDraft}
                    onChange={(event) => setTaskWorkspaceDraft(event.target.value)}
                    aria-label="Task project"
                  >
                    <option value="">No project (global)</option>
                    {tasksWorkspaceOptions
                      .filter((option) => option.id)
                      .map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                  </select>
                )}
                <div className="home-tasks-import">
                  <button
                    type="button"
                    className="home-tasks-inline-button"
                    onClick={() => void handleLoadGitHubIssues()}
                    disabled={!getTaskComposerWorkspaceId() || githubIssuesLoading}
                  >
                    {githubIssuesLoading ? "Loading GitHub issues…" : "Import from GitHub issues"}
                  </button>
                  {githubIssuesError && (
                    <span className="home-tasks-error">{githubIssuesError}</span>
                  )}
                </div>
                {githubIssues.length > 0 &&
                  githubIssuesWorkspaceId === getTaskComposerWorkspaceId() && (
                    <select
                      className="home-tasks-input"
                      value={githubIssueDraft}
                      onChange={(event) => {
                        const value = event.target.value;
                        setGitHubIssueDraft(value);
                        const issue = githubIssues.find(
                          (entry) => String(entry.number) === value,
                        );
                        if (!issue) {
                          return;
                        }
                        setTaskTitle(issue.title);
                        setTaskContent((prev) => {
                          const linkLine = `GitHub: ${issue.url}`;
                          if (prev.includes(issue.url)) {
                            return prev;
                          }
                          const trimmed = prev.trim();
                          return trimmed ? `${linkLine}\n\n${trimmed}` : linkLine;
                        });
                      }}
                      aria-label="Select GitHub issue"
                    >
                      <option value="">Select an issue…</option>
                      {githubIssues.map((issue) => (
                        <option key={issue.url} value={String(issue.number)}>
                          #{issue.number} {issue.title}
                        </option>
                      ))}
                    </select>
                  )}
                <input
                  className="home-tasks-input"
                  type="text"
                  placeholder="Task title"
                  value={taskTitle}
                  onChange={(event) => setTaskTitle(event.target.value)}
                />
                <textarea
                  className="home-tasks-textarea"
                  placeholder="Task details"
                  value={taskContent}
                  onChange={(event) => setTaskContent(event.target.value)}
                  rows={2}
                />
                <div className="home-tasks-actions">
                  <button
                    className="home-button"
                    type="button"
                    onClick={handleCreateTask}
                    disabled={!canCreateTask}
                  >
                    Add task
                  </button>
                  <button
                    className="home-tasks-inline-button"
                    type="button"
                    onClick={handleCloseTaskComposer}
                  >
                    Cancel
                  </button>
                  {tasksError && (
                    <span className="home-tasks-error">{tasksError}</span>
                  )}
                </div>
              </div>
            )}
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
                          className="home-tasks-action"
                          onClick={() => handleEditTaskStart(task)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="home-tasks-action"
                          onClick={() => onTaskDelete(task.id)}
                        >
                          Remove
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
                    {editingTaskId === task.id && (
                      <div className="home-tasks-edit">
                        <input
                          className="home-tasks-input"
                          type="text"
                          placeholder="Task title"
                          value={editTitle}
                          onChange={(event) => setEditTitle(event.target.value)}
                        />
                        <textarea
                          className="home-tasks-textarea"
                          placeholder="Task details"
                          value={editContent}
                          onChange={(event) => setEditContent(event.target.value)}
                          rows={2}
                        />
                        <div className="home-tasks-actions">
                          <button
                            className="home-button"
                            type="button"
                            onClick={handleEditTaskSave}
                            disabled={!canSaveEdit}
                          >
                            Save
                          </button>
                          <button
                            className="home-tasks-inline-button"
                            type="button"
                            onClick={handleEditTaskCancel}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="home-tasks-board">
                {(["todo", "doing", "done"] as TaskStatus[]).map((status) => (
                  <div className="home-tasks-column" key={status}>
                    <div className="home-tasks-column-title">
                      {(status === "todo"
                        ? "To do"
                        : status === "doing"
                          ? "Doing"
                          : "Done") + ` (${tasksByStatus[status].length})`}
                    </div>
                    <div className="home-tasks-column-list">
                      {tasksByStatus[status].map((task) => (
                        <div className="home-tasks-card" key={task.id}>
                          <div className="home-tasks-card-header">
                            <div className="home-tasks-card-title">{task.title}</div>
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
                          {editingTaskId === task.id && (
                            <div className="home-tasks-edit">
                              <input
                                className="home-tasks-input"
                                type="text"
                                placeholder="Task title"
                                value={editTitle}
                                onChange={(event) =>
                                  setEditTitle(event.target.value)
                                }
                              />
                              <textarea
                                className="home-tasks-textarea"
                                placeholder="Task details"
                                value={editContent}
                                onChange={(event) =>
                                  setEditContent(event.target.value)
                                }
                                rows={2}
                              />
                              <div className="home-tasks-actions">
                                <button
                                  className="home-button"
                                  type="button"
                                  onClick={handleEditTaskSave}
                                  disabled={!canSaveEdit}
                                >
                                  Save
                                </button>
                                <button
                                  className="home-tasks-inline-button"
                                  type="button"
                                  onClick={handleEditTaskCancel}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                          <div className="home-tasks-card-actions">
                            {status !== "todo" && (
                              <button
                                type="button"
                                className="home-tasks-action"
                                onClick={() => onTaskStatusChange(task.id, "todo")}
                              >
                                To do
                              </button>
                            )}
                            {status !== "doing" && (
                              <button
                                type="button"
                                className="home-tasks-action"
                                onClick={() => onTaskStatusChange(task.id, "doing")}
                              >
                                Doing
                              </button>
                            )}
                            {status !== "done" && (
                              <button
                                type="button"
                                className="home-tasks-action"
                                onClick={() => onTaskStatusChange(task.id, "done")}
                              >
                                Done
                              </button>
                            )}
                            <button
                              type="button"
                              className="home-tasks-action"
                              onClick={() => handleEditTaskStart(task)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="home-tasks-action"
                              onClick={() => onTaskDelete(task.id)}
                            >
                              Remove
                            </button>
                          </div>
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
