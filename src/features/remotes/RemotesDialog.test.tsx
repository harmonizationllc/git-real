import { act, screen, waitFor, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addRemote, fetchAll, listRemotes, removeRemote, updateRemote } from "../../lib/ipc";
import type { AppError, RemoteInfo } from "../../lib/ipc";
import { authError, networkError, remoteInfo } from "../../test/remoteFixtures";
import { renderWithProviders } from "../../test/renderWithProviders";
import { RemotesDialog } from "./RemotesDialog";
import { useNetworkAction } from "./useNetworkAction";
import type { RemotesDialogProps } from "./RemotesDialog";

vi.mock(import("../../lib/ipc"), async (importOriginal) => ({
  ...(await importOriginal()),
  listRemotes: vi.fn(),
  addRemote: vi.fn(),
  updateRemote: vi.fn(),
  removeRemote: vi.fn(),
  fetchAll: vi.fn(),
}));

let remotes: RemoteInfo[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  remotes = [remoteInfo("origin", { fetchUrl: "/srv/origin.git" })];
  vi.mocked(listRemotes).mockImplementation(() => Promise.resolve(remotes));
  vi.mocked(addRemote).mockImplementation((_id, name, url, pushUrl) => {
    remotes = [...remotes, { name, fetchUrl: url, pushUrl }];
    return Promise.resolve();
  });
  vi.mocked(updateRemote).mockImplementation((_id, name, newName, url, pushUrl) => {
    remotes = remotes.map((r) => (r.name === name ? { name: newName, fetchUrl: url, pushUrl } : r));
    return Promise.resolve();
  });
  vi.mocked(removeRemote).mockImplementation((_id, name) => {
    remotes = remotes.filter((r) => r.name !== name);
    return Promise.resolve();
  });
  vi.mocked(fetchAll).mockResolvedValue(undefined);
});

function renderDialog(over: Partial<RemotesDialogProps> = {}) {
  const props: RemotesDialogProps = {
    repoId: 1,
    target: { mode: "list" },
    onClose: vi.fn(),
    ...over,
  };
  return { props, ...renderWithProviders(<RemotesDialog {...props} />) };
}

const nameField = () => screen.getByLabelText("Name");
const urlField = () => screen.getByLabelText("URL");
const pushField = () => screen.getByLabelText("Push URL (optional)");
const fetchBox = () => screen.getByRole("checkbox", { name: "Fetch after adding" });
const addButton = () => screen.getByRole("button", { name: "Add" });
const saveButton = () => screen.getByRole("button", { name: "Save" });
const button = (name: string) => screen.getByRole("button", { name });

async function renderList(over: Partial<RemotesDialogProps> = {}) {
  const view = renderDialog(over);
  await screen.findByRole("list", { name: "Remotes" });
  return view;
}

type View = Awaited<ReturnType<typeof renderList>>;

/** Opens the add form from the list and fills Name and URL (and the push URL when given). */
async function fillAdd(view: View, name: string, url: string, push = "") {
  await view.user.click(button("Add remote"));
  await view.user.type(nameField(), name);
  await view.user.type(urlField(), url);
  if (push !== "") await view.user.type(pushField(), push);
}

