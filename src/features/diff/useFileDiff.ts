import { useQuery } from "@tanstack/react-query";
import { getFileDiff, toAppError } from "../../lib/ipc";
import type { AppError, FileDiff, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import type { SelectedFile } from "../../lib/store/workspace";

export interface UseFileDiff {
  diff: FileDiff | undefined;
  error: AppError | null;
  loading: boolean;
  /** The file has no changes in this scope (e.g. its last hunk was just staged). */
  noChanges: boolean;
  refetch(): void;
}

export function useFileDiff(
  repoId: RepoId,
  file: SelectedFile | null,
  ignoreWhitespace: boolean,
  maxLines: number | null,
): UseFileDiff {
  const path = file?.path ?? "";
  const scope = file?.scope ?? "unstaged";
  const query = useQuery<FileDiff, AppError>({
    queryKey: queryKeys.fileDiff(repoId, path, scope, ignoreWhitespace, maxLines),
    queryFn: () =>
      getFileDiff(repoId, path, scope, ignoreWhitespace, maxLines ?? undefined).catch(
        (e: unknown) => {
          throw toAppError(e);
        },
      ),
    enabled: file !== null,
    retry: false,
    // Fresh until invalidated: writes and the file watcher invalidate the repo prefix, so
    // toggling Blame and back re-shows the cached diff without another round trip.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const noChanges = query.error?.kind === "noChanges";
  return {
    // A failed refetch keeps the last data in the cache; never show it next to an error.
    diff: query.error ? undefined : query.data,
    error: noChanges ? null : (query.error ?? null),
    loading: file !== null && query.isPending,
    noChanges,
    refetch: () => void query.refetch(),
  };
}
