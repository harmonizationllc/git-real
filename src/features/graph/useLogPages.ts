import { queryOptions, useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getLogPage, toAppError } from "../../lib/ipc";
import type { AppError, GraphRow, LogPage, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { PAGE_SIZE } from "./model/layout";
import { pageOf, pagesFor, pageStart } from "./model/pages";

/** One page of a generation; shared by the hook and imperative fetches so the cache entries match. */
export const logPageOptions = (repoId: RepoId, generation: number, page: number) =>
  queryOptions<LogPage, AppError>({
    queryKey: queryKeys.logPage(repoId, generation, page),
    queryFn: () =>
      getLogPage(repoId, generation, pageStart(page), PAGE_SIZE).catch((e: unknown) => {
        throw toAppError(e);
      }),
    staleTime: Infinity,
  });

export interface UseLogPages {
  rowAt(index: number): GraphRow | undefined;
  error: AppError | null;
  refetch(): void;
}

/**
 * The pages covering rows `first..=last` of `generation`. A page rejected as `logStale` (the
 * backend rebuilt its cache) invalidates the summary once per generation and is never shown as an error.
 */
export function useLogPages(
  repoId: RepoId,
  generation: number | undefined,
  first: number,
  last: number,
): UseLogPages {
  const queryClient = useQueryClient();
  const pages = generation === undefined ? [] : pagesFor(first, last);
  const results = useQueries({
    queries: pages.map((page) => logPageOptions(repoId, generation as number, page)),
  });

  const handled = useRef<number | null>(null);
  const stale = results.some((r) => r.error?.kind === "logStale");
  useEffect(() => {
    if (!stale || handled.current === generation) return;
    handled.current = generation as number;
    void queryClient.invalidateQueries({ queryKey: queryKeys.log(repoId) });
  }, [stale, generation, repoId, queryClient]);

  const byPage = new Map(pages.map((page, i) => [page, results[i].data]));
  return {
    rowAt: (index) => byPage.get(pageOf(index))?.rows[index - pageStart(pageOf(index))],
    error: results.find((r) => r.error && r.error.kind !== "logStale")?.error ?? null,
    refetch: () => results.forEach((r) => void r.refetch()),
  };
}
