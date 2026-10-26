import { beforeEach, describe, expect, it, vi } from "vitest";
import { useShell } from "./shell";
import type { RepoActions, ShellDialog } from "./shell";

beforeEach(() => {
  useShell.setState(useShell.getInitialState(), true);
});

const dummyRepoActions = (): RepoActions => ({
  repoId: 1,
  path: "/r/repo",
  gates: { fetch: null, pull: null, push: null },
  fetch: vi.fn(),
  pull: vi.fn(),
  push: vi.fn(),
  fileHistory: vi.fn(),
});

// Contract: starts empty; open, close and publishRepoActions work correctly.
describe("useShell initial state", () => {
  it("starts with no dialog and no repoActions", () => {
    expect(useShell.getState().dialog).toBeNull();
    expect(useShell.getState().repoActions).toBeNull();
  });
});

describe("useShell open", () => {
  it("open replaces the current dialog (mutually exclusive)", () => {
    useShell.getState().open({ kind: "palette" });
    useShell.getState().open({ kind: "shortcuts" });
    expect(useShell.getState().dialog).toEqual({ kind: "shortcuts" });
  });

  it("open settings with a section keeps the section", () => {
    useShell.getState().open({ kind: "settings", section: "git" });
    expect(useShell.getState().dialog).toEqual({ kind: "settings", section: "git" });
  });

  it("open palette sets dialog to palette", () => {
    useShell.getState().open({ kind: "palette" });
    expect(useShell.getState().dialog).toEqual({ kind: "palette" });
  });

  it("open shortcuts sets dialog to shortcuts", () => {
    useShell.getState().open({ kind: "shortcuts" });
    expect(useShell.getState().dialog).toEqual({ kind: "shortcuts" });
  });

  it("opening settings without a section has no section", () => {
    useShell.getState().open({ kind: "settings" });
    const d = useShell.getState().dialog as Extract<ShellDialog, { kind: "settings" }>;
    expect(d.kind).toBe("settings");
    expect(d.section).toBeUndefined();
  });
});

describe("useShell close", () => {
  it("close clears the dialog only", () => {
    useShell.getState().open({ kind: "palette" });
    const ra = dummyRepoActions();
    useShell.getState().publishRepoActions(ra);
    useShell.getState().close();
    expect(useShell.getState().dialog).toBeNull();
    expect(useShell.getState().repoActions).toBe(ra);
  });
});

describe("useShell publishRepoActions", () => {
  it("publishRepoActions sets the registry", () => {
    const ra = dummyRepoActions();
    useShell.getState().publishRepoActions(ra);
    expect(useShell.getState().repoActions).toBe(ra);
  });

  it("publishRepoActions clears when passed null", () => {
    useShell.getState().publishRepoActions(dummyRepoActions());
    useShell.getState().publishRepoActions(null);
    expect(useShell.getState().repoActions).toBeNull();
  });
});
