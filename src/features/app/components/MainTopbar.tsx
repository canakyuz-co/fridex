import type { ReactNode } from "react";

type MainTopbarProps = {
  leftNode: ReactNode;
  centerNode?: ReactNode;
  actionsNode?: ReactNode;
  className?: string;
};

export function MainTopbar({
  leftNode,
  centerNode,
  actionsNode,
  className,
}: MainTopbarProps) {
  const classNames = ["main-topbar", className].filter(Boolean).join(" ");
  return (
    <div className={classNames} data-tauri-drag-region>
      <div className="main-topbar-left">{leftNode}</div>
      {centerNode ? (
        <div className="main-topbar-center" aria-hidden>
          {centerNode}
        </div>
      ) : null}
      <div className="actions">{actionsNode ?? null}</div>
    </div>
  );
}
