import { describe, expect, it } from "vitest";
import type { AppError, NetworkErrorKind } from "../../lib/ipc";
import { authError, networkError } from "../../test/remoteFixtures";
import { networkMessage } from "./networkMessage";

// Contract: each classified failure has verbatim title, hint and (optionally) one action,
// and git's output goes to details.
describe("networkMessage classified failures", () => {
  const cases: [
    Exclude<NetworkErrorKind, "other" | "httpsAuthRequired" | "httpsAuthRejected">,
    { title: string; hint: string; action: { kind: string; label: string } | null },
  ][] = [
    [
      "sshAuthFailed",
      {
        title: "SSH key was refused",
        hint: "Add your key to the agent with ssh-add, and check it is registered with the host.",
        action: null,
      },
    ],
    [
      "hostKeyUnverified",
      {
        title: "Host key not trusted",
        hint: "Connect once from a terminal (ssh -T <host>) to verify and save the host key.",
        action: null,
      },
    ],
    [
      "hostUnreachable",
      {
        title: "Could not reach the remote",
        hint: "Check your network connection and the remote URL.",
        action: null,
      },
    ],
    [
      "repoNotFound",
      {
        title: "Repository not found",
        hint: "Check the remote URL, and that your account can access it.",
        action: { kind: "editRemote", label: "Edit remote…" },
      },
    ],
    [
      "pushRejectedNonFastForward",
      {
        title: "The remote has commits you don't have",
        hint: "Pull, then push again.",
        action: { kind: "pull", label: "Pull" },
      },
    ],
    [
      "leaseStale",
      {
        title: "The remote branch moved since your last fetch",
        hint: "Fetch and review the new commits before forcing again.",
        action: { kind: "fetch", label: "Fetch" },
      },
    ],
  ];

  it.each(cases)(
    "should map %s to its verbatim copy with git's output as details",
    (kind, copy) => {
      expect(networkMessage(networkError(kind))).toEqual({ ...copy, details: "git output" });
    },
  );
});

// Contract: an unclassified failure names the verb and keeps git's output.
describe("networkMessage other", () => {
  it.each(["fetch", "pull", "push"] as const)(
    "should name the verb and keep git's output as details when a %s fails unclassified",
    (verb) => {
      expect(networkMessage(networkError("other", { verb }))).toEqual({
        title: `git ${verb} failed`,
        hint: null,
        action: null,
        details: "git output",
      });
    },
  );
});

// Contract: an HTTPS auth failure that reaches the message (no prompt possible) asks for a helper.
describe("networkMessage sign-in", () => {
  it("should ask for a credential helper when an HTTPS auth error has no origin to prompt for", () => {
    expect(networkMessage(authError("httpsAuthRequired")).title).toBe("Sign-in required");
  });

  it("should give the credential helper hint for httpsAuthRejected without an origin", () => {
    const error = networkError("httpsAuthRejected", { https: true, origin: null });
    expect(networkMessage(error)).toEqual({
      title: "Sign-in required",
      hint: "Set up a git credential helper for this host, then try again.",
      action: null,
      details: "git output",
    });
  });

  it("should give the same copy for an HTTPS auth error that cannot prompt", () => {
    const error = networkError("httpsAuthRequired", { https: true, origin: null });
    expect(networkMessage(error)).toEqual({
      title: "Sign-in required",
      hint: "Set up a git credential helper for this host, then try again.",
      action: null,
      details: "git output",
    });
  });
});

// Contract: errors raised before any network call have their own copy.
describe("networkMessage non-network kinds", () => {
  it("should offer Add remote… when there are no remotes", () => {
    expect(networkMessage({ kind: "noRemotes", message: "m" })).toEqual({
      title: "No remotes configured",
      hint: "Add a remote to fetch, pull or push.",
      action: { kind: "addRemote", label: "Add remote…" },
      details: null,
    });
  });

  it("should tell the user to check out a branch when HEAD is detached", () => {
    expect(networkMessage({ kind: "detachedHead", message: "m" })).toEqual({
      title: "Check out a branch to pull or push.",
      hint: null,
      action: null,
      details: null,
    });
  });

  it("should show the error's own message for any other kind", () => {
    expect(networkMessage({ kind: "operationInProgress", message: "m" })).toEqual({
      title: "m",
      hint: null,
      action: null,
      details: null,
    });
  });

  it("should treat networkFailed without a network payload like any other kind", () => {
    const error: AppError = { kind: "networkFailed", message: "plain" };
    expect(networkMessage(error)).toEqual({
      title: "plain",
      hint: null,
      action: null,
      details: null,
    });
  });
});
