import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderHookWithProviders } from "../test/renderWithProviders";
import { useNativeContextMenuGuard } from "./useNativeContextMenuGuard";

const mounted: HTMLElement[] = [];
afterEach(() => {
  mounted.splice(0).forEach((el) => el.remove());
});

/** Appends `html` to the body and returns the element marked `data-t`. */
function add(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  mounted.push(host);
  return host.querySelector<HTMLElement>("[data-t]")!;
}

/** True when the right-click was default-prevented, i.e. the native menu is suppressed. */
const prevented = (el: Element) => !fireEvent.contextMenu(el);

// Contract (GR-53): the native menu never opens, except inside a text-editing element.
describe("useNativeContextMenuGuard", () => {
  it("prevents the native menu on a plain element", () => {
    renderHookWithProviders(() => useNativeContextMenuGuard());
    expect(prevented(add("<div data-t></div>"))).toBe(true);
  });

  it.each([
    ["an input", "<input data-t />"],
    ["a textarea", "<textarea data-t></textarea>"],
    ["a contenteditable", '<div contenteditable="true"><div data-t></div></div>'],
    ["an empty contenteditable", '<div contenteditable=""><div data-t></div></div>'],
    [
      "a plaintext-only contenteditable",
      '<div contenteditable="plaintext-only"><i data-t></i></div>',
    ],
  ])("leaves the native menu on %s", (_name, html) => {
    renderHookWithProviders(() => useNativeContextMenuGuard());
    expect(prevented(add(html))).toBe(false);
  });

  it('prevents the native menu inside contenteditable="false"', () => {
    renderHookWithProviders(() => useNativeContextMenuGuard());
    expect(prevented(add('<div contenteditable="false"><div data-t></div></div>'))).toBe(true);
  });

  it("stops preventing after unmount", () => {
    const view = renderHookWithProviders(() => useNativeContextMenuGuard());
    view.unmount();
    expect(prevented(add("<div data-t></div>"))).toBe(false);
  });
});
