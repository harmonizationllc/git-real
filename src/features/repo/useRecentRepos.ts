import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listRecent, removeRecent } from "../../lib/ipc";
import type { RecentEntry } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

const NO_RECENTS: RecentEntry[] = [];

export function useRecentRepos(): {
  recents: RecentEntry[];
  isLoading: boolean;
  remove(path: string): void;
} {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.recent, queryFn: () => listRecent() });
  const { mutate } = useMutation({
    mutationFn: (path: string) => removeRecent(path),
    onSuccess: (list) => queryClient.setQueryData(queryKeys.recent, list),
  });
  return { recents: query.data ?? NO_RECENTS, isLoading: query.isPending, remove: mutate };
}
