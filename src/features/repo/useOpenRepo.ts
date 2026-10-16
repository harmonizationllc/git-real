import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { initRepo, isAppError, openRepo } from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useRepoTabs } from "../../lib/store/repoTabs";

type OpenRequest = { action: "open"; path: string } | { action: "init"; path: string };

export interface UseOpenRepo {
  open(path: string): Promise<void>;
  init(path: string): Promise<void>;
  error: AppError | null;
  errorPath: string | null;
  clearError(): void;
}

function toAppError(e: unknown): AppError {
  return isAppError(e) ? e : { kind: "io", message: e instanceof Error ? e.message : String(e) };
}

export function useOpenRepo(): UseOpenRepo {
  const queryClient = useQueryClient();
  const openTab = useRepoTabs((s) => s.openTab);
  const [failure, setFailure] = useState<{ error: AppError; path: string } | null>(null);

  const latestCall = useRef(0);

  const run = async (req: OpenRequest): Promise<void> => {
    const id = ++latestCall.current;
    setFailure(null);
    try {
      const repo = req.action === "open" ? await openRepo(req.path) : await initRepo(req.path);
      openTab(repo);
      await queryClient.invalidateQueries({ queryKey: queryKeys.recent });
    } catch (e) {
      if (id === latestCall.current) setFailure({ error: toAppError(e), path: req.path });
    }
  };

  return {
    open: (path) => run({ action: "open", path }),
    init: (path) => run({ action: "init", path }),
    error: failure?.error ?? null,
    errorPath: failure?.path ?? null,
    clearError: () => setFailure(null),
  };
}
