import { render, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRestoreFocus } from "./useRestoreFocus";

function Probe({ fallback }: { fallback?: RefObject<HTMLElement | null> }) {
  useRestoreFocus(fallback);
  return <button type="button" data-testid="inside" />;
}

// Real dialogs hold focus inside themselves when they close, so tests focus the probe before unmount.
const inside = () => screen.getByTestId("inside");

const created: HTMLElement[] = [];

function make<K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (tag === "div") el.tabIndex = -1;
  document.body.appendChild(el);
  created.push(el);
  return el;
}

afterEach(() => {
  for (const el of created.splice(0)) el.remove();
});

// Contract: on unmount, focus returns to the opener if it can take it, else to the fallback.
describe("useRestoreFocus", () => {
  it("returns focus to the element that had it at mount", () => {
    const opener = make("button");
    opener.focus();
    const view = render(<Probe />);
    inside().focus();
    view.unmount();
    expect(opener).toHaveFocus();
  });

  it("prefers the opener over the fallback when the opener can take focus", () => {
    const opener = make("button");
    const fallback = make("div");
    opener.focus();
    const view = render(<Probe fallback={{ current: fallback }} />);
    view.unmount();
    expect(opener).toHaveFocus();
  });

  it("focuses the fallback when the body had focus at mount", () => {
    const fallback = make("div");
    (document.activeElement as HTMLElement).blur();
    const view = render(<Probe fallback={{ current: fallback }} />);
    inside().focus();
    view.unmount();
    expect(fallback).toHaveFocus();
  });

  it("focuses the fallback when the opener is disabled at unmount", () => {
    const opener = make("button");
    const fallback = make("div");
    opener.focus();
    const view = render(<Probe fallback={{ current: fallback }} />);
    opener.disabled = true;
    inside().focus();
    const spy = vi.spyOn(opener, "focus");
    view.unmount();
    expect(fallback).toHaveFocus();
    expect(spy).not.toHaveBeenCalled();
  });

  it("focuses the fallback when the opener was removed", () => {
    const opener = make("button");
    const fallback = make("div");
    opener.focus();
    const view = render(<Probe fallback={{ current: fallback }} />);
    opener.remove();
    inside().focus();
    view.unmount();
    expect(fallback).toHaveFocus();
  });

  it("focuses the fallback's element at unmount, not the one at mount", () => {
    const a = make("div");
    const b = make("div");
    const ref: { current: HTMLElement | null } = { current: a };
    (document.activeElement as HTMLElement).blur();
    const view = render(<Probe fallback={ref} />);
    ref.current = b;
    inside().focus();
    view.unmount();
    expect(b).toHaveFocus();
  });

  it("leaves focus alone when the opener cannot take it and there is no fallback", () => {
    const x = make("button");
    (document.activeElement as HTMLElement).blur();
    const view = render(<Probe />);
    x.focus();
    view.unmount();
    expect(x).toHaveFocus();
  });

  it("does not throw when the fallback ref is empty", () => {
    (document.activeElement as HTMLElement).blur();
    const view = render(<Probe fallback={{ current: null }} />);
    expect(() => view.unmount()).not.toThrow();
  });
});
