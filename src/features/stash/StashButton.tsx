import { useIsMutating } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { RepoId } from "../../lib/ipc";
import { mutationKeys } from "../../lib/query/keys";
import { useOperationState } from "../merge/useOperationState";
import { useStatus } from "../worktree/useStatus";
import { StashDialog } from "./StashDialog";
import { pushGate } from "./stashGate";

export interface StashButtonProps {
  repoId: RepoId;
  /** "icon" is the Stashes panel's "+", "text" the Changes panel's "Stash…". */
  variant: "icon" | "text";
  /** The host's own pending work, which it knows a tick before the shared busy count. */
  disabled?: boolean;
  className?: string;
  /** Takes focus when the dialog closes and this button cannot. */
  fallbackFocus: RefObject<HTMLElement | null>;
}

const ICON_LABEL = "Stash changes…";

/** Opens the stash dialog; disabled while the push gate refuses or any stash action of the repo runs. */
export function StashButton({
  repoId,
  variant,
  disabled = false,
  className,
  fallbackFocus,
}: StashButtonProps) {
  // The host has the status loaded already; mounting must not fetch it again.
  const { status } = useStatus(repoId, { refetchOnMount: false });
  const { state } = useOperationState(repoId);
  const busy = useIsMutating({ mutationKey: mutationKeys.stash(repoId) }) > 0;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const gate = pushGate(status, state);
  const isDisabled = gate.disabled || busy || disabled;

  // A layout effect, so focus moves before the browser drops it to the body.
  useLayoutEffect(() => {
    if (isDisabled && document.activeElement === buttonRef.current) fallbackFocus.current?.focus();
  }, [isDisabled, fallbackFocus]);

  const icon = variant === "icon";
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={className}
        aria-label={icon ? ICON_LABEL : undefined}
        title={icon ? (gate.title ?? ICON_LABEL) : gate.title}
        disabled={isDisabled}
        onClick={() => setOpen(true)}
      >
        {icon ? "+" : "Stash…"}
      </button>
      <StashDialog
        repoId={repoId}
        open={open}
        onClose={() => setOpen(false)}
        fallbackFocus={fallbackFocus}
      />
    </>
  );
}
