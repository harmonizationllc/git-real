import { useState } from "react";
import { hostingCreatePullRequest, openExternal, toAppError } from "../../lib/ipc";
import type { AppError, CreatePrRequest, PullRequest, RepoId, Tracking } from "../../lib/ipc";
import { useToasts } from "../../lib/store/toasts";
import { useNetworkAction } from "../remotes/useNetworkAction";
import type { CredentialPrompt } from "../remotes/useNetworkAction";
import { originBranchName, prPushPlan, pushTargetFor } from "./createPrPlan";
import type { PrPushPlan } from "./createPrPlan";
import { openedToastText } from "./hostingCopy";

export interface CreatePrInput {
  title: string;
  body: string;
  target: string;
  pushFirst: boolean;
}

export interface UseCreatePullRequest {
  plan: PrPushPlan;
  /** Resolves with the PR (toast shown) or null (error set, or cancelled). */
  submit(input: CreatePrInput): Promise<PullRequest | null>;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
  /** The sign-in the push is waiting on, for CredentialDialog. */
  prompt: CredentialPrompt | null;
}

/**
 * Pushes `local` as its plan needs and opens a pull request from it, in one network command, so a
 * credential prompt and its retry cover the push. Credentials reach the command only through the
 * network gate's thunk.
 */
export function useCreatePullRequest(
  repoId: RepoId,
  local: string,
  tracking: Tracking | null,
  remotes: string[],
): UseCreatePullRequest {
  const network = useNetworkAction(repoId);
  const [error, setError] = useState<AppError | null>(null);
  const plan = prPushPlan(tracking, remotes);

  const submit = async (input: CreatePrInput): Promise<PullRequest | null> => {
    setError(null);
    const request: CreatePrRequest = {
      branch: local,
      push: pushTargetFor(plan, input.pushFirst, local),
      pr: {
        title: input.title.trim(),
        body: input.body,
        sourceBranch: originBranchName(local, tracking, plan),
        targetBranch: input.target,
      },
    };
    const result = await network.run((c) => hostingCreatePullRequest(repoId, request, c));
    if (result.status === "failed") setError(result.error);
    if (result.status !== "ok") return null;
    const pr = result.value;
    const toasts = useToasts.getState();
    toasts.notify({
      text: openedToastText(pr.number),
      variant: "success",
      action: {
        label: "Open in browser",
        run: () =>
          void openExternal(pr.webUrl).catch((e: unknown) => toasts.show(toAppError(e).message)),
      },
    });
    return pr;
  };

  return {
    plan,
    submit,
    pending: network.pending,
    error,
    clearError: () => setError(null),
    prompt: network.prompt,
  };
}
