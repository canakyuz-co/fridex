import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskEntry, TaskStatus } from "../../../types";
import {
  createTask,
  deleteTask,
  listTasks,
  setTaskStatus,
  updateTask,
} from "../../../services/tauri";

type CreateTaskInput = {
  title: string;
  content: string;
  workspaceId: string | null;
};

type UpdateTaskInput = {
  id: string;
  title: string;
  content: string;
};

type UseTasksResult = {
  tasks: TaskEntry[];
  isLoading: boolean;
  error: string | null;
  create: (input: CreateTaskInput) => Promise<void>;
  update: (input: UpdateTaskInput) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setStatus: (id: string, status: TaskStatus) => Promise<void>;
};

export function useTasks(): UseTasksResult {
  const [tasks, setTasks] = useState<TaskEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await listTasks();
      setTasks(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tasks.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const create = useCallback(async (input: CreateTaskInput) => {
    setError(null);
    const title = input.title.trim();
    if (!title) {
      setError("Task title is required.");
      return;
    }
    try {
      const created = await createTask(title, input.content, input.workspaceId);
      setTasks((prev) => [created, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create task.");
    }
  }, []);

  const update = useCallback(async (input: UpdateTaskInput) => {
    setError(null);
    const title = input.title.trim();
    if (!title) {
      setError("Task title is required.");
      return;
    }
    try {
      const updated = await updateTask(input.id, title, input.content);
      setTasks((prev) =>
        prev.map((task) => (task.id === updated.id ? updated : task)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update task.");
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    setError(null);
    try {
      await deleteTask(id);
      setTasks((prev) => prev.filter((task) => task.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete task.");
    }
  }, []);

  const setStatus = useCallback(async (id: string, status: TaskStatus) => {
    setError(null);
    try {
      const updated = await setTaskStatus(id, status);
      setTasks((prev) =>
        prev.map((task) => (task.id === updated.id ? updated : task)),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update task status.",
      );
    }
  }, []);

  const sorted = useMemo(
    () => [...tasks].sort((a, b) => b.updatedAt - a.updatedAt),
    [tasks],
  );

  return { tasks: sorted, isLoading, error, create, update, remove, setStatus };
}
