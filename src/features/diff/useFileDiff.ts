import { useQuery } from "@tanstack/react-query";
import { getFileDiff, toAppError } from "../../lib/ipc";
import type { AppError, FileDiff, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import type { SelectedFile } from "../../lib/store/workspace";
import { isReadOnly } from "./model/scope";

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
    // A commit's diff never changes, so toggling Blame and back reuses it. Working-tree
    // diffs keep the default and revalidate, so a missed watcher event never leaves a
    // stale view to stage or discard from.
    staleTime: isReadOnly(scope) ? Infinity : 0,
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
