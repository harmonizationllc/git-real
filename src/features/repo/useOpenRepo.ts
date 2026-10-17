import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { cloneRepo, initRepo, openRepo, toAppError } from "../../lib/ipc";
import type { AppError } from "../../lib/ipc";
import { queryKeys } from "../../lib/query/keys";
import { useRepoTabs } from "../../lib/store/repoTabs";

type OpenRequest =
  | { action: "open"; path: string }
  | { action: "init"; path: string }
  | { action: "clone"; url: string; dest: string; cloneId: number };

export interface UseOpenRepo {
  open(path: string): Promise<void>;
  init(path: string): Promise<void>;
  /** Resolves true when the repo opened, false on failure (error is then set). Never rejects. */
  clone(url: string, dest: string, cloneId: number): Promise<boolean>;
  error: AppError | null;
  errorPath: string | null;
  clearError(): void;
}

function execute(req: OpenRequest) {
  switch (req.action) {
    case "open":
      return openRepo(req.path);
    case "init":
      return initRepo(req.path);
    case "clone":
      return cloneRepo(req.url, req.dest, req.cloneId);
  }
}

export function useOpenRepo(): UseOpenRepo {
  const queryClient = useQueryClient();
  const openTab = useRepoTabs((s) => s.openTab);
  const [failure, setFailure] = useState<{ error: AppError; path: string | null } | null>(null);

  const latestCall = useRef(0);

  const run = async (req: OpenRequest): Promise<boolean> => {
    const id = ++latestCall.current;
    setFailure(null);
    try {
      const repo = await execute(req);
      openTab(repo);
      await queryClient.invalidateQueries({ queryKey: queryKeys.recent });
      return true;
    } catch (e) {
      if (id === latestCall.current) {
        setFailure({ error: toAppError(e), path: req.action === "clone" ? null : req.path });
      }
      return false;
    }
  };

  return {
    open: async (path) => {
      await run({ action: "open", path });
    },
    init: async (path) => {
      await run({ action: "init", path });
    },
    clone: (url, dest, cloneId) => run({ action: "clone", url, dest, cloneId }),
    error: failure?.error ?? null,
    errorPath: failure?.path ?? null,
    clearError: () => setFailure(null),
  };
}