// Contract: the list view shows every remote with its fetch URL, and a push URL only when it differs.
describe("RemotesDialog list", () => {
  it("titles the dialog Remotes and lists each remote's name and fetch URL", async () => {
    remotes = [remoteInfo("origin"), remoteInfo("up", { fetchUrl: "https://x/up.git" })];
    renderDialog();
    await screen.findByRole("list", { name: "Remotes" });
    expect(screen.getByRole("dialog", { name: "Remotes" })).toHaveAttribute("aria-modal", "true");
    const items = within(screen.getByRole("list", { name: "Remotes" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("origin");
    expect(items[0]).toHaveTextContent("/srv/origin.git");
    expect(items[1]).toHaveTextContent("https://x/up.git");
  });

  it("shows the push URL only when it differs from the fetch URL", async () => {
    remotes = [
      remoteInfo("origin", { pushUrl: "/srv/push.git" }),
      remoteInfo("same", { fetchUrl: "/srv/same.git", pushUrl: "/srv/same.git" }),
    ];
    renderDialog();
    await screen.findByRole("list", { name: "Remotes" });
    expect(screen.getByText("/srv/push.git")).toBeInTheDocument();
    expect(screen.getAllByText("/srv/same.git")).toHaveLength(1);
  });

  it("shows No remotes when there are none", async () => {
    remotes = [];
    renderDialog();
    expect(await screen.findByText("No remotes")).toBeInTheDocument();
  });

  it("offers Edit and Remove buttons labelled with the remote's name", async () => {
    await renderList();
    expect(button("Edit origin")).toBeInTheDocument();
    expect(button("Remove origin")).toBeInTheDocument();
  });

  it("offers Add remote and Close below the list", async () => {
    await renderList();
    expect(button("Add remote")).toBeInTheDocument();
    expect(button("Close")).toBeInTheDocument();
  });
});

// Contract: Add remote opens an empty form; Add needs a name and a URL.
describe("RemotesDialog add form", () => {
  it("opens an empty form with Fetch after adding checked and focuses Name", async () => {
    const view = await renderList();
    await view.user.click(button("Add remote"));
    expect(nameField()).toHaveValue("");
    expect(urlField()).toHaveValue("");
    expect(pushField()).toHaveValue("");
    expect(fetchBox()).toBeChecked();
    expect(nameField()).toHaveFocus();
  });

  it("disables Add until Name and URL have text", async () => {
    const view = await renderList();
    await view.user.click(button("Add remote"));
    expect(addButton()).toBeDisabled();
    await view.user.type(nameField(), "up");
    expect(addButton()).toBeDisabled();
    await view.user.type(urlField(), "/srv/up.git");
    expect(addButton()).toBeEnabled();
  });

  it("keeps Add disabled for a blank name or a blank URL", async () => {
    const view = await renderList();
    await view.user.click(button("Add remote"));
    await view.user.type(nameField(), "   ");
    await view.user.type(urlField(), "/srv/up.git");
    expect(addButton()).toBeDisabled();
    await view.user.clear(nameField());
    await view.user.type(nameField(), "up");
    await view.user.clear(urlField());
    await view.user.type(urlField(), "   ");
    expect(addButton()).toBeDisabled();
  });

  it("Cancel returns to the list without calling addRemote", async () => {
    const view = await renderList();
    await view.user.click(button("Add remote"));
    await view.user.click(button("Cancel"));
    expect(screen.getByRole("list", { name: "Remotes" })).toBeInTheDocument();
    expect(addRemote).not.toHaveBeenCalled();
  });

  it("an add target opens the add form", async () => {
    renderDialog({ target: { mode: "add" } });
    expect(await screen.findByLabelText("Name")).toHaveValue("");
    expect(fetchBox()).toBeChecked();
  });

  it("shows Working… and disables the form while adding", async () => {
    let resolve!: () => void;
    vi.mocked(addRemote).mockReturnValue(new Promise<void>((r) => (resolve = r)));
    const view = await renderList();
    await fillAdd(view, "up", "/srv/up.git");
    await view.user.click(addButton());
    expect(await screen.findByRole("button", { name: "Working…" })).toBeDisabled();
    resolve();
  });
});

// Contract: a successful add sends trimmed values, fetches by default, and returns to the list.
describe("RemotesDialog add", () => {
  it("adds with a null push URL, then fetches, then returns to the list", async () => {
    const view = await renderList();
    await fillAdd(view, "up", "/srv/up.git");
    await view.user.click(addButton());
    await waitFor(() => expect(fetchAll).toHaveBeenCalledExactlyOnceWith(1, null));
    expect(addRemote).toHaveBeenCalledExactlyOnceWith(1, "up", "/srv/up.git", null);
    expect(await screen.findByRole("list", { name: "Remotes" })).toHaveTextContent("up");
  });

  it("fetches only after the add has succeeded", async () => {
    const order: string[] = [];
    vi.mocked(addRemote).mockImplementation(() => {
      order.push("add");
      return Promise.resolve();
    });
    vi.mocked(fetchAll).mockImplementation(() => {
      order.push("fetch");
      return Promise.resolve();
    });
    const view = await renderList();
    await fillAdd(view, "up", "/srv/up.git");
    await view.user.click(addButton());
    await waitFor(() => expect(order).toEqual(["add", "fetch"]));
  });

  it("sends a filled push URL", async () => {
    const view = await renderList();
    await fillAdd(view, "up", "/srv/up.git", "/srv/push.git");
    await view.user.click(addButton());
    await waitFor(() => expect(addRemote).toHaveBeenCalled());
    expect(addRemote).toHaveBeenCalledExactlyOnceWith(1, "up", "/srv/up.git", "/srv/push.git");
  });

  it("trims name, URL and push URL", async () => {
    const view = await renderList();
    await fillAdd(view, "  up  ", "  /srv/up.git ", "  /srv/p.git ");
    await view.user.click(addButton());
    await waitFor(() => expect(addRemote).toHaveBeenCalled());
    expect(addRemote).toHaveBeenCalledExactlyOnceWith(1, "up", "/srv/up.git", "/srv/p.git");
  });

  it("sends a whitespace-only push URL as null", async () => {
    const view = await renderList();
    await fillAdd(view, "up", "/srv/up.git", "   ");
    await view.user.click(addButton());
    await waitFor(() => expect(addRemote).toHaveBeenCalled());
    expect(addRemote).toHaveBeenCalledExactlyOnceWith(1, "up", "/srv/up.git", null);
  });

  it("skips the fetch when Fetch after adding is unchecked", async () => {
    const view = await renderList();
    await fillAdd(view, "up", "/srv/up.git");
    await view.user.click(fetchBox());
    await view.user.click(addButton());
    expect(await screen.findByRole("list", { name: "Remotes" })).toHaveTextContent("up");
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it("does not fetch when the add fails", async () => {
    vi.mocked(addRemote).mockRejectedValue({ kind: "remoteExists", message: "x" });
    const view = await renderList();
    await fillAdd(view, "origin", "/srv/o.git");
    await view.user.click(addButton());
    await screen.findByRole("alert");
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it("shows the credential dialog when the fetch after adding needs sign-in, then retries", async () => {
    vi.mocked(fetchAll).mockRejectedValueOnce(authError()).mockResolvedValue(undefined);
    const view = await renderList();
    await fillAdd(view, "up", "https://github.com/x/up.git");
    await view.user.click(addButton());
    const sign = await screen.findByRole("dialog", { name: "Sign in to github.com" });
    await view.user.type(within(sign).getByRole("textbox", { name: "Username" }), "me");
    await view.user.type(within(sign).getByLabelText("Token or password"), "tok");
    await view.user.click(within(sign).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(fetchAll).toHaveBeenCalledTimes(2));
    expect(fetchAll).toHaveBeenLastCalledWith(1, {
      origin: "https://github.com",
      username: "me",
      token: "tok",
    });
  });

  it("keeps the credentials out of the mutation cache after the fetch settles", async () => {
    vi.mocked(fetchAll).mockRejectedValueOnce(authError()).mockResolvedValue(undefined);
    const view = await renderList();
    await fillAdd(view, "up", "https://github.com/x/up.git");
    await view.user.click(addButton());
    const sign = await screen.findByRole("dialog", { name: "Sign in to github.com" });
    await view.user.type(within(sign).getByRole("textbox", { name: "Username" }), "me");
    await view.user.type(within(sign).getByLabelText("Token or password"), "tok");
    await view.user.click(within(sign).getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(fetchAll).toHaveBeenCalledTimes(2));
    await screen.findByRole("list", { name: "Remotes" });
    const cached = view.queryClient
      .getMutationCache()
      .getAll()
      .filter((m) => JSON.stringify(m.options.mutationKey).includes("network"));
    expect(cached).toEqual([]);
  });

  it("cancelling the credential dialog keeps the remote and shows no error", async () => {
    vi.mocked(fetchAll).mockRejectedValue(authError());
    const view = await renderList();
    await fillAdd(view, "up", "https://github.com/x/up.git");
    await view.user.click(addButton());
    const sign = await screen.findByRole("dialog", { name: "Sign in to github.com" });
    await view.user.click(within(sign).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("list", { name: "Remotes" })).toHaveTextContent("up");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the remote and shows a NetworkError above the list when the fetch after adding fails", async () => {
    vi.mocked(fetchAll).mockRejectedValue(
      networkError("hostUnreachable", { verb: "fetch" }, "ssh: connect failed"),
    );
    const view = await renderList();
    await fillAdd(view, "up", "/srv/up.git");
    await view.user.click(addButton());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not reach the remote");
    expect(screen.getByRole("list", { name: "Remotes" })).toHaveTextContent("up");
    expect(addRemote).toHaveBeenCalledOnce();
  });

  it("dismisses the NetworkError", async () => {
    vi.mocked(fetchAll).mockRejectedValue(networkError("hostUnreachable", { verb: "fetch" }));
    const view = await renderList();
    await fillAdd(view, "up", "/srv/up.git");
    await view.user.click(addButton());
    await screen.findByRole("alert");
    await view.user.click(button("Dismiss"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// Contract: add errors that belong to a field show under it and keep the form's values.
describe("RemotesDialog add errors", () => {
  async function failAdd(error: AppError, name = "bad name", url = "/srv/x.git", push = "") {
    vi.mocked(addRemote).mockRejectedValue(error);
    const view = await renderList();
    await fillAdd(view, name, url, push);
    await view.user.click(addButton());
    return view;
  }

  it("shows invalidRemoteName under Name", async () => {
    await failAdd({ kind: "invalidRemoteName", message: "raw" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("bad name is not a valid remote name.");
    expect(nameField()).toHaveAccessibleDescription(alert.textContent as string);
    expect(urlField()).not.toHaveAccessibleDescription(alert.textContent as string);
  });

  it("shows remoteExists under Name", async () => {
    await failAdd({ kind: "remoteExists", message: "raw" }, "origin");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("A remote named origin already exists.");
    expect(nameField()).toHaveAccessibleDescription(alert.textContent as string);
  });

  it("shows invalidRemoteUrl under URL", async () => {
    await failAdd({ kind: "invalidRemoteUrl", message: "raw" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Enter a valid URL.");
    expect(urlField()).toHaveAccessibleDescription(alert.textContent as string);
    expect(nameField()).not.toHaveAccessibleDescription(alert.textContent as string);
  });

  it("shows an invalid push URL under Push URL", async () => {
    await failAdd({ kind: "invalidRemoteUrl", message: "raw" }, "up", "/srv/up.git", "bad");
    const alert = await screen.findByRole("alert");
    expect(pushField()).toHaveAccessibleDescription(alert.textContent as string);
    expect(urlField()).not.toHaveAccessibleDescription(alert.textContent as string);
  });

  it("keeps the form's values after a field error", async () => {
    await failAdd({ kind: "invalidRemoteUrl", message: "raw" }, "up", "bad url", "/srv/p.git");
    await screen.findByRole("alert");
    expect(nameField()).toHaveValue("up");
    expect(urlField()).toHaveValue("bad url");
    expect(pushField()).toHaveValue("/srv/p.git");
  });

  it("clears the field error when the form is retried", async () => {
    const view = await failAdd({ kind: "invalidRemoteUrl", message: "raw" }, "up", "bad");
    await screen.findByRole("alert");
    vi.mocked(addRemote).mockResolvedValue(undefined);
    await view.user.click(addButton());
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows any other add error as a message above the list", async () => {
    vi.mocked(addRemote).mockRejectedValue({ kind: "io", message: "disk full" });
    const view = await renderList();
    await fillAdd(view, "up", "/srv/up.git");
    await view.user.click(addButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
  });
});

// Contract: Edit opens the form prefilled; Save sends the changes; the push URL can be cleared.
describe("RemotesDialog edit", () => {
  beforeEach(() => {
    remotes = [
      remoteInfo("origin", { fetchUrl: "/srv/origin.git", pushUrl: "/srv/push.git" }),
      remoteInfo("up"),
    ];
  });

  it("opens the form prefilled with the remote's name, URL and push URL", async () => {
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    expect(nameField()).toHaveValue("origin");
    expect(urlField()).toHaveValue("/srv/origin.git");
    expect(pushField()).toHaveValue("/srv/push.git");
  });

  it("has no Fetch after adding option and offers Save instead of Add", async () => {
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    expect(screen.queryByRole("checkbox", { name: "Fetch after adding" })).toBeNull();
    expect(saveButton()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  it("Save calls updateRemote with the changed URL", async () => {
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    await view.user.clear(urlField());
    await view.user.type(urlField(), "/srv/new.git");
    await view.user.click(saveButton());
    await waitFor(() => expect(updateRemote).toHaveBeenCalled());
    expect(updateRemote).toHaveBeenCalledExactlyOnceWith(
      1,
      "origin",
      "origin",
      "/srv/new.git",
      "/srv/push.git",
    );
  });

  it("Save renames the remote", async () => {
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    await view.user.clear(nameField());
    await view.user.type(nameField(), "main-remote");
    await view.user.click(saveButton());
    await waitFor(() => expect(updateRemote).toHaveBeenCalled());
    expect(updateRemote).toHaveBeenCalledExactlyOnceWith(
      1,
      "origin",
      "main-remote",
      "/srv/origin.git",
      "/srv/push.git",
    );
  });

  it("Save with an emptied push URL sends null", async () => {
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    await view.user.clear(pushField());
    await view.user.click(saveButton());
    await waitFor(() => expect(updateRemote).toHaveBeenCalled());
    expect(updateRemote).toHaveBeenCalledExactlyOnceWith(
      1,
      "origin",
      "origin",
      "/srv/origin.git",
      null,
    );
  });

  it("returns to the list showing the new name after Save", async () => {
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    await view.user.clear(nameField());
    await view.user.type(nameField(), "renamed");
    await view.user.click(saveButton());
    expect(await screen.findByRole("list", { name: "Remotes" })).toHaveTextContent("renamed");
    expect(screen.queryByText("origin")).toBeNull();
  });

  it("does not fetch after saving", async () => {
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    await view.user.click(saveButton());
    await screen.findByRole("list", { name: "Remotes" });
    expect(fetchAll).not.toHaveBeenCalled();
  });

  it("disables Save when the name or URL is emptied", async () => {
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    await view.user.clear(nameField());
    expect(saveButton()).toBeDisabled();
    await view.user.type(nameField(), "origin");
    await view.user.clear(urlField());
    expect(saveButton()).toBeDisabled();
  });

  it("shows remoteExists under Name when renaming onto another remote", async () => {
    vi.mocked(updateRemote).mockRejectedValue({ kind: "remoteExists", message: "raw" });
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    await view.user.clear(nameField());
    await view.user.type(nameField(), "up");
    await view.user.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("A remote named up already exists.");
    expect(nameField()).toHaveValue("up");
  });

  it("shows invalidRemoteUrl under URL on Save", async () => {
    vi.mocked(updateRemote).mockRejectedValue({ kind: "invalidRemoteUrl", message: "raw" });
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    await view.user.clear(pushField());
    await view.user.click(saveButton());
    const alert = await screen.findByRole("alert");
    expect(urlField()).toHaveAccessibleDescription(alert.textContent as string);
  });

  it("shows an invalid push URL under Push URL on Save", async () => {
    vi.mocked(updateRemote).mockRejectedValue({ kind: "invalidRemoteUrl", message: "raw" });
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    await view.user.click(saveButton());
    const alert = await screen.findByRole("alert");
    expect(pushField()).toHaveAccessibleDescription(alert.textContent as string);
    expect(urlField()).not.toHaveAccessibleDescription(alert.textContent as string);
  });

  it("shows any other Save error as a message", async () => {
    vi.mocked(updateRemote).mockRejectedValue({
      kind: "remoteNotFound",
      message: "no such remote",
    });
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    await view.user.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("no such remote");
  });

  it("an edit target opens the form for that remote directly", async () => {
    renderDialog({ target: { mode: "edit", name: "up" } });
    await waitFor(() => expect(nameField()).toHaveValue("up"));
    expect(urlField()).toHaveValue("/srv/up.git");
  });

  it("Cancel on a directly opened edit form returns to the list", async () => {
    const view = renderDialog({ target: { mode: "edit", name: "up" } });
    await waitFor(() => expect(nameField()).toHaveValue("up"));
    await view.user.click(button("Cancel"));
    expect(screen.getByRole("list", { name: "Remotes" })).toBeInTheDocument();
    expect(updateRemote).not.toHaveBeenCalled();
  });

  it("an edit target naming a missing remote shows the list", async () => {
    renderDialog({ target: { mode: "edit", name: "ghost" } });
    expect(await screen.findByRole("list", { name: "Remotes" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});

// Contract: Remove asks for confirmation naming the remote and only then calls removeRemote.
describe("RemotesDialog remove", () => {
  async function openRemove(view: View) {
    await view.user.click(button("Remove origin"));
    return screen.findByRole("dialog", { name: "Remove remote origin?" });
  }

  it("asks Remove remote origin? with the body", async () => {
    const view = await renderList();
    const confirm = await openRemove(view);
    expect(confirm).toHaveTextContent(
      "Its remote-tracking branches are deleted locally. Nothing changes on the server.",
    );
    expect(removeRemote).not.toHaveBeenCalled();
  });

  it("Remove calls removeRemote and the list drops the remote", async () => {
    remotes = [remoteInfo("origin"), remoteInfo("up")];
    const view = await renderList();
    const confirm = await openRemove(view);
    await view.user.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeRemote).toHaveBeenCalledExactlyOnceWith(1, "origin"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Remove remote origin?" })).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Remotes" })).not.toHaveTextContent("origin"),
    );
  });

  it("Cancel does not call removeRemote and keeps the remote listed", async () => {
    const view = await renderList();
    const confirm = await openRemove(view);
    await view.user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(removeRemote).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Remove remote origin?" })).toBeNull();
    expect(screen.getByRole("list", { name: "Remotes" })).toHaveTextContent("origin");
  });

  it("shows a failed remove as a message above the list", async () => {
    vi.mocked(removeRemote).mockRejectedValue({ kind: "remoteNotFound", message: "already gone" });
    const view = await renderList();
    const confirm = await openRemove(view);
    await view.user.click(within(confirm).getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already gone");
  });
});

// Contract: Close and Escape close the dialog; Escape in a form only returns to the list.
describe("RemotesDialog closing", () => {
  it("Close calls onClose", async () => {
    const view = await renderList();
    await view.user.click(button("Close"));
    expect(view.props.onClose).toHaveBeenCalledOnce();
  });

  it("Escape in the list calls onClose", async () => {
    const view = await renderList();
    await view.user.keyboard("{Escape}");
    expect(view.props.onClose).toHaveBeenCalledOnce();
  });

  it("Escape inside the form returns to the list without closing", async () => {
    const view = await renderList();
    await view.user.click(button("Add remote"));
    await view.user.keyboard("{Escape}");
    expect(screen.getByRole("list", { name: "Remotes" })).toBeInTheDocument();
    expect(view.props.onClose).not.toHaveBeenCalled();
  });

  it("Escape in an edit form returns to the list without closing", async () => {
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    await view.user.keyboard("{Escape}");
    expect(screen.getByRole("list", { name: "Remotes" })).toBeInTheDocument();
    expect(view.props.onClose).not.toHaveBeenCalled();
  });

  it("does not call onClose when the dialog body is clicked", async () => {
    const view = await renderList();
    await view.user.click(screen.getByRole("dialog", { name: "Remotes" }));
    expect(view.props.onClose).not.toHaveBeenCalled();
  });
});

// Contract: on close, focus returns to the opener unless it is gone; then to the fallback.
describe("RemotesDialog focus on close", () => {
  function Harness({ openerDisabled = false }: { openerDisabled?: boolean }) {
    const [open, setOpen] = useState(false);
    const fallback = useRef<HTMLDivElement>(null);
    return (
      <>
        <div ref={fallback} tabIndex={-1} data-testid="fallback" />
        <button type="button" disabled={openerDisabled} onClick={() => setOpen(true)}>
          Opener
        </button>
        {open && (
          <RemotesDialog
            repoId={1}
            target={{ mode: "list" }}
            onClose={() => setOpen(false)}
            fallbackFocus={fallback}
          />
        )}
      </>
    );
  }

  it("returns focus to the opener when it closes", async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Opener" }));
    await user.click(await screen.findByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });

  it("returns focus to the opener when closed with Escape", async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Opener" }));
    await screen.findByRole("list", { name: "Remotes" });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Opener" })).toHaveFocus();
  });

  it("returns focus to the fallback when the opener is gone", async () => {
    const { user, rerender } = renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "Opener" }));
    await screen.findByRole("list", { name: "Remotes" });
    rerender(<Harness openerDisabled />);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("fallback")).toHaveFocus();
  });
});

// Contract (architect R2): the confirm and sign-in dialogs are siblings after the Remotes box, sign-in last.
describe("RemotesDialog nested dialogs", () => {
  it("Escape in the remove confirm cancels it and leaves the Remotes dialog open", async () => {
    const view = await renderList();
    await view.user.click(button("Remove origin"));
    await screen.findByRole("dialog", { name: "Remove remote origin?" });
    await view.user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Remove remote origin?" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Remotes" })).toBeInTheDocument();
    expect(view.props.onClose).not.toHaveBeenCalled();
  });

  it("the remove confirm is not inside the Remotes dialog or its backdrop", async () => {
    const view = await renderList();
    await view.user.click(button("Remove origin"));
    const confirm = await screen.findByRole("dialog", { name: "Remove remote origin?" });
    const box = screen.getByRole("dialog", { name: "Remotes" });
    expect(box.contains(confirm)).toBe(false);
    expect((box.parentElement as HTMLElement).contains(confirm)).toBe(false);
  });

  it("a sign-in prompt during fetch-after-add is the last dialog in the document", async () => {
    vi.mocked(fetchAll).mockRejectedValue(authError());
    const view = await renderList();
    await fillAdd(view, "up", "https://github.com/x/up.git");
    await view.user.click(addButton());
    await screen.findByRole("dialog", { name: "Sign in to github.com" });
    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs.at(-1)).toHaveAccessibleName("Sign in to github.com");
    expect(dialogs[0]).toHaveAccessibleName("Remotes");
    expect(dialogs[0]?.contains(dialogs.at(-1) as HTMLElement)).toBe(false);
  });

  it("Escape in the sign-in prompt does not close the Remotes dialog", async () => {
    vi.mocked(fetchAll).mockRejectedValue(authError());
    const view = await renderList();
    await fillAdd(view, "up", "https://github.com/x/up.git");
    await view.user.click(addButton());
    await screen.findByRole("dialog", { name: "Sign in to github.com" });
    await view.user.keyboard("{Escape}");
    expect(view.props.onClose).not.toHaveBeenCalled();
  });
});

// Contract (architect R3): focus survives view switches so Escape keeps working.
describe("RemotesDialog focus across views", () => {
  it("Cancel in the edit form focuses the Edit button again, and Escape then closes", async () => {
    const view = await renderList();
    await view.user.click(button("Edit origin"));
    await view.user.click(button("Cancel"));
    expect(button("Edit origin")).toHaveFocus();
    await view.user.keyboard("{Escape}");
    expect(view.props.onClose).toHaveBeenCalledOnce();
  });

  it("Cancel in the add form focuses Add remote again", async () => {
    const view = await renderList();
    await view.user.click(button("Add remote"));
    await view.user.click(button("Cancel"));
    expect(button("Add remote")).toHaveFocus();
  });

  it("Escape in the form returns focus to the opener button", async () => {
    const view = await renderList();
    await view.user.click(button("Add remote"));
    await view.user.keyboard("{Escape}");
    expect(button("Add remote")).toHaveFocus();
  });

  it("after removing a remote, focus is inside the Remotes dialog", async () => {
    const view = await renderList();
    await view.user.click(button("Remove origin"));
    const confirm = await screen.findByRole("dialog", { name: "Remove remote origin?" });
    await view.user.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Remove remote origin?" })).toBeNull(),
    );
    const box = screen.getByRole("dialog", { name: "Remotes" });
    expect(box.contains(document.activeElement)).toBe(true);
  });

  it("after cancelling the sign-in prompt, focus is inside the Remotes dialog", async () => {
    vi.mocked(fetchAll).mockRejectedValue(authError());
    const view = await renderList();
    await fillAdd(view, "up", "https://github.com/x/up.git");
    await view.user.click(addButton());
    const sign = await screen.findByRole("dialog", { name: "Sign in to github.com" });
    await view.user.click(within(sign).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1));
    expect(screen.getByRole("dialog", { name: "Remotes" }).contains(document.activeElement)).toBe(
      true,
    );
  });
});

// Contract (architect R6): the dialog's busy state is its own; while busy it cannot be dismissed.
describe("RemotesDialog busy state", () => {
  function Other() {
    const network = useNetworkAction(1);
    return (
      <button type="button" onClick={() => void network.run(() => fetchAll(1, null))}>
        Other fetch
      </button>
    );
  }

  it("the form is not Working… while another network action runs", async () => {
    let resolve!: () => void;
    vi.mocked(fetchAll).mockReturnValue(new Promise<void>((r) => (resolve = r)));
    const { user } = renderWithProviders(
      <>
        <Other />
        <RemotesDialog repoId={1} target={{ mode: "add" }} onClose={vi.fn()} />
      </>,
    );
    await screen.findByLabelText("Name");
    await user.click(screen.getByRole("button", { name: "Other fetch" }));
    await waitFor(() => expect(fetchAll).toHaveBeenCalled());
    await user.type(nameField(), "up");
    await user.type(urlField(), "/srv/up.git");
    expect(screen.queryByRole("button", { name: "Working…" })).toBeNull();
    expect(addButton()).toBeEnabled();
    await act(async () => resolve());
  });

  it("Close, Edit and Remove are disabled during fetch after adding", async () => {
    let resolve!: () => void;
    vi.mocked(fetchAll).mockReturnValue(new Promise<void>((r) => (resolve = r)));
    const view = await renderList();
    await fillAdd(view, "up", "/srv/up.git");
    await view.user.click(addButton());
    await waitFor(() => expect(fetchAll).toHaveBeenCalled());
    await screen.findByRole("list", { name: "Remotes" });
    expect(button("Close")).toBeDisabled();
    expect(button("Edit origin")).toBeDisabled();
    expect(button("Remove origin")).toBeDisabled();
    await act(async () => resolve());
  });

  it("Escape does not close the dialog during fetch after adding", async () => {
    let resolve!: () => void;
    vi.mocked(fetchAll).mockReturnValue(new Promise<void>((r) => (resolve = r)));
    const view = await renderList();
    await fillAdd(view, "up", "/srv/up.git");
    await view.user.click(addButton());
    await waitFor(() => expect(fetchAll).toHaveBeenCalled());
    await view.user.keyboard("{Escape}");
    expect(view.props.onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
  });

  it("the backdrop does not close the dialog during fetch after adding", async () => {
    let resolve!: () => void;
    vi.mocked(fetchAll).mockReturnValue(new Promise<void>((r) => (resolve = r)));
    const view = await renderList();
    await fillAdd(view, "up", "/srv/up.git");
    await view.user.click(addButton());
    await waitFor(() => expect(fetchAll).toHaveBeenCalled());
    await view.user.click(
      screen.getByRole("dialog", { name: "Remotes" }).parentElement as HTMLElement,
    );
    expect(view.props.onClose).not.toHaveBeenCalled();
    await act(async () => resolve());
  });

  it("Remove is disabled while another network action of the repo runs", async () => {
    let resolve!: () => void;
    vi.mocked(fetchAll).mockReturnValue(new Promise<void>((r) => (resolve = r)));
    const { user } = renderWithProviders(
      <>
        <Other />
        <RemotesDialog repoId={1} target={{ mode: "list" }} onClose={vi.fn()} />
      </>,
    );
    await screen.findByRole("list", { name: "Remotes" });
    await user.click(screen.getByRole("button", { name: "Other fetch" }));
    await waitFor(() => expect(button("Remove origin")).toBeDisabled());
    expect(button("Edit origin")).toBeEnabled();
    await act(async () => resolve());
  });
});

// Contract (architect R9): an edit target waits for the list, then opens the prefilled form or resolves to the list once.
describe("RemotesDialog edit target loading", () => {
  it("keeps role dialog with its name and aria-modal while Loading remotes… shows", () => {
    vi.mocked(listRemotes).mockReturnValue(new Promise<RemoteInfo[]>(() => undefined));
    renderDialog();
    expect(screen.getByRole("status")).toHaveTextContent("Loading remotes…");
    expect(screen.getByRole("dialog", { name: "Remotes" })).toHaveAttribute("aria-modal", "true");
  });

  it("shows Loading remotes… until the list arrives, then the prefilled form", async () => {
    let resolve!: (r: RemoteInfo[]) => void;
    vi.mocked(listRemotes).mockReturnValue(new Promise<RemoteInfo[]>((r) => (resolve = r)));
    renderDialog({ target: { mode: "edit", name: "origin" } });
    expect(await screen.findByRole("status")).toHaveTextContent("Loading remotes…");
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByRole("list", { name: "Remotes" })).toBeNull();
    await act(async () => resolve([remoteInfo("origin", { fetchUrl: "/srv/origin.git" })]));
    await waitFor(() => expect(nameField()).toHaveValue("origin"));
    expect(urlField()).toHaveValue("/srv/origin.git");
    expect(screen.queryByText("Loading remotes…")).toBeNull();
  });

  it("a missing remote switches to the list once and a later refetch does not pop the form open", async () => {
    const view = renderDialog({ target: { mode: "edit", name: "ghost" } });
    await screen.findByRole("list", { name: "Remotes" });
    remotes = [...remotes, remoteInfo("ghost")];
    await act(() => view.queryClient.invalidateQueries());
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "Remotes" })).toHaveTextContent("ghost"),
    );
    expect(screen.queryByLabelText("Name")).toBeNull();
  });
});

// Contract (coverage): a click on the backdrop itself closes an idle dialog, but not while a
// nested confirm is open.
describe("RemotesDialog backdrop", () => {
  const backdrop = () =>
    screen.getByRole("dialog", { name: "Remotes" }).parentElement as HTMLElement;

  it("closes an idle dialog when the backdrop is clicked", async () => {
    const view = await renderList();
    await view.user.click(backdrop());
    expect(view.props.onClose).toHaveBeenCalledOnce();
  });

  it("does not close while the remove confirm is open", async () => {
    const view = await renderList();
    await view.user.click(button("Remove origin"));
    await screen.findByRole("dialog", { name: "Remove remote origin?" });
    await view.user.click(backdrop());
    expect(view.props.onClose).not.toHaveBeenCalled();
  });
});

// Contract (developer-flagged gap): when listRemotes fails the dialog shows the panel RepoError
// with Retry instead of sitting on "Loading remotes…"; Close and Escape still work.
describe("RemotesDialog list load error", () => {
  const loadError: AppError = { kind: "io", message: "list exploded" };

  it("shows the load error as a panel RepoError instead of Loading remotes…", async () => {
    vi.mocked(listRemotes).mockRejectedValue(loadError);
    renderDialog();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("list exploded");
    expect(alert).toHaveAttribute("data-variant", "panel");
    expect(screen.queryByText("Loading remotes…")).toBeNull();
    expect(screen.queryByRole("list", { name: "Remotes" })).toBeNull();
  });

  it("shows the load error when the dialog opened for an edit target", async () => {
    vi.mocked(listRemotes).mockRejectedValue(loadError);
    renderDialog({ target: { mode: "edit", name: "origin" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("list exploded");
    expect(screen.queryByText("Loading remotes…")).toBeNull();
  });

  it("Retry refetches the remotes and shows the list when it succeeds", async () => {
    vi.mocked(listRemotes).mockRejectedValueOnce(loadError);
    const { user } = renderDialog();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Remotes" })).toHaveTextContent("origin");
    expect(listRemotes).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Close calls onClose while the load error shows", async () => {
    vi.mocked(listRemotes).mockRejectedValue(loadError);
    const view = renderDialog();
    await screen.findByRole("alert");
    await view.user.click(button("Close"));
    expect(view.props.onClose).toHaveBeenCalledOnce();
  });

  it("Escape closes the dialog while the load error shows", async () => {
    vi.mocked(listRemotes).mockRejectedValue(loadError);
    const view = renderDialog();
    await screen.findByRole("alert");
    await view.user.keyboard("{Escape}");
    expect(view.props.onClose).toHaveBeenCalledOnce();
  });
});
