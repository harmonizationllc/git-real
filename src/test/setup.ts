import "@testing-library/jest-dom/vitest";

// happy-dom answers getModifierState("AltGraph") with altKey, so every Alt chord a test dispatches
// would read as AltGr. Browsers report AltGraph on its own; tests that need AltGr stub the method.
const getModifierState = KeyboardEvent.prototype.getModifierState;
KeyboardEvent.prototype.getModifierState = function (key: string): boolean {
  return key !== "AltGraph" && getModifierState.call(this, key);
};
