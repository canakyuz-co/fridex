import type { GitCommandReport } from "../types";

export type GitHookSource = "husky" | "lefthook" | "lint-staged" | "commitlint";

export function detectGitHookSource(report: GitCommandReport): GitHookSource | null {
  const combined = `${report.stderr ?? ""}\n${report.stdout ?? ""}`.toLowerCase();
  // Heuristics only; best-effort detection.
  if (combined.includes("husky") && combined.includes("hook")) {
    return "husky";
  }
  if (combined.includes("lefthook")) {
    return "lefthook";
  }
  if (combined.includes("lint-staged") || combined.includes("lint staged")) {
    return "lint-staged";
  }
  if (combined.includes("commitlint")) {
    return "commitlint";
  }
  return null;
}

export function formatGitCommandReport(report: GitCommandReport): string {
  const lines: string[] = [
    `Command: ${report.command}`,
    `Exit code: ${typeof report.exitCode === "number" ? report.exitCode : "unknown"}`,
    `Duration: ${Math.round(report.durationMs)}ms`,
  ];
  const hook = detectGitHookSource(report);
  if (hook) {
    lines.push(`Hook source: ${hook}`);
  }
  const stderr = report.stderr?.trim();
  if (stderr) {
    lines.push("", "STDERR:", stderr);
  }
  const stdout = report.stdout?.trim();
  if (stdout) {
    lines.push("", "STDOUT:", stdout);
  }
  return lines.join("\n");
}

