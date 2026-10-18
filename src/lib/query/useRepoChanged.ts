import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { onRepoChanged } from "../ipc";
import type { RepoId } from "../ipc";
import { queryKeys } from "./keys";

/** Subscribes to the repo-changed event and invalidates every query under the repo prefix. */
export function useRepoChanged(repoId: RepoId): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let active = true;
    // A failed subscribe must not become an unhandled rejection; queries still work without it.
    const sub = onRepoChanged(repoId, () => {
      if (active) void queryClient.invalidateQueries({ queryKey: queryKeys.repo(repoId) });
    }).catch(() => undefined);
    return () => {
      active = false;
      // Also releases a subscription that resolves after unmount.
      void sub.then((unlisten) => unlisten?.());
    };
  }, [repoId, queryClient]);
}
