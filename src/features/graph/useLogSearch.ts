import { queryOptions, useQuery } from "@tanstack/react-query";
import { searchLog, toAppError } from "../../lib/ipc";
import type { AppError, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

/** A search of one generation; shared by the hook and imperative fetches so the cache entries match. */
export const logSearchOptions = (repoId: RepoId, generation: number, query: string) =>
  queryOptions<number[], AppError>({
    queryKey: queryKeys.logSearch(repoId, generation, query),
    queryFn: () =>
      searchLog(repoId, generation, query).catch((e: unknown) => {
        throw toAppError(e);
      }),
    staleTime: Infinity,
  });

export interface UseLogSearch {
  /** Ascending row indices of the matching commits; empty until answered or on failure. */
  matches: number[];
  isFetching: boolean;
}

const NO_MATCHES: number[] = [];

export function useLogSearch(
  repoId: RepoId,
  generation: number | undefined,
  query: string,
  /** Search waits for a complete graph; an incomplete one would answer with a partial list. */
  complete: boolean,
): UseLogSearch {
  const enabled = complete && generation !== undefined && query.trim() !== "";
  const result = useQuery({
    ...logSearchOptions(repoId, generation ?? 0, query),
    enabled,
  });
  return { matches: result.data ?? NO_MATCHES, isFetching: result.isFetching };
}
