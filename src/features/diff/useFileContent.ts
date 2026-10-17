import { useQuery } from "@tanstack/react-query";
import { getFileContent, toAppError } from "../../lib/ipc";
import type { AppError, DiffScope, DiffSide, RepoId } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseFileContent {
  bytes: ArrayBuffer | undefined;
  error: AppError | null;
  loading: boolean;
}

/** Raw bytes of one side of a file, e.g. for an image preview. */
export function useFileContent(
  repoId: RepoId,
  path: string,
  scope: DiffScope,
  side: DiffSide,
  enabled: boolean,
): UseFileContent {
  const query = useQuery<ArrayBuffer, AppError>({
    queryKey: queryKeys.fileContent(repoId, path, scope, side),
    queryFn: () =>
      getFileContent(repoId, path, scope, side).catch((e: unknown) => {
        throw toAppError(e);
      }),
    enabled,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return {
    bytes: query.data,
    error: query.error ?? null,
    loading: enabled && query.isPending,
  };
}
