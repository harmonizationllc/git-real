import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RepoId } from "../../lib/ipc";
import { dueNow, entryFor, useAutoFetchState } from "../../lib/store/autoFetch";
import { useSettings } from "../../lib/store/settings";
import { LOADING } from "./syncCopy";
import type { SyncActions } from "./useSyncActions";

/**
 * Decides when the focused repo fetches on its own: on mount, when the setting turns on, on a
 * request from a trigger source, when the window regains focus, and on the interval while focused.
 * Whether a fetch may run (cooldown, pause, busy gates) is left to `dueNow` and `autoFetch`. While
 * paused only the interval keeps trying, silently. It also runs the manual fetch the auto-fetch
 * error toast asks for, once this pane is ready.
 */
export function useAutoFetch(
  repoId: RepoId,
  sync: Pick<SyncActions, "autoFetch" | "fetch" | "gates">,
): void {
  const auto = useSettings((s) => s.settings.fetch.auto);
  const intervalMinutes = useSettings((s) => s.settings.fetch.intervalMinutes);
  const lastFetchedAt = useAutoFetchState((s) => s.repos[repoId]?.lastFetchedAt ?? null);
  const manualRequested = useAutoFetchState((s) => s.repos[repoId]?.manualRequested ?? 0);

  // The latest instance, so autoFetch checks the current gates rather than a captured closure's.
  const syncRef = useRef(sync);
  useLayoutEffect(() => {
    syncRef.current = sync;
  });

  /** `silentRetry` (the interval) runs while paused; the cooldown still applies. */
  const attempt = useCallback(
    ({ silentRetry }: { silentRetry: boolean } = { silentRetry: false }) => {
      if (!useSettings.getState().settings.fetch.auto) return;
      const entry = entryFor(useAutoFetchState.getState(), repoId);
      if (!dueNow(entry, Date.now(), silentRetry)) return;
      syncRef.current.autoFetch();
    },
    [repoId],
  );

  // The remotes query has loaded (the fetch gate's LOADING reflects only that query); before
  // that autoFetch and fetch would skip silently.
  const ready = sync.gates.fetch !== LOADING;

  // The repo became focused and loaded, and the setting turning on.
  useEffect(() => {
    if (auto && ready) attempt();
  }, [auto, ready, attempt]);

  // The toast's Fetch asked this repo for the manual fetch: run each request once, as soon as the
  // pane is ready. Level-triggered from the store, so a request made before this pane mounted (the
  // toast activates the tab and requests in one click) or while it loaded still runs.
  useEffect(() => {
    if (!ready) return;
    const store = useAutoFetchState.getState();
    const entry = entryFor(store, repoId);
    if (entry.manualRequested <= entry.manualHandled) return;
    store.handleManual(repoId);
    syncRef.current.fetch();
  }, [ready, manualRequested, repoId]);

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
      if (document.hasFocus()) attempt({ silentRetry: true });
    };
    const onFocus = () => attempt();
    const timer = setInterval(tick, intervalMinutes * 60_000);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [auto, intervalMinutes, lastFetchedAt, attempt]);
}
