import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MessageEditor } from "./MessageEditor";

function setup(over: Partial<React.ComponentProps<typeof MessageEditor>> = {}) {
  const props = {
    subject: "",
    body: "",
    disabled: false,
    onSubjectChange: vi.fn(),
    onBodyChange: vi.fn(),
    onSubmit: vi.fn(),
    ...over,
  };
  render(<MessageEditor {...props} />);
  return { ...props, user: userEvent.setup() };
}

describe("MessageEditor", () => {
  it("renders labelled subject and body with placeholders", () => {
    setup();
    expect(screen.getByLabelText("Subject")).toHaveAttribute("placeholder", "Summary of changes");
    expect(screen.getByLabelText("Body")).toHaveAttribute(
      "placeholder",
      "Optional longer description",
    );
  });

  it("forwards typing to the change handlers", async () => {
    const { user, onSubjectChange, onBodyChange } = setup();
    await user.type(screen.getByLabelText("Subject"), "a");
    await user.type(screen.getByLabelText("Body"), "b");
    expect(onSubjectChange).toHaveBeenCalledWith("a");
    expect(onBodyChange).toHaveBeenCalledWith("b");
  });

  it("shows the counter and no hint at the limit", () => {
    setup({ subject: "x".repeat(72) });
    expect(screen.getByText("72/72")).toBeInTheDocument();
    expect(screen.queryByText("Keep the subject at 72 characters or fewer")).toBeNull();
  });

  it("shows the hint past the limit and links it to the input", () => {
    setup({ subject: "x".repeat(73) });
    const hint = screen.getByText("Keep the subject at 72 characters or fewer");
    expect(screen.getByText("73/72")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toHaveAttribute("aria-describedby", hint.id);
  });

  it("Enter in the subject moves focus to the body without submitting", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByLabelText("Subject"));
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Body")).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter submits from either field", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByLabelText("Subject"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    await user.click(screen.getByLabelText("Body"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("Meta+Enter also submits", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByLabelText("Body"));
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("disables both fields when disabled", () => {
    setup({ disabled: true });
    expect(screen.getByLabelText("Subject")).toBeDisabled();
    expect(screen.getByLabelText("Body")).toBeDisabled();
  });
});

describe("MessageEditor limit boundary and key modifiers", () => {
  it("styles the counter as over the limit at 73 but not at 72", () => {
    const { unmount } = render(
      <MessageEditor
        subject={"x".repeat(72)}
        body=""
        disabled={false}
        onSubjectChange={vi.fn()}
        onBodyChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByText("72/72").className).not.toMatch(/counterOver/);
    expect(screen.getByLabelText("Subject")).not.toHaveAttribute("aria-describedby");
    unmount();
    setup({ subject: "x".repeat(73) });
    expect(screen.getByText("73/72").className).toMatch(/counterOver/);
  });

  it("Shift+Enter in the subject moves focus to the body and does not submit", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByLabelText("Subject"));
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    expect(screen.getByLabelText("Body")).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("plain Enter in the body does not submit", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByLabelText("Body"));
    await user.keyboard("{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter during IME composition neither moves focus nor submits", async () => {
    const { user, onSubmit } = setup();
    const subject = screen.getByLabelText("Subject");
    await user.click(subject);
    const notPrevented = fireEvent.keyDown(subject, { key: "Enter", isComposing: true });
    expect(subject).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });

  it("Ctrl+Enter during IME composition does not submit", async () => {
    const { user, onSubmit } = setup();
    const subject = screen.getByLabelText("Subject");
    await user.click(subject);
    fireEvent.keyDown(subject, { key: "Enter", ctrlKey: true, isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter with keyCode 229 (WebKit post-composition) neither moves focus nor submits", async () => {
    const { user, onSubmit } = setup();
    const subject = screen.getByLabelText("Subject");
    await user.click(subject);
    const notPrevented = fireEvent.keyDown(subject, { key: "Enter", keyCode: 229 });
    expect(subject).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(notPrevented).toBe(true);
  });
});

// Contract (spec 5.4): the subject input has a fixed id so the banner can focus it.
describe("MessageEditor subject id", () => {
  it("gives the subject input the id commit-subject", () => {
    setup();
    expect(screen.getByLabelText("Subject")).toHaveAttribute("id", "commit-subject");
  });

  it("associates the Subject label with the fixed id", () => {
    setup();
    expect(screen.getByText("Subject")).toHaveAttribute("for", "commit-subject");
  });

  it("keeps the subject input labelled Subject", () => {
    setup();
    expect(screen.getByRole("textbox", { name: "Subject" })).toBeInTheDocument();
  });

  it("does not give the body input the subject id", () => {
    setup();
    expect(screen.getByLabelText("Body")).not.toHaveAttribute("id", "commit-subject");
  });
});

// Contract (GR-13b): onLinkIssue adds a Link issue button and Ctrl/Cmd+Shift+I. It hands the parent
// an inserter bound to the field that triggered it and to that field's caret at that moment.
describe("MessageEditor issue link", () => {
  type Inserter = (text: string) => void;
  type Props = React.ComponentProps<typeof MessageEditor>;
  const CHORD = { key: "I", ctrlKey: true, shiftKey: true };
  const subject = () => screen.getByLabelText("Subject") as HTMLInputElement;
  const body = () => screen.getByLabelText("Body") as HTMLTextAreaElement;
  const linkButton = () => screen.getByRole("button", { name: "Link issue" });

  /** A field focused with its caret (or selection) at start..end. */
  const caretIn = (el: HTMLInputElement | HTMLTextAreaElement, start: number, end = start) => {
    el.focus();
    el.setSelectionRange(start, end);
  };

  /** Fixed values: the callbacks are spies and nothing is re-rendered unless the test does so. */
  function setupLink(over: Partial<Props> = {}) {
    const onLinkIssue = vi.fn<(insert: Inserter) => void>();
    const props: Props = {
      subject: "Fix login",
      body: "Details",
      disabled: false,
      onSubjectChange: vi.fn(),
      onBodyChange: vi.fn(),
      onSubmit: vi.fn(),
      onLinkIssue,
      ...over,
    };
    const view = render(<MessageEditor {...props} />);
    const insert = (text: string) => {
      const fn = onLinkIssue.mock.lastCall?.[0] as Inserter;
      act(() => fn(text));
    };
    return {
      ...props,
      onLinkIssue,
      insert,
      rerender: (next: Partial<Props>) => view.rerender(<MessageEditor {...props} {...next} />),
    };
  }

  /** The real thing: a parent that keeps the values, so the caret restore can be observed. */
  function Harness({ initial }: { initial: { subject: string; body: string } }) {
    const [subject, setSubject] = useState(initial.subject);
    const [body, setBody] = useState(initial.body);
    return (
      <MessageEditor
        subject={subject}
        body={body}
        disabled={false}
        onSubjectChange={setSubject}
        onBodyChange={setBody}
        onSubmit={vi.fn()}
        onLinkIssue={(insert) => {
          harnessInsert = insert;
        }}
      />
    );
  }
  let harnessInsert: Inserter = () => undefined;

  describe("without onLinkIssue", () => {
    it("should show no Link issue button", () => {
      setup();
      expect(screen.queryByRole("button", { name: "Link issue" })).toBeNull();
    });

    it("should leave Ctrl+Shift+I alone", () => {
      setup();
      expect(fireEvent.keyDown(subject(), CHORD)).toBe(true);
    });
  });

  describe("the button", () => {
    it("should be named Link issue and show a #", () => {
      setupLink();
      expect(linkButton()).toHaveTextContent("#");
    });

    it("should call onLinkIssue once with an inserter when clicked", () => {
      const { onLinkIssue } = setupLink();
      fireEvent.click(linkButton());
      expect(onLinkIssue).toHaveBeenCalledOnce();
      expect(onLinkIssue).toHaveBeenCalledWith(expect.any(Function));
    });

    it("should be disabled while the editor is disabled", () => {
      setupLink({ disabled: true });
      expect(linkButton()).toBeDisabled();
    });

    it("should sit in the body label row, before the body field", () => {
      setupLink();
      expect(
        screen.getByText("Body").compareDocumentPosition(linkButton()) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        linkButton().compareDocumentPosition(body()) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("should write into the body by default, at the end of an untouched body", () => {
      const { insert, onBodyChange, onSubjectChange } = setupLink({ body: "Fixes" });
      fireEvent.click(linkButton());
      insert("#12");
      expect(onBodyChange).toHaveBeenCalledExactlyOnceWith("Fixes #12");
      expect(onSubjectChange).not.toHaveBeenCalled();
    });

    it("should write into the subject when the subject was the last field focused", () => {
      const { insert, onSubjectChange, onBodyChange } = setupLink();
      caretIn(subject(), 9);
      fireEvent.click(linkButton());
      insert("#12");
      expect(onSubjectChange).toHaveBeenCalledExactlyOnceWith("Fix login #12");
      expect(onBodyChange).not.toHaveBeenCalled();
    });

    it("should write into the body when the body was focused after the subject", () => {
      const { insert, onBodyChange } = setupLink({ body: "Details" });
      caretIn(subject(), 0);
      caretIn(body(), 7);
      fireEvent.click(linkButton());
      insert("#12");
      expect(onBodyChange).toHaveBeenCalledExactlyOnceWith("Details #12");
    });
  });

  describe("the shortcut", () => {
    it("should call onLinkIssue on Ctrl+Shift+I in the subject", () => {
      const { onLinkIssue } = setupLink();
      fireEvent.keyDown(subject(), CHORD);
      expect(onLinkIssue).toHaveBeenCalledOnce();
    });

    it("should call onLinkIssue on Ctrl+Shift+I in the body", () => {
      const { onLinkIssue } = setupLink();
      fireEvent.keyDown(body(), CHORD);
      expect(onLinkIssue).toHaveBeenCalledOnce();
    });

    it("should work with Meta instead of Ctrl", () => {
      const { onLinkIssue } = setupLink();
      fireEvent.keyDown(subject(), { key: "I", metaKey: true, shiftKey: true });
      expect(onLinkIssue).toHaveBeenCalledOnce();
    });

    it("should accept a lower-case i, as Caps Lock can flip the case", () => {
      const { onLinkIssue } = setupLink();
      fireEvent.keyDown(subject(), { key: "i", ctrlKey: true, shiftKey: true });
      expect(onLinkIssue).toHaveBeenCalledOnce();
    });

    it("should preventDefault the chord so it never reaches the window handler or the webview", () => {
      setupLink();
      expect(fireEvent.keyDown(subject(), CHORD)).toBe(false);
    });

    it("should preventDefault the chord in the body too", () => {
      setupLink();
      expect(fireEvent.keyDown(body(), CHORD)).toBe(false);
    });

    it("should do nothing on Ctrl+I without Shift", () => {
      const { onLinkIssue } = setupLink();
      expect(fireEvent.keyDown(subject(), { key: "i", ctrlKey: true })).toBe(true);
      expect(onLinkIssue).not.toHaveBeenCalled();
    });

    it("should do nothing on Shift+I without Ctrl or Meta", () => {
      const { onLinkIssue } = setupLink();
      fireEvent.keyDown(subject(), { key: "I", shiftKey: true });
      expect(onLinkIssue).not.toHaveBeenCalled();
    });

    it("should do nothing on Ctrl+Shift+J", () => {
      const { onLinkIssue } = setupLink();
      expect(fireEvent.keyDown(subject(), { key: "J", ctrlKey: true, shiftKey: true })).toBe(true);
      expect(onLinkIssue).not.toHaveBeenCalled();
    });

    it("should do nothing while the editor is disabled", () => {
      const { onLinkIssue } = setupLink({ disabled: true });
      expect(fireEvent.keyDown(subject(), CHORD)).toBe(true);
      expect(onLinkIssue).not.toHaveBeenCalled();
    });

    it("should do nothing during IME composition", () => {
      const { onLinkIssue } = setupLink();
      expect(fireEvent.keyDown(subject(), { ...CHORD, isComposing: true })).toBe(true);
      expect(onLinkIssue).not.toHaveBeenCalled();
    });

    it("should bind the inserter to the field that got the chord, not the last focused one", () => {
      const { insert, onBodyChange, onSubjectChange } = setupLink({ body: "Details" });
      caretIn(subject(), 3);
      fireEvent.keyDown(body(), CHORD);
      insert("#12");
      expect(onBodyChange).toHaveBeenCalledExactlyOnceWith("Details #12");
      expect(onSubjectChange).not.toHaveBeenCalled();
    });

    it("should leave Ctrl+Enter submitting", () => {
      const { onSubmit } = setupLink();
      fireEvent.keyDown(subject(), { key: "Enter", ctrlKey: true });
      expect(onSubmit).toHaveBeenCalledOnce();
    });
  });

  describe("the inserter", () => {
    it("should write into the subject at its caret after Ctrl+Shift+I in the subject", () => {
      const { insert, onSubjectChange } = setupLink();
      caretIn(subject(), 3);
      fireEvent.keyDown(subject(), CHORD);
      insert("#12");
      expect(onSubjectChange).toHaveBeenCalledExactlyOnceWith("Fix #12 login");
    });

    it("should write into the body at its caret after Ctrl+Shift+I in the body", () => {
      const { insert, onBodyChange } = setupLink({ body: "Fixlogin" });
      caretIn(body(), 3);
      fireEvent.keyDown(body(), CHORD);
      insert("#12");
      expect(onBodyChange).toHaveBeenCalledExactlyOnceWith("Fix #12 login");
    });

    it("should replace a selected word", () => {
      const { insert, onSubjectChange } = setupLink();
      caretIn(subject(), 4, 9);
      fireEvent.keyDown(subject(), CHORD);
      insert("#12");
      expect(onSubjectChange).toHaveBeenCalledExactlyOnceWith("Fix #12");
    });

    it("should append at the end of an untouched field", () => {
      const { insert, onSubjectChange } = setupLink();
      fireEvent.keyDown(subject(), CHORD);
      insert("#12");
      expect(onSubjectChange).toHaveBeenCalledExactlyOnceWith("Fix login #12");
    });

    it("should use the caret from when it was opened, not from when it is called", () => {
      const { insert, onSubjectChange } = setupLink();
      caretIn(subject(), 3);
      fireEvent.keyDown(subject(), CHORD);
      subject().setSelectionRange(0, 0);
      insert("#12");
      expect(onSubjectChange).toHaveBeenCalledExactlyOnceWith("Fix #12 login");
    });

    it("should splice into the current value, not the value at open time", () => {
      const { insert, onSubjectChange, rerender } = setupLink();
      caretIn(subject(), 3);
      fireEvent.keyDown(subject(), CHORD);
      rerender({ subject: "Fix login!" });
      insert("#12");
      expect(onSubjectChange).toHaveBeenCalledExactlyOnceWith("Fix #12 login!");
    });

    it("should clamp the caret to a value that became shorter", () => {
      const { insert, onSubjectChange, rerender } = setupLink();
      caretIn(subject(), 9);
      fireEvent.keyDown(subject(), CHORD);
      rerender({ subject: "Fix" });
      insert("#12");
      expect(onSubjectChange).toHaveBeenCalledExactlyOnceWith("Fix #12");
    });

    it("should leave the other field alone", () => {
      const { insert, onBodyChange } = setupLink();
      fireEvent.keyDown(subject(), CHORD);
      insert("#12");
      expect(onBodyChange).not.toHaveBeenCalled();
    });
  });

  describe("after inserting", () => {
    it("should focus the subject with the caret right after the inserted text", () => {
      render(<Harness initial={{ subject: "Fix login", body: "" }} />);
      caretIn(subject(), 3);
      fireEvent.keyDown(subject(), CHORD);
      body().focus();
      act(() => harnessInsert("#12"));
      expect(subject()).toHaveValue("Fix #12 login");
      expect(subject()).toHaveFocus();
      expect(subject().selectionStart).toBe(7);
      expect(subject().selectionEnd).toBe(7);
    });

    it("should focus the body with the caret right after the inserted text", () => {
      render(<Harness initial={{ subject: "", body: "Fixlogin" }} />);
      caretIn(body(), 3);
      fireEvent.click(linkButton());
      subject().focus();
      act(() => harnessInsert("#12"));
      expect(body()).toHaveValue("Fix #12 login");
      expect(body()).toHaveFocus();
      expect(body().selectionStart).toBe(8);
      expect(body().selectionEnd).toBe(8);
    });

    it("should put the caret at the end after appending", () => {
      render(<Harness initial={{ subject: "Fix login", body: "" }} />);
      fireEvent.keyDown(subject(), CHORD);
      act(() => harnessInsert("#12"));
      expect(subject().selectionStart).toBe("Fix login #12".length);
    });

    it("should restore the caret only once, leaving later typing alone", () => {
      render(<Harness initial={{ subject: "Fix login", body: "" }} />);
      caretIn(subject(), 3);
      fireEvent.keyDown(subject(), CHORD);
      act(() => harnessInsert("#12"));
      fireEvent.change(subject(), { target: { value: "Fix #12 login!", selectionStart: 14 } });
      expect(subject().selectionStart).toBe(14);
    });
  });
});
