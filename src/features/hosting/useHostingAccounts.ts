import { useQuery } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { hostingListAccounts, toAppError } from "../../lib/ipc";
import type { AppError, HostingAccount } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";

export interface UseHostingAccounts {
  accounts: HostingAccount[] | undefined;
  error: AppError | null;
  refetch(): void;
}

/** The connected hosting accounts, shared by every repository tab. */
export function useHostingAccounts(): UseHostingAccounts {
  const query = useQuery<HostingAccount[], AppError>({
    queryKey: queryKeys.hostingAccounts,
    queryFn: () =>
      hostingListAccounts().catch((e: unknown) => {
        throw toAppError(e);
      }),
  });

  return {
    accounts: query.data,
    error: query.error ?? null,
    refetch: () => void query.refetch(),
  };
}

/** Invalidates ["hosting"] and every ["repo", *, "hostingContext"]. */
export async function invalidateHosting(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["hosting"] }),
    queryClient.invalidateQueries({
      queryKey: ["repo"],
      predicate: (q) => q.queryKey[2] === "hostingContext",
    }),
  ]);
}
