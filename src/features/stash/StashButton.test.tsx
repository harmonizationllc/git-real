import { screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import type { RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getOperationState, getStatus, stashPush } from "../../lib/ipc";
import type { OperationState, RepoId } from "../../lib/ipc";
import { renderWithProviders } from "../../test/renderWithProviders";
import { statusEntry, workingStatus } from "../../test/stashFixtures";
import { IN_PROGRESS_TITLE } from "../merge/operationCopy";
import { StashButton } from "./StashButton";
import type { StashButtonProps } from "./StashButton";
import { useStashActions } from "./useStashActions";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  stashPush: vi.fn(),
  getStatus: vi.fn(),
  getOperationState: vi.fn(),
}));

const merging: OperationState = {
  kind: "merge",
  head: "a".repeat(40),
  branch: "feature",
  message: { subject: "Merge", body: "" },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getStatus).mockResolvedValue(workingStatus());
  vi.mocked(getOperationState).mockResolvedValue({ kind: "none" });
  vi.mocked(stashPush).mockResolvedValue(undefined);
});

/** A StashButton beside a focusable fallback target, as a host panel would provide. */
function Host(props: Partial<StashButtonProps> & { sibling?: RepoId }) {
  const fallback = useRef<HTMLDivElement>(null);
  const { sibling, ...rest } = props;
  return (
    <>
      <div ref={fallback} tabIndex={-1} data-testid="fallback" />
      <StashButton
        repoId={1}
        variant="text"
        fallbackFocus={fallback as RefObject<HTMLElement | null>}
        {...rest}
      />
      {sibling !== undefined && <Sibling repoId={sibling} />}
    </>
  );
}

/** Another component running a stash action through its own hook instance. */
function Sibling({ repoId }: { repoId: RepoId }) {
  const actions = useStashActions(repoId);
  return (
    <button type="button" onClick={() => void actions.push("x", false)}>
      sibling push
    </button>
  );
}

const textButton = () => screen.getByRole("button", { name: "Stash…" });
const iconButton = () => screen.getByRole("button", { name: "Stash changes…" });

// Contract (F10): the shared trigger renders per variant, with the gate's title.
describe("StashButton rendering", () => {
  it("icon variant renders + named Stash changes… with the default title", async () => {
    renderWithProviders(<Host variant="icon" />);
    await waitFor(() => expect(iconButton()).toBeEnabled());
    expect(iconButton()).toHaveTextContent("+");
    expect(iconButton()).toHaveAttribute("title", "Stash changes…");
  });

  it("text variant renders Stash… with the gate title", async () => {
    vi.mocked(getStatus).mockResolvedValue(workingStatus([]));
    renderWithProviders(<Host variant="text" />);
    await waitFor(() => expect(textButton()).toHaveAttribute("title", "No changes to stash"));
    expect(textButton()).toBeDisabled();
  });

  it("text variant has no title while it is enabled", async () => {
    renderWithProviders(<Host variant="text" />);
    await waitFor(() => expect(textButton()).toBeEnabled());
    expect(textButton()).not.toHaveAttribute("title");
  });

  it("shows the gate's reason as the icon variant's title during an operation", async () => {
    vi.mocked(getOperationState).mockResolvedValue(merging);
    renderWithProviders(<Host variant="icon" />);
    await waitFor(() => expect(iconButton()).toHaveAttribute("title", IN_PROGRESS_TITLE));
    expect(iconButton()).toBeDisabled();
  });

  it("applies the host's className", async () => {
    renderWithProviders(<Host variant="text" className="hostClass" />);
    expect(textButton()).toHaveClass("hostClass");
  });
});

// Contract: clicking opens the dialog; Cancel closes it.
describe("StashButton dialog", () => {
  it("opens the stash dialog on click", async () => {
    const { user } = renderWithProviders(<Host variant="text" />);
    await waitFor(() => expect(textButton()).toBeEnabled());
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(textButton());
    expect(await screen.findByRole("dialog", { name: "Stash changes" })).toBeInTheDocument();
  });

  it("closes the dialog on Cancel", async () => {
    const { user } = renderWithProviders(<Host variant="text" />);
    await waitFor(() => expect(textButton()).toBeEnabled());
    await user.click(textButton());
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

// Contract (F14): the button is busy while any stash action of the same repo runs.
describe("StashButton shared busy state", () => {
  it("is disabled while another component's stash push for the same repo is pending", async () => {
    vi.mocked(stashPush).mockReturnValue(new Promise(() => undefined));
    const { user } = renderWithProviders(<Host variant="text" sibling={1} />);
    await waitFor(() => expect(textButton()).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "sibling push" }));
    await waitFor(() => expect(textButton()).toBeDisabled());
  });

  it("is not disabled by a stash action pending on another repo", async () => {
    vi.mocked(stashPush).mockReturnValue(new Promise(() => undefined));
    const { user } = renderWithProviders(<Host variant="text" sibling={2} />);
    await waitFor(() => expect(textButton()).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "sibling push" }));
    await waitFor(() => expect(stashPush).toHaveBeenCalledOnce());
    expect(textButton()).toBeEnabled();
  });

  it("is disabled when the host passes disabled", async () => {
    renderWithProviders(<Host variant="text" disabled />);
    await waitFor(() => expect(getStatus).toHaveBeenCalled());
    expect(textButton()).toBeDisabled();
  });

  it("stays enabled when the host passes disabled false", async () => {
    renderWithProviders(<Host variant="text" disabled={false} />);
    await waitFor(() => expect(textButton()).toBeEnabled());
  });
});

// Contract (F9): a button that is disabled while it holds focus hands focus to the fallback.
describe("StashButton focus", () => {
  it("moves focus to the fallback when the button is disabled while focused", async () => {
    let pushed = false;
    vi.mocked(getStatus).mockImplementation(() =>
      Promise.resolve(pushed ? workingStatus([]) : workingStatus([statusEntry("a.txt")])),
    );
    vi.mocked(stashPush).mockImplementation(() => {
      pushed = true;
      return Promise.resolve(undefined);
    });
    const { user } = renderWithProviders(<Host variant="text" />);
    await waitFor(() => expect(textButton()).toBeEnabled());
    await user.click(textButton());
    await user.click(await screen.findByRole("button", { name: "Stash" }));
    await waitFor(() => expect(textButton()).toBeDisabled());
    await waitFor(() => expect(screen.getByTestId("fallback")).toHaveFocus());
  });

  it("keeps focus on the button while it stays enabled", async () => {
    const { user } = renderWithProviders(<Host variant="text" />);
    await waitFor(() => expect(textButton()).toBeEnabled());
    await user.click(textButton());
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(textButton()).toHaveFocus();
  });
});
