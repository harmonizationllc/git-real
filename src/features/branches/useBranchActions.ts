import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  checkoutBranch,
  checkoutRemoteBranch,
  createBranch,
  deleteBranches,
  renameBranch,
  setBranchUpstream,
  toAppError,
} from "../../lib/ipc";
import type { AppError, AutoStash, BranchDeleteOutcome, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useAutoFetchState } from "../../lib/store/autoFetch";
import { toastAutoStash } from "../checkout/autoStashToast";

export type BranchRequest =
  | { action: "create"; name: string; startPoint: string | null; checkout: boolean }
  | { action: "rename"; oldName: string; newName: string }
  | { action: "checkout"; name: string }
  | { action: "checkoutRemote"; remote: string; name: string }
  | { action: "setUpstream"; name: string; upstream: string | null };

/** `run` never rejects: it resolves with the AppError or null, and `error` mirrors the last result. */
export interface UseBranchActions {
  run(req: BranchRequest): Promise<AppError | null>;
  /** Deletes local branches in one batch: per-name outcomes, or the AppError when the whole call fails. */
  deleteBranches(names: string[], force: boolean): Promise<BranchDeleteOutcome[] | AppError>;
  pending: boolean;
  error: AppError | null;
  clearError(): void;
}

/** A batch delete rides the same mutation as `BranchRequest`, so `pending` and invalidation cover it. */
interface DeleteBatch {
  action: "deleteBatch";
  names: string[];
  force: boolean;
}
type MutationRequest = BranchRequest | DeleteBatch;

/** Whether the request's success asks for an auto-fetch: a checkout, or setting (not unsetting) an upstream. */
function fetchesAfter(req: MutationRequest): boolean {
  switch (req.action) {
    case "checkout":
    case "checkoutRemote":
      return true;
    case "setUpstream":
      return req.upstream !== null;
    default:
      return false;
  }
}

/** What a request leaves to report: the auto-stash of a switch and the name switched to; null otherwise. */
interface SwitchReport {
  autoStash: AutoStash | null;
  target: string;
}

type MutationResult = SwitchReport | BranchDeleteOutcome[] | null;

async function execute(repoId: RepoId, req: MutationRequest): Promise<MutationResult> {
  switch (req.action) {
    case "create": {
      const created = await createBranch(repoId, req.name, req.startPoint, req.checkout);
      return req.checkout ? { autoStash: created.autoStash, target: req.name } : null;
    }
    case "rename":
      await renameBranch(repoId, req.oldName, req.newName);
      return null;
    case "deleteBatch":
      return deleteBranches(repoId, req.names, req.force);
    case "checkout": {
      const outcome = await checkoutBranch(repoId, req.name);
      return { autoStash: outcome.autoStash, target: req.name };
    }
    case "checkoutRemote": {
      const outcome = await checkoutRemoteBranch(repoId, req.remote, req.name);
      return { autoStash: outcome.autoStash, target: req.name };
    }
    case "setUpstream":
      await setBranchUpstream(repoId, req.name, req.upstream);
      return null;
  }
}

export function useBranchActions(repoId: RepoId): UseBranchActions {
  const queryClient = useQueryClient();
  const mutation = useMutation<MutationResult, AppError, MutationRequest>({
    mutationFn: (req) =>
      execute(repoId, req).catch((e: unknown) => {
        throw toAppError(e);
      }),
    // A new HEAD or a newly set upstream may be behind its remote, so the focused pane is
    // asked to fetch; unsetting an upstream leaves nothing to compare against.
    onSuccess: (data, req) => {
      if (fetchesAfter(req)) useAutoFetchState.getState().request(repoId);
      if (data !== null && !Array.isArray(data)) toastAutoStash(data.autoStash, data.target);
    },
    // Returning the promise keeps `pending` true until the refetch is triggered. Runs on
    // failure too, since a failed switch or create may have partly applied.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) }),
  });
  const { mutateAsync } = mutation;

  return {
    run: (req) =>
      mutateAsync(req).then(
        () => null,
        (e: AppError) => e,
      ),
    deleteBranches: (names, force) =>
      mutateAsync({ action: "deleteBatch", names, force }).then(
        (outcomes): BranchDeleteOutcome[] => (Array.isArray(outcomes) ? outcomes : []),
        (e: AppError) => e,
      ),
    pending: mutation.isPending,
    error: mutation.error,
    clearError: mutation.reset,
  };
}
