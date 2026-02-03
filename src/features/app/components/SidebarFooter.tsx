import type { ClaudeUsageSnapshot } from "../../../types";

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return tokens.toString();
}

type SidebarFooterProps = {
  sessionPercent: number | null;
  weeklyPercent: number | null;
  sessionResetLabel: string | null;
  weeklyResetLabel: string | null;
  creditsLabel: string | null;
  showWeekly: boolean;
  otherAiModelsSyncPercent?: number | null;
  claudeUsage?: ClaudeUsageSnapshot | null;
  isOtherAiModel?: boolean;
};

export function SidebarFooter({
  sessionPercent,
  weeklyPercent,
  sessionResetLabel,
  weeklyResetLabel,
  creditsLabel,
  showWeekly,
  otherAiModelsSyncPercent,
  claudeUsage,
  isOtherAiModel,
}: SidebarFooterProps) {
  const showModelsSync = typeof otherAiModelsSyncPercent === "number";

  if (isOtherAiModel && claudeUsage) {
    const totalTokens = claudeUsage.sessionInputTokens + claudeUsage.sessionOutputTokens;
    const cacheTokens = claudeUsage.sessionCacheReadTokens + claudeUsage.sessionCacheCreationTokens;

    return (
      <div className="sidebar-footer">
        {showModelsSync && (
          <div className="usage-bars">
            <div className="usage-block">
              <div className="usage-label">
                <span className="usage-title">
                  <span>Models</span>
                  <span className="usage-reset">· Syncing</span>
                </span>
                <span className="usage-value">{otherAiModelsSyncPercent}%</span>
              </div>
              <div className="usage-bar">
                <span
                  className="usage-bar-fill"
                  style={{ width: `${otherAiModelsSyncPercent}%` }}
                />
              </div>
            </div>
          </div>
        )}
        <div className="usage-bars claude-usage">
          <div className="usage-block">
            <div className="usage-label">
              <span className="usage-title">
                <span>Input</span>
              </span>
              <span className="usage-value">
                {formatTokenCount(claudeUsage.sessionInputTokens)}
              </span>
            </div>
          </div>
          <div className="usage-block">
            <div className="usage-label">
              <span className="usage-title">
                <span>Output</span>
              </span>
              <span className="usage-value">
                {formatTokenCount(claudeUsage.sessionOutputTokens)}
              </span>
            </div>
          </div>
          {cacheTokens > 0 && (
            <div className="usage-block">
              <div className="usage-label">
                <span className="usage-title">
                  <span>Cache</span>
                </span>
                <span className="usage-value">
                  {formatTokenCount(cacheTokens)}
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="usage-meta">
          Total: {formatTokenCount(totalTokens)} · ${claudeUsage.sessionCostUsd.toFixed(4)}
        </div>
      </div>
    );
  }

  return (
    <div className="sidebar-footer">
      <div className="usage-bars">
        {showModelsSync && (
          <div className="usage-block">
            <div className="usage-label">
              <span className="usage-title">
                <span>Models</span>
                <span className="usage-reset">· Syncing</span>
              </span>
              <span className="usage-value">{otherAiModelsSyncPercent}%</span>
            </div>
            <div className="usage-bar">
              <span
                className="usage-bar-fill"
                style={{ width: `${otherAiModelsSyncPercent}%` }}
              />
            </div>
          </div>
        )}
        <div className="usage-block">
          <div className="usage-label">
            <span className="usage-title">
              <span>Session</span>
              {sessionResetLabel && (
                <span className="usage-reset">· {sessionResetLabel}</span>
              )}
            </span>
            <span className="usage-value">
              {sessionPercent === null ? "--" : `${sessionPercent}%`}
            </span>
          </div>
          <div className="usage-bar">
            <span
              className="usage-bar-fill"
              style={{ width: `${sessionPercent ?? 0}%` }}
            />
          </div>
        </div>
        {showWeekly && (
          <div className="usage-block">
            <div className="usage-label">
              <span className="usage-title">
                <span>Weekly</span>
                {weeklyResetLabel && (
                  <span className="usage-reset">· {weeklyResetLabel}</span>
                )}
              </span>
              <span className="usage-value">
                {weeklyPercent === null ? "--" : `${weeklyPercent}%`}
              </span>
            </div>
            <div className="usage-bar">
              <span
                className="usage-bar-fill"
                style={{ width: `${weeklyPercent ?? 0}%` }}
              />
            </div>
          </div>
        )}
      </div>
      {creditsLabel && <div className="usage-meta">{creditsLabel}</div>}
    </div>
  );
}
