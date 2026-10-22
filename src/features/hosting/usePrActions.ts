import { useState } from "react";
import { copyText, hostingCheckoutPullRequest, openExternal, toAppError } from "../../lib/ipc";
import type { AppError, PullRequest, RepoId } from "../../lib/ipc";
import { useNetworkAction } from "../remotes/useNetworkAction";
import type { CredentialPrompt } from "../remotes/useNetworkAction";

/** A checkout that would move a diverged branch, waiting for the user's confirmation. */
export interface ResetRequest {
  pr: PullRequest;
  branch: string;
}

export interface UsePrActions {
  /** Resolves when done; a failure lands in `error`, a diverged branch in `resetRequest`. */
  checkout(pr: PullRequest, reset?: boolean): Promise<void>;
  open(pr: PullRequest): void;
  copyLink(pr: PullRequest): void;
  /** Set when checkout answered needsReset; the panel confirms, then calls checkout(pr, true). */
  resetRequest: ResetRequest | null;
  clearResetRequest(): void;
  /** The last successful checkout, cleared when the next one starts. */
  status: string | null;
  error: AppError | null;
  clearError(): void;
  pending: boolean;
  /** The sign-in a checkout's fetch is waiting on, for CredentialDialog. */
  prompt: CredentialPrompt | null;
}

export function usePrActions(repoId: RepoId): UsePrActions {
  const network = useNetworkAction(repoId);
  const [resetRequest, setResetRequest] = useState<ResetRequest | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<AppError | null>(null);

  const fail = (e: unknown) => setError(toAppError(e));

  // Checkout fetches, so it goes through the network gate, which also refreshes the list.
  const checkout = async (pr: PullRequest, reset = false) => {
    setResetRequest(null);
    setStatus(null);
    setError(null);
    const result = await network.run((c) =>
      hostingCheckoutPullRequest(repoId, pr.number, reset, c),
    );
    if (result.status === "failed") setError(result.error);
    else if (result.status === "ok") {
      const outcome = result.value;
      // The outcome names the branch it landed on: a fork pull request lands on pr/<n>.
      if (outcome.kind === "needsReset") setResetRequest({ pr, branch: outcome.branch });
      else setStatus(`Checked out ${outcome.branch}.`);
    }
  };

  return {
    checkout,
    open: (pr) => void openExternal(pr.webUrl).catch(fail),
    copyLink: (pr) => void copyText(pr.webUrl).catch(fail),
    resetRequest,
    clearResetRequest: () => setResetRequest(null),
    status,
    error,
    clearError: () => setError(null),
    pending: network.pending,
    prompt: network.prompt,
  };
}
