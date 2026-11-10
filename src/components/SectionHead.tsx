import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The element a section's header band renders into. `undefined` (no provider): the header renders
 * in place. `null`: the column's slot has not mounted yet, so the header renders nothing.
 */
export const SectionHeadSlot = createContext<HTMLElement | null | undefined>(undefined);

/** Renders its children into the column's fixed header slot, or in place outside a column. */
export function SectionHead({ children }: { children: ReactNode }): ReactNode {
  const slot = useContext(SectionHeadSlot);
  if (slot === undefined) return children;
  if (slot === null) return null;
  return createPortal(children, slot);
}
