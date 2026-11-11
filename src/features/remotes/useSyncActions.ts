import { useRef, useState } from "react";
import { fetchAll, pull as pullBranch, push as pushBranch } from "../../lib/ipc";
import type { AppError, Credentials, PullMode, RepoId } from "../../lib/ipc";
import { entryFor, useAutoFetchState } from "../../lib/store/autoFetch";
import { useRepoTabs } from "../../lib/store/repoTabs";
import { useSettings } from "../../lib/store/settings";
import { useToasts } from "../../lib/store/toasts";
import { useBranches } from "../branches/useBranches";
import { useOperationState } from "../merge/useOperationState";
import { networkMessage } from "./networkMessage";
import type { NetworkMessage } from "./networkMessage";
import { syncGates, upstreamRemote as remoteOfUpstream, upstreamText } from "./syncCopy";
import type { SyncGates, SyncVerb, UpstreamText } from "./syncCopy";
import { useNetworkAction } from "./useNetworkAction";
import type { CredentialPrompt, NetworkResult } from "./useNetworkAction";
import { usePullMode } from "./usePullMode";
import { useRemotes } from "./useRemotes";

export interface SyncActions {
  gates: SyncGates;
  upstream: UpstreamText | null;
  /** The remote of the current upstream, for "Edit remote…". */
  upstreamRemote: string | null;
  /** The verb this instance is running, for the busy label. */
  running: SyncVerb | null;
  fetch(): void;
  /**
   * Fetches with every prompt disabled; a failure pauses auto-fetch and toasts once per streak.
   */
  autoFetch(): void;
  /** Pulls in `mode`, or in the repo's default mode. */
  pull(mode?: PullMode): void;
  push(): void;
  requestForcePush(): void;
  message: NetworkMessage | null;
  dismissMessage(): void;
  prompt: CredentialPrompt | null;
  setUpstream: { remotes: string[]; branch: string; error: AppError | null } | null;
  publish(remote: string, branch: string): void;
  cancelSetUpstream(): void;
  forcePush: { local: string; remote: string; upstream: string } | null;
  confirmForcePush(): void;
  cancelForcePush(): void;
}

/** Network failures that come from the push itself, not from reaching the remote. */
const PUSH_OUTCOMES: ReadonlySet<string> = new Set([
  "pushRejectedNonFastForward",
  "leaseStale",
  "remoteRejected",
]);

/** A failure a background fetch would hit too (connectivity or auth), so it pauses auto-fetch. */
export const pausesAutoFetch = (error: AppError): boolean =>
  error.kind === "networkFailed" && !PUSH_OUTCOMES.has(error.network?.kind ?? "");

/** Errors the set-upstream dialog can fix in place, so it stays open with them. */
const DIALOG_ERRORS = new Set(["invalidBranchName", "remoteNotFound"]);

