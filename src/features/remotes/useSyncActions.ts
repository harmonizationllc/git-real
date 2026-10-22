import { useState } from "react";
import { fetchAll, pull as pullBranch, push as pushBranch } from "../../lib/ipc";
import type { AppError, Credentials, PullMode, RepoId } from "../../lib/ipc";
import { useBranches } from "../branches/useBranches";
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

/** Errors the set-upstream dialog can fix in place, so it stays open with them. */
const DIALOG_ERRORS = new Set(["invalidBranchName", "remoteNotFound"]);

/** Fetch, pull and push of the current branch, behind the network gate. */
export function useSyncActions(repoId: RepoId): SyncActions {
  const { branches } = useBranches(repoId);
  const { remotes } = useRemotes(repoId);
  const defaultMode = usePullMode(repoId);
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
  const gates = syncGates(head, tracking, remotes?.length, network.pending);
  const upstreamRemote =
    tracking === null ? null : remoteOfUpstream(tracking.upstream, remoteNames);

  /** Runs one network action as `verb`: clears the last message and reports the verb until it settles. */
  const start = async <T>(
    verb: SyncVerb,
    action: (credentials: Credentials | null) => Promise<T>,
  ): Promise<NetworkResult<T>> => {
    setMessage(null);
    setRunning(verb);
    const result = await network.run(action);
    setRunning(null);
    return result;
  };

  const report = (result: NetworkResult<unknown>) => {
    if (result.status === "failed") setMessage(networkMessage(result.error));
  };

  const fetch = () => {
    if (gates.fetch !== null) return;
    void start("fetch", (c) => fetchAll(repoId, c)).then(report);
  };

  const pull = (mode?: PullMode) => {
    if (gates.pull !== null) return;
    void start("pull", (c) => pullBranch(repoId, mode ?? defaultMode, c)).then(report);
  };

  const push = () => {
    if (gates.push !== null) return;
    const local = branch as string;
    void start("push", (c) => pushBranch(repoId, { kind: "upstream" }, false, local, c)).then(
      (result) => {
        if (result.status === "failed" && result.error.kind === "noUpstream") {
          setPublishError(null);
          setPublishTo({ remotes: remoteNames, branch: local });
        } else report(result);
      },
    );
  };

  const publish = (remote: string, name: string) => {
    const local = branch as string;
    void start("push", (c) =>
      pushBranch(repoId, { kind: "setUpstream", remote, branch: name }, false, local, c),
    ).then((result) => {
      if (result.status === "failed" && DIALOG_ERRORS.has(result.error.kind)) {
        setPublishError(result.error);
        return;
      }
      setPublishTo(null);
      report(result);
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
      },
    );
  };

  return {
    gates,
    upstream: upstreamText(head, tracking),
    upstreamRemote,
    running,
    fetch,
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
