// GR-15 Cycle 1, Task 4 – tests for the About settings section.
//
// RED PHASE: `./AboutSettings` does not exist yet; every test in this file
// fails at module resolution time. `appVersion`, `checkForUpdate` are not
// yet exported from `../../lib/ipc`.

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../../lib/query/client";
import { useUpdatePrefs } from "../../lib/store/updatePrefs"; // RED: module missing
import { useToasts } from "../../lib/store/toasts";
import { renderWithProviders } from "../../test/renderWithProviders";
import type { UpdateInfo } from "../../lib/ipc";
import { AboutSettings } from "./AboutSettings"; // RED: module missing

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  appVersion: vi.fn(),
  checkForUpdate: vi.fn(),
  openExternal: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  queryClient.clear();
  useToasts.setState({ toasts: [] });
  useUpdatePrefs.setState(useUpdatePrefs.getInitialState(), true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function setup() {
  const { appVersion, checkForUpdate } = await import("../../lib/ipc");
  vi.mocked(appVersion).mockResolvedValue("0.1.0");
  vi.mocked(checkForUpdate).mockResolvedValue({
    current: "0.1.0",
    latest: null,
    available: false,
    url: null,
  });
  const view = renderWithProviders(<AboutSettings />);
  await screen.findByRole("heading", { level: 3, name: "About" });
  return view;
}

// Contract: renders the h3 "About" heading and the current version.
describe("AboutSettings render", () => {
  it("renders the About heading", async () => {
    await setup();
    expect(screen.getByRole("heading", { level: 3, name: "About" })).toBeInTheDocument();
  });

  it("renders the current version returned by appVersion", async () => {
    await setup();
    await screen.findByText(/0\.1\.0/);
  });

  it("renders the check-on-startup checkbox checked by default", async () => {
    await setup();
    const checkbox = screen.getByRole("checkbox", {
      name: /check for updates on startup/i,
    });
    expect(checkbox).toBeChecked();
  });

  it("renders the Check for updates button", async () => {
    await setup();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
  });

  it("renders the Source and issues button", async () => {
    await setup();
    expect(screen.getByRole("button", { name: "Source and issues" })).toBeInTheDocument();
  });
});

// Contract: the checkbox reflects and updates useUpdatePrefs.
describe("AboutSettings checkbox", () => {
  it("unchecking disables checkOnStartup", async () => {
    await setup();
    const checkbox = screen.getByRole("checkbox", {
      name: /check for updates on startup/i,
    });
    fireEvent.click(checkbox);
    expect(useUpdatePrefs.getState().checkOnStartup).toBe(false);
  });

  it("reflects an already-disabled preference", async () => {
    useUpdatePrefs.setState({ ...useUpdatePrefs.getInitialState(), checkOnStartup: false }, true);
    await setup();
    const checkbox = screen.getByRole("checkbox", {
      name: /check for updates on startup/i,
    });
    expect(checkbox).not.toBeChecked();
  });
});

// Contract: pressing "Check for updates" shows "Checking…" while busy.
describe("AboutSettings manual check button", () => {
  it("shows Checking… while the check is in progress", async () => {
    const { checkForUpdate } = await import("../../lib/ipc");
    let resolve!: (v: UpdateInfo) => void;
    vi.mocked(checkForUpdate).mockReturnValue(
      new Promise((res) => {
        resolve = res;
      }) as ReturnType<typeof checkForUpdate>,
    );
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(screen.getByRole("button", { name: "Checking…" })).toBeInTheDocument();
    await act(async () => {
      resolve({ current: "0.1.0", latest: null, available: false, url: null });
    });
  });

  it("the button is disabled while Checking…", async () => {
    const { checkForUpdate } = await import("../../lib/ipc");
    let resolve!: (v: UpdateInfo) => void;
    vi.mocked(checkForUpdate).mockReturnValue(
      new Promise((res) => {
        resolve = res;
      }) as ReturnType<typeof checkForUpdate>,
    );
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    await act(async () => {
      resolve({ current: "0.1.0", latest: null, available: false, url: null });
    });
  });
});

// Contract: shows a status element after a manual check.
describe("AboutSettings status", () => {
  it("shows a status element with up-to-date message when already latest", async () => {
    const { checkForUpdate } = await import("../../lib/ipc");
    await setup();
    vi.mocked(checkForUpdate).mockResolvedValue({
      current: "0.1.0",
      latest: "0.1.0",
      available: false,
      url: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(screen.getByRole("status").textContent).toMatch(/up to date/i);
  });

  it("shows No releases published yet when latest is null", async () => {
    const { checkForUpdate } = await import("../../lib/ipc");
    vi.mocked(checkForUpdate).mockResolvedValue({
      current: "0.1.0",
      latest: null,
      available: false,
      url: null,
    });
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(screen.getByRole("status").textContent).toMatch(/no releases published yet/i);
  });

  it("shows a Release notes button and a status when update is available", async () => {
    const { checkForUpdate } = await import("../../lib/ipc");
    await setup();
    vi.mocked(checkForUpdate).mockResolvedValue({
      current: "0.1.0",
      latest: "1.0.0",
      available: true,
      url: "https://github.com/harmonizationllc/git-real/releases/tag/v1.0.0",
    });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Release notes" })).toBeInTheDocument();
  });

  it("clicking Release notes opens the release URL via openExternal", async () => {
    const { checkForUpdate, openExternal } = await import("../../lib/ipc");
    const releaseUrl = "https://github.com/harmonizationllc/git-real/releases/tag/v1.0.0";
    await setup();
    vi.mocked(checkForUpdate).mockResolvedValue({
      current: "0.1.0",
      latest: "1.0.0",
      available: true,
      url: releaseUrl,
    });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => screen.getByRole("button", { name: "Release notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Release notes" }));
    expect(openExternal).toHaveBeenCalledWith(releaseUrl);
  });

  it("shows no Release notes button when available but url is null", async () => {
    const { checkForUpdate } = await import("../../lib/ipc");
    await setup();
    vi.mocked(checkForUpdate).mockResolvedValue({
      current: "0.1.0",
      latest: "1.0.0",
      available: true,
      url: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Release notes" })).not.toBeInTheDocument();
  });

  it("shows an alert with the error message when check fails", async () => {
    const { checkForUpdate } = await import("../../lib/ipc");
    await setup();
    vi.mocked(checkForUpdate).mockRejectedValue({
      kind: "updateCheckFailed",
      message: "rate limited",
    });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).toMatch(/rate limited/);
  });

  it("manual check leaves lastCheckedAt unchanged", async () => {
    const { checkForUpdate } = await import("../../lib/ipc");
    useUpdatePrefs.setState({ ...useUpdatePrefs.getInitialState(), lastCheckedAt: null }, true);
    await setup();
    vi.mocked(checkForUpdate).mockResolvedValue({
      current: "0.1.0",
      latest: "0.1.0",
      available: false,
      url: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    expect(useUpdatePrefs.getState().lastCheckedAt).toBeNull();
  });
});

// Contract: "Source and issues" calls openExternal with the repo URL.
describe("AboutSettings source and issues", () => {
  it("Source and issues opens the repo URL via openExternal", async () => {
    const { openExternal } = await import("../../lib/ipc");
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Source and issues" }));
    expect(openExternal).toHaveBeenCalledWith("https://github.com/harmonizationllc/git-real");
  });
});