/** Fetch, pull and push of the current branch, behind the network gate. */
export function useSyncActions(repoId: RepoId): SyncActions {
  const { branches } = useBranches(repoId);
  const { remotes } = useRemotes(repoId);
  const defaultMode = usePullMode(repoId);
  const { state: operation } = useOperationState(repoId);
  const network = useNetworkAction(repoId);
  const [running, setRunning] = useState<SyncVerb | null>(null);
  const [message, setMessage] = useState<NetworkMessage | null>(null);
  const [publishTo, setPublishTo] = useState<{ remotes: string[]; branch: string } | null>(null);
  // Kept apart from the dialog's data, so opening it again starts without the old error.
  const [publishError, setPublishError] = useState<AppError | null>(null);
  const [forcePush, setForcePush] = useState<SyncActions["forcePush"]>(null);

  const head = branches?.head;
  const branch = head?.kind === "branch" ? head.name : null;
  const tracking = branches?.local.find((b) => b.isHead)?.tracking ?? null;
  const remoteNames = (remotes ?? []).map((r) => r.name);
  const gates = syncGates(head, tracking, remotes?.length, network.pending, operation);
  const upstreamRemote =
    tracking === null ? null : remoteOfUpstream(tracking.upstream, remoteNames);

  // Runs of this instance in flight. The label follows the first and clears with the last: a run
  // the network gate refuses (another is in flight) settles at once and must not clear it.
  const runs = useRef(0);
  const track = async <T>(
    verb: SyncVerb,
    go: () => Promise<NetworkResult<T>>,
  ): Promise<NetworkResult<T>> => {
    if (runs.current++ === 0) setRunning(verb);
    try {
      return await go();
    } finally {
      if (--runs.current === 0) setRunning(null);
    }
  };

  /** Runs one network action as `verb`: clears the last message and reports the verb until it settles. */
  const start = <T>(
    verb: SyncVerb,
    action: (credentials: Credentials | null) => Promise<T>,
  ): Promise<NetworkResult<T>> => {
    setMessage(null);
    return track(verb, () => network.run(action));
  };

  const report = (result: NetworkResult<unknown>) => {
    if (result.status === "failed") setMessage(networkMessage(result.error));
  };

  const autoFetchState = () => useAutoFetchState.getState();

  /**
   * A manual action's failure pauses auto-fetch when a background fetch would hit it too; so does
   * a cancelled sign-in, since the background fetch cannot sign in either.
   */
  const recordFailure = (result: NetworkResult<unknown>) => {
    if (
      result.status === "cancelled" ||
      (result.status === "failed" && pausesAutoFetch(result.error))
    ) {
      autoFetchState().recordFailure(repoId);
    }
  };

  /** A pushed branch may mean the remote works again. */
  const recordPush = (result: NetworkResult<unknown>) => {
    if (result.status === "ok") autoFetchState().resume(repoId);
    recordFailure(result);
  };

  /** A completed push of `local`, announced as a success toast. */
  const toastPushed = (local: string) =>
    useToasts.getState().notify({ text: `Pushed ${local}`, variant: "success" });

  const fetch = () => {
    if (gates.fetch !== null) return;
    void start("fetch", (c) => fetchAll(repoId, c)).then((result) => {
      report(result);
      recordFailure(result);
      if (result.status === "ok") {
        autoFetchState().recordFetched(repoId, Date.now());
        useToasts.getState().notify({ text: "Fetch complete", variant: "success" });
      }
    });
  };

  // Two calls in one tick start one fetch: the network gate refuses a run while one is in flight.
  // The pause is not checked here: useAutoFetch skips paused triggers, except the interval's
  // silent retry, which runs while paused so a dead network is noticed coming back.
  const autoFetch = () => {
    if (gates.fetch !== null) return;
    void track("fetch", () =>
      network.run((c) => fetchAll(repoId, c, { nonInteractive: true }), { prompt: false }),
    ).then((result) => {
      if (result.status === "ok") autoFetchState().recordFetched(repoId, Date.now());
      if (result.status !== "failed") return;
      // Once per streak: a failure while already paused stays silent.
      const wasPaused = entryFor(autoFetchState(), repoId).paused;
      autoFetchState().recordFailure(repoId);
      if (wasPaused) return;
      // A late failure for a closed tab, or after auto-fetch was turned off, is not announced.
      const tab = useRepoTabs.getState().tabs.find((t) => t.id === repoId);
      if (tab === undefined || !useSettings.getState().settings.fetch.auto) return;
      useToasts.getState().notify({
        text: `Auto-fetch failed (${tab.summary.name}): ${networkMessage(result.error).title}`,
        variant: "error",
        action: {
          label: "Fetch",
          // The toast outlives this instance (the pane remounts per tab): bring the repo's tab to
          // the front and let its mounted pane run the manual fetch. Both are no-ops for a
          // closed tab: `activate` ignores unknown ids and no pane of the repo is mounted.
          run: () => {
            useRepoTabs.getState().activate(repoId);
            useAutoFetchState.getState().requestManual(repoId);
          },
        },
      });
    });
  };

  const pull = (mode?: PullMode) => {
    if (gates.pull !== null) return;
    void start("pull", (c) => pullBranch(repoId, mode ?? defaultMode, c)).then((result) => {
      report(result);
      recordFailure(result);
      // A pull fetched whether it completed or stopped on conflicts.
      if (result.status === "ok") autoFetchState().recordFetched(repoId, Date.now());
      // A pull that stops on conflicts is surfaced by the OperationBanner, not a toast.
      if (result.status === "ok" && result.value === "completed") {
        useToasts.getState().notify({ text: "Pull complete", variant: "success" });
      }
    });
  };

  const push = () => {
    if (gates.push !== null) return;
    const local = branch as string;
    void start("push", (c) => pushBranch(repoId, { kind: "upstream" }, false, local, c)).then(
      (result) => {
        if (result.status === "failed" && result.error.kind === "noUpstream") {
          setPublishError(null);
          setPublishTo({ remotes: remoteNames, branch: local });
        } else {
          report(result);
          recordPush(result);
          if (result.status === "ok") toastPushed(local);
        }
      },
    );
  };

  const publish = (remote: string, name: string) => {
    // The branch captured when the dialog opened, not the live HEAD.
    const local = (publishTo as NonNullable<typeof publishTo>).branch;
    void start("push", (c) =>
      pushBranch(repoId, { kind: "setUpstream", remote, branch: name }, false, local, c),
    ).then((result) => {
      if (result.status === "failed" && DIALOG_ERRORS.has(result.error.kind)) {
        setPublishError(result.error);
        return;
      }
      setPublishTo(null);
      report(result);
      recordPush(result);
      if (result.status === "ok") toastPushed(local);
    });
  };

  const requestForcePush = () => {
    if (gates.forcePush !== null) return;
    const upstream = (tracking as NonNullable<typeof tracking>).upstream;
    setForcePush({ local: branch as string, remote: upstreamRemote ?? "", upstream });
  };

  const confirmForcePush = () => {
    // The branch the user confirmed, captured at request time; every retry pushes that branch.
    const local = (forcePush as NonNullable<typeof forcePush>).local;
    void start("push", (c) => pushBranch(repoId, { kind: "upstream" }, true, local, c)).then(
      (result) => {
        setForcePush(null);
        report(result);
        recordPush(result);
        if (result.status === "ok") toastPushed(local);
      },
    );
  };

  return {
    gates,
    upstream: upstreamText(head, tracking),
    upstreamRemote,
    running,
    fetch,
    autoFetch,
    pull,
    push,
    requestForcePush,
    message,
    dismissMessage: () => setMessage(null),
    prompt: network.prompt,
    setUpstream: publishTo && { ...publishTo, error: publishError },
    publish,
    cancelSetUpstream: () => setPublishTo(null),
    forcePush,
    confirmForcePush,
    cancelForcePush: () => setForcePush(null),
  };
}
