import { useQuery } from "@tanstack/react-query";
import { pullDefaultMode, toAppError } from "../../lib/ipc";
import type { AppError, PullMode, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

/** The repo's default pull mode; "merge" until loaded or on error. */
export function usePullMode(repoId: RepoId): PullMode {
  const query = useQuery<PullMode, AppError>({
    queryKey: queryKeys.pullMode(repoId),
    queryFn: () =>
      pullDefaultMode(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
  });
  return query.data ?? "merge";
}
