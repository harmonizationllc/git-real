import { useQuery } from "@tanstack/react-query";
import { listTags, toAppError } from "../../lib/ipc";
import type { AppError, RepoId, TagList } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseTags {
  list: TagList | undefined;
  error: AppError | null;
  refetch(): void;
}

/** The repository's local tags and remotes; `repo-changed` and window focus keep it fresh. */
export function useTags(repoId: RepoId): UseTags {
  const query = useQuery<TagList, AppError>({
    queryKey: queryKeys.tags(repoId),
    queryFn: () =>
      listTags(repoId).catch((e: unknown) => {
        throw toAppError(e);
      }),
    refetchOnWindowFocus: true,
  });

  return {
    list: query.data,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}
