import type React from "react";
import { Toasts, useToasts } from "git-real";

const seeded = new Set<string>();

/**
 * The toast root is position: fixed (bottom-right of the window). A transformed ancestor becomes
 * its containing block, so this frame pins the stack inside the card instead of the page.
 */
const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ position: "relative", width: 440, height: 170, transform: "translateZ(0)" }}>
    {children}
  </div>
);
/** Pushes once per cell, synchronously, so the first render already holds the toasts. */
function seed(key: string, fn: () => void) {
  if (seeded.has(key)) return;
  seeded.add(key);
  useToasts.setState({ toasts: [] });
  fn();
}

export const Info = () => {
  seed("info", () => {
    useToasts.getState().show("Fetched origin: 3 new commits on main.");
  });
  return (
    <Frame>
      <Toasts />
    </Frame>
  );
};

export const Success = () => {
  seed("success", () => {
    useToasts.getState().notify({ text: "Pushed feature/tokens to origin.", variant: "success" });
  });
  return (
    <Frame>
      <Toasts />
    </Frame>
  );
};

/** Errors are sticky and may carry an action. */
export const Error = () => {
  seed("error", () => {
    useToasts.getState().notify({
      text: "Push rejected: origin/main has commits you do not have.",
      variant: "error",
      action: { label: "Fetch", run: () => {} },
    });
  });
  return (
    <Frame>
      <Toasts />
    </Frame>
  );
};

export const Stack = () => {
  seed("stack", () => {
    const t = useToasts.getState();
    t.show("Checked out release/0.4.");
    t.notify({ text: "Stashed 2 files as WIP on release/0.4.", variant: "success" });
    t.notify({ text: "Could not delete branch: it is not fully merged.", variant: "error" });
  });
  return (
    <Frame>
      <Toasts />
    </Frame>
  );
};
