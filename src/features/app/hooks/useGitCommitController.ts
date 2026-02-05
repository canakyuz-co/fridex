import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { GitCommandReport, WorkspaceInfo } from "../../../types";
import {
  commitGitDetailed,
  generateCommitMessage,
  fetchGit,
  pullGit,
  pushGitDetailed,
  stageGitAll,
} from "../../../services/tauri";
import { shouldApplyCommitMessage } from "../../../utils/commitMessage";
import { useGitStatus } from "../../git/hooks/useGitStatus";

type GitStatusState = ReturnType<typeof useGitStatus>["status"];

type GitCommitControllerOptions = {
  activeWorkspace: WorkspaceInfo | null;
  activeWorkspaceId: string | null;
  activeWorkspaceIdRef: RefObject<string | null>;
  gitStatus: GitStatusState;
  refreshGitStatus: () => void;
  refreshGitLog?: () => void;
};

type GitCommitController = {
  commitMessage: string;
  commitMessageLoading: boolean;
  commitMessageError: string | null;
  commitLoading: boolean;
  pullLoading: boolean;
  fetchLoading: boolean;
  pushLoading: boolean;
  syncLoading: boolean;
  commitError: string | null;
  pullError: string | null;
  fetchError: string | null;
  pushError: string | null;
  syncError: string | null;
  commitReport: GitCommandReport | null;
  pushReport: GitCommandReport | null;
  hasWorktreeChanges: boolean;
  onCommitMessageChange: (value: string) => void;
  onGenerateCommitMessage: () => Promise<void>;
  onCommit: () => Promise<void>;
  onCommitAndPush: () => Promise<void>;
  onCommitAndSync: () => Promise<void>;
  onPull: () => Promise<void>;
  onFetch: () => Promise<void>;
  onPush: () => Promise<void>;
  onSync: () => Promise<void>;
};

