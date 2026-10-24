import { useQuery } from "@tanstack/react-query";
import { hostingPullRequestDraft, toAppError } from "../../lib/ipc";
import type { AppError, PullRequestDraft, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UsePullRequestDraft {
  draft: PullRequestDraft | undefined;
  /** The draft, or its failure, is in; false while the target is null. */
  settled: boolean;
}

/** The title and description to start a pull request into `target` from; read once. */
export function usePullRequestDraft(repoId: RepoId, target: string | null): UsePullRequestDraft {
  const query = useQuery<PullRequestDraft, AppError>({
    queryKey: queryKeys.prDraft(repoId, target ?? ""),
    // Disabled while the target is null, so the function only runs with one.
    queryFn: () =>
      hostingPullRequestDraft(repoId, target as string).catch((e: unknown) => {
        throw toAppError(e);
      }),
    enabled: target !== null,
    staleTime: Infinity,
  });

  // A disabled query stays pending, so a null target is never settled.
  return { draft: query.data, settled: !query.isPending };
}
