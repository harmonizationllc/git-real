import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RepoId } from "../../lib/ipc";
import { dueNow, entryFor, useAutoFetchState } from "../../lib/store/autoFetch";
import { useSettings } from "../../lib/store/settings";
import type { SyncActions } from "./useSyncActions";

/**
 * Decides when the focused repo fetches on its own: on mount, when the setting turns on, on a
 * request from a trigger source, when the window regains focus, and on the interval while focused.
 * Whether a fetch may run (cooldown, pause, busy gates) is left to `dueNow` and `autoFetch`.
 */
export function useAutoFetch(repoId: RepoId, sync: Pick<SyncActions, "autoFetch">): void {
  const auto = useSettings((s) => s.settings.fetch.auto);
  const intervalMinutes = useSettings((s) => s.settings.fetch.intervalMinutes);
  const lastFetchedAt = useAutoFetchState((s) => s.repos[repoId]?.lastFetchedAt ?? null);

  // The latest instance, so autoFetch checks the current gates rather than a captured closure's.
  const syncRef = useRef(sync);
  useLayoutEffect(() => {
    syncRef.current = sync;
  });

  const attempt = useCallback(() => {
    if (!useSettings.getState().settings.fetch.auto) return;
    if (!dueNow(entryFor(useAutoFetchState.getState(), repoId), Date.now())) return;
    syncRef.current.autoFetch();
  }, [repoId]);

  // Mount (the repo became focused), and the setting turning on.
  useEffect(() => {
    if (auto) attempt();
  }, [auto, attempt]);

  // A trigger source asked this repo to fetch; `forget` dropping the count is not a request.
  useEffect(
    () =>
      useAutoFetchState.subscribe((next, prev) => {
        if (entryFor(next, repoId).requested > entryFor(prev, repoId).requested) attempt();
      }),
    [repoId, attempt],
  );

  // Window focus and the interval; a completed fetch of any kind restarts the interval.
  useEffect(() => {
    if (!auto) return;
    const tick = () => {
      if (document.hasFocus()) attempt();
    };
    const timer = setInterval(tick, intervalMinutes * 60_000);
    window.addEventListener("focus", attempt);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", attempt);
    };
  }, [auto, intervalMinutes, lastFetchedAt, attempt]);
}
