import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import styles from "./ContextMenu.module.css";
import { useRestoreFocus } from "./useRestoreFocus";

export interface MenuItem {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  /** Tooltip explaining what the item does. */
  title?: string;
  onSelect(): void;
}

export interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
  /** Takes focus on close when the opener is gone, disabled or never had focus. */
  fallbackFocus?: RefObject<HTMLElement | null>;
}

export function ContextMenu({ open, x, y, items, onClose, fallbackFocus }: ContextMenuProps) {
  return open ? (
    <ContextMenuBody x={x} y={y} items={items} onClose={onClose} fallbackFocus={fallbackFocus} />
  ) : null;
}

function ContextMenuBody({ x, y, items, onClose, fallbackFocus }: Omit<ContextMenuProps, "open">) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  const enabledItems = (): HTMLButtonElement[] =>
    Array.from(
      (menuRef.current as HTMLDivElement).querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    );

  useRestoreFocus(fallbackFocus);
  // Focus the first enabled item, or the menu itself. Both are layout effects, so the restore runs
  // before a dialog's focus-on-open when one replaces the menu.
  useLayoutEffect(() => {
    (enabledItems()[0] ?? (menuRef.current as HTMLDivElement)).focus();
  }, []);

  // Keep the menu inside the viewport once its size is known.
  useLayoutEffect(() => {
    const rect = (menuRef.current as HTMLDivElement).getBoundingClientRect();
    setPosition({
      left: Math.max(0, Math.min(x, window.innerWidth - rect.width)),
      top: Math.max(0, Math.min(y, window.innerHeight - rect.height)),
    });
  }, [x, y]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (!(menuRef.current as HTMLDivElement).contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent) => {
    const enabled = enabledItems();
    const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
    const count = enabled.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        enabled[(current + 1) % count]?.focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        enabled[(current <= 0 ? count : current) - 1]?.focus();
        break;
      case "Home":
        e.preventDefault();
        enabled[0]?.focus();
        break;
      case "End":
        e.preventDefault();
        enabled[count - 1]?.focus();
        break;
      case "Escape":
      case "Tab":
        onClose();
        break;
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      className={styles.menu}
      style={{ position: "fixed", left: position.left, top: position.top }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className={styles.item}
          disabled={item.disabled}
          title={item.title}
          data-danger={item.danger ? "true" : undefined}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
