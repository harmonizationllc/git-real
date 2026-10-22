import type { AppError, NetworkErrorKind } from "../../lib/ipc";

export type MessageAction = "pull" | "fetch" | "editRemote" | "addRemote";

export interface NetworkMessage {
  title: string;
  hint: string | null;
  action: { kind: MessageAction; label: string } | null;
  /** git's output for the Details disclosure; null when there is none worth showing. */
  details: string | null;
}

type Copy = Omit<NetworkMessage, "details">;

const SIGN_IN: Copy = {
  title: "Sign-in required",
  hint: "Set up a git credential helper for this host, then try again.",
  action: null,
};

const BY_KIND: Record<Exclude<NetworkErrorKind, "other">, Copy> = {
  httpsAuthRequired: SIGN_IN,
  httpsAuthRejected: SIGN_IN,
  sshAuthFailed: {
    title: "SSH key was refused",
    hint: "Add your key to the agent with ssh-add, and check it is registered with the host.",
    action: null,
  },
  hostKeyUnverified: {
    title: "Host key not trusted",
    hint: "Connect once from a terminal (ssh -T <host>) to verify and save the host key.",
    action: null,
  },
  hostUnreachable: {
    title: "Could not reach the remote",
    hint: "Check your network connection and the remote URL.",
    action: null,
  },
  repoNotFound: {
    title: "Repository not found",
    hint: "Check the remote URL, and that your account can access it.",
    action: { kind: "editRemote", label: "Edit remote…" },
  },
  pushRejectedNonFastForward: {
    title: "The remote has commits you don't have",
    hint: "Pull, then push again.",
    action: { kind: "pull", label: "Pull" },
  },
  leaseStale: {
    title: "The remote branch moved since your last fetch",
    hint: "Fetch and review the new commits before forcing again.",
    action: { kind: "fetch", label: "Fetch" },
  },
};

/** What to tell the user about a failed network or sync action. */
export function networkMessage(error: AppError): NetworkMessage {
  if (error.kind === "networkFailed" && error.network) {
    const { kind, verb } = error.network;
    const copy: Copy =
      kind === "other" ? { title: `git ${verb} failed`, hint: null, action: null } : BY_KIND[kind];
    return { ...copy, details: error.message };
  }
  switch (error.kind) {
    case "noRemotes":
      return {
        title: "No remotes configured",
        hint: "Add a remote to fetch, pull or push.",
        action: { kind: "addRemote", label: "Add remote…" },
        details: null,
      };
    case "detachedHead":
      return {
        title: "Check out a branch to pull or push.",
        hint: null,
        action: null,
        details: null,
      };
    default:
      return { title: error.message, hint: null, action: null, details: null };
  }
}