export function useGitCommitController({
  activeWorkspace,
  activeWorkspaceId,
  activeWorkspaceIdRef,
  gitStatus,
  refreshGitStatus,
  refreshGitLog,
}: GitCommitControllerOptions): GitCommitController {
  const [commitMessage, setCommitMessage] = useState("");
  const [commitMessageLoading, setCommitMessageLoading] = useState(false);
  const [commitMessageError, setCommitMessageError] = useState<string | null>(
    null,
  );
  const [commitLoading, setCommitLoading] = useState(false);
  const [pullLoading, setPullLoading] = useState(false);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [commitReport, setCommitReport] = useState<GitCommandReport | null>(null);
  const [pushReport, setPushReport] = useState<GitCommandReport | null>(null);

  const reportToErrorMessage = useCallback((report: GitCommandReport) => {
    const stderr = report.stderr?.trim();
    const stdout = report.stdout?.trim();
    const detail = stderr || stdout || "Git command failed.";
    const code =
      typeof report.exitCode === "number" ? ` (exit ${report.exitCode})` : "";
    return `${detail}${code}`;
  }, []);

  const hasWorktreeChanges = useMemo(() => {
    const hasStagedChanges = gitStatus.stagedFiles.length > 0;
    const hasUnstagedChanges = gitStatus.unstagedFiles.length > 0;
    return hasStagedChanges || hasUnstagedChanges;
  }, [gitStatus.stagedFiles.length, gitStatus.unstagedFiles.length]);

  const ensureStagedForCommit = useCallback(async () => {
    const hasStagedChanges = gitStatus.stagedFiles.length > 0;
    const hasUnstagedChanges = gitStatus.unstagedFiles.length > 0;
    if (!activeWorkspace || hasStagedChanges || !hasUnstagedChanges) {
      return;
    }
    await stageGitAll(activeWorkspace.id);
  }, [activeWorkspace, gitStatus.stagedFiles.length, gitStatus.unstagedFiles.length]);

  const handleCommitMessageChange = useCallback((value: string) => {
    setCommitMessage(value);
  }, []);

  const handleGenerateCommitMessage = useCallback(async () => {
    if (!activeWorkspace || commitMessageLoading) {
      return;
    }
    const workspaceId = activeWorkspace.id;
    setCommitMessageLoading(true);
    setCommitMessageError(null);
    try {
      const message = await generateCommitMessage(workspaceId);
      if (!shouldApplyCommitMessage(activeWorkspaceIdRef.current, workspaceId)) {
        return;
      }
      setCommitMessage(message);
    } catch (error) {
      if (!shouldApplyCommitMessage(activeWorkspaceIdRef.current, workspaceId)) {
        return;
      }
      setCommitMessageError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (shouldApplyCommitMessage(activeWorkspaceIdRef.current, workspaceId)) {
        setCommitMessageLoading(false);
      }
    }
  }, [activeWorkspace, commitMessageLoading, activeWorkspaceIdRef]);

  useEffect(() => {
    setCommitMessage("");
    setCommitMessageError(null);
    setCommitMessageLoading(false);
    setCommitReport(null);
    setPushReport(null);
  }, [activeWorkspaceId]);

  const handleCommit = useCallback(async () => {
    if (
      !activeWorkspace ||
      commitLoading ||
      !commitMessage.trim() ||
      !hasWorktreeChanges
    ) {
      return;
    }
    setCommitLoading(true);
    setCommitError(null);
    setCommitReport(null);
    try {
      await ensureStagedForCommit();
      const report = await commitGitDetailed(
        activeWorkspace.id,
        commitMessage.trim(),
      );
      if (!report.ok) {
        setCommitReport(report);
        setCommitError(reportToErrorMessage(report));
        return;
      }
      setCommitMessage("");
      refreshGitStatus();
      refreshGitLog?.();
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : String(error));
    } finally {
      setCommitLoading(false);
    }
  }, [
    activeWorkspace,
    commitLoading,
    commitMessage,
    ensureStagedForCommit,
    hasWorktreeChanges,
    refreshGitLog,
    refreshGitStatus,
    reportToErrorMessage,
  ]);

  const handleCommitAndPush = useCallback(async () => {
    if (
      !activeWorkspace ||
      commitLoading ||
      pushLoading ||
      !commitMessage.trim() ||
      !hasWorktreeChanges
    ) {
      return;
    }
    let commitSucceeded = false;
    setCommitLoading(true);
    setPushLoading(true);
    setCommitError(null);
    setPushError(null);
    setCommitReport(null);
    setPushReport(null);
    try {
      await ensureStagedForCommit();
      const commitReport = await commitGitDetailed(
        activeWorkspace.id,
        commitMessage.trim(),
      );
      if (!commitReport.ok) {
        setCommitReport(commitReport);
        setCommitError(reportToErrorMessage(commitReport));
        return;
      }
      commitSucceeded = true;
      setCommitMessage("");
      setCommitLoading(false);
      const pushReport = await pushGitDetailed(activeWorkspace.id);
      if (!pushReport.ok) {
        setPushReport(pushReport);
        setPushError(reportToErrorMessage(pushReport));
        return;
      }
      refreshGitStatus();
      refreshGitLog?.();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!commitSucceeded) {
        setCommitError(errorMsg);
      } else {
        setPushError(errorMsg);
      }
    } finally {
      setCommitLoading(false);
      setPushLoading(false);
    }
  }, [
    activeWorkspace,
    commitLoading,
    pushLoading,
    commitMessage,
    ensureStagedForCommit,
    hasWorktreeChanges,
    refreshGitLog,
    refreshGitStatus,
    reportToErrorMessage,
  ]);

  const handleCommitAndSync = useCallback(async () => {
    if (
      !activeWorkspace ||
      commitLoading ||
      syncLoading ||
      !commitMessage.trim() ||
      !hasWorktreeChanges
    ) {
      return;
    }
    let commitSucceeded = false;
    setCommitLoading(true);
    setSyncLoading(true);
    setCommitError(null);
    setSyncError(null);
    setCommitReport(null);
    try {
      await ensureStagedForCommit();
      const commitReport = await commitGitDetailed(
        activeWorkspace.id,
        commitMessage.trim(),
      );
      if (!commitReport.ok) {
        setCommitReport(commitReport);
        setCommitError(reportToErrorMessage(commitReport));
        return;
      }
      commitSucceeded = true;
      setCommitMessage("");
      setCommitLoading(false);
      await pullGit(activeWorkspace.id);
      const pushReport = await pushGitDetailed(activeWorkspace.id);
      if (!pushReport.ok) {
        setPushReport(pushReport);
        setPushError(reportToErrorMessage(pushReport));
        setSyncError("Push failed during sync.");
        return;
      }
      refreshGitStatus();
      refreshGitLog?.();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!commitSucceeded) {
        setCommitError(errorMsg);
      } else {
        setSyncError(errorMsg);
      }
    } finally {
      setCommitLoading(false);
      setSyncLoading(false);
    }
  }, [
    activeWorkspace,
    commitLoading,
    syncLoading,
    commitMessage,
    ensureStagedForCommit,
    hasWorktreeChanges,
    refreshGitLog,
    refreshGitStatus,
    reportToErrorMessage,
  ]);

  const handlePull = useCallback(async () => {
    if (!activeWorkspace || pullLoading) {
      return;
    }
    setPullLoading(true);
    setPullError(null);
    try {
      await pullGit(activeWorkspace.id);
      setPushError(null);
      setPushReport(null);
      refreshGitStatus();
      refreshGitLog?.();
    } catch (error) {
      setPullError(error instanceof Error ? error.message : String(error));
    } finally {
      setPullLoading(false);
    }
  }, [activeWorkspace, pullLoading, refreshGitLog, refreshGitStatus]);

  const handlePush = useCallback(async () => {
    if (!activeWorkspace || pushLoading) {
      return;
    }
    setPushLoading(true);
    setPushError(null);
    setPushReport(null);
    try {
      const report = await pushGitDetailed(activeWorkspace.id);
      if (!report.ok) {
        setPushReport(report);
        setPushError(reportToErrorMessage(report));
        return;
      }
      setPullError(null);
      refreshGitStatus();
      refreshGitLog?.();
    } catch (error) {
      setPushError(error instanceof Error ? error.message : String(error));
    } finally {
      setPushLoading(false);
    }
  }, [
    activeWorkspace,
    pushLoading,
    refreshGitLog,
    refreshGitStatus,
    reportToErrorMessage,
  ]);

  const handleFetch = useCallback(async () => {
    if (!activeWorkspace || fetchLoading) {
      return;
    }
    setFetchLoading(true);
    setFetchError(null);
    try {
      await fetchGit(activeWorkspace.id);
      refreshGitStatus();
      refreshGitLog?.();
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : String(error));
    } finally {
      setFetchLoading(false);
    }
  }, [activeWorkspace, fetchLoading, refreshGitLog, refreshGitStatus]);

  const handleSync = useCallback(async () => {
    if (!activeWorkspace || syncLoading) {
      return;
    }
    setSyncLoading(true);
    setSyncError(null);
    setPushError(null);
    setPushReport(null);
    try {
      await pullGit(activeWorkspace.id);
      const report = await pushGitDetailed(activeWorkspace.id);
      if (!report.ok) {
        setPushReport(report);
        setPushError(reportToErrorMessage(report));
        setSyncError("Push failed during sync.");
        return;
      }
      setPullError(null);
      setSyncError(null);
      refreshGitStatus();
      refreshGitLog?.();
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : String(error));
    } finally {
      setSyncLoading(false);
    }
  }, [
    activeWorkspace,
    refreshGitLog,
    refreshGitStatus,
    reportToErrorMessage,
    syncLoading,
  ]);

  return {
    commitMessage,
    commitMessageLoading,
    commitMessageError,
    commitLoading,
    pullLoading,
    fetchLoading,
    pushLoading,
    syncLoading,
    commitError,
    pullError,
    fetchError,
    pushError,
    syncError,
    commitReport,
    pushReport,
    hasWorktreeChanges,
    onCommitMessageChange: handleCommitMessageChange,
    onGenerateCommitMessage: handleGenerateCommitMessage,
    onCommit: handleCommit,
    onCommitAndPush: handleCommitAndPush,
    onCommitAndSync: handleCommitAndSync,
    onPull: handlePull,
    onFetch: handleFetch,
    onPush: handlePush,
    onSync: handleSync,
  };
}
