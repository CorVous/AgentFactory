/**
 * focus-state.test.ts — hermetic unit tests for in-peer FocusState.
 *
 * Contract: no I/O, no network, no env from models.env.
 */

import { describe, it, expect, vi } from "vitest";
import { createFocusState, FocusState } from "./focus-state.mjs";

describe("FocusState — initial state", () => {
  it("isFocused() starts as false by default", () => {
    const fs = createFocusState();
    expect(fs.isFocused()).toBe(false);
  });

  it("accepts initialFocused: true", () => {
    const fs = createFocusState({ initialFocused: true });
    expect(fs.isFocused()).toBe(true);
  });
});

describe("FocusState — update()", () => {
  it("update(true) sets isFocused() to true", () => {
    const fs = createFocusState();
    fs.update(true);
    expect(fs.isFocused()).toBe(true);
  });

  it("update(false) sets isFocused() to false", () => {
    const fs = createFocusState({ initialFocused: true });
    fs.update(false);
    expect(fs.isFocused()).toBe(false);
  });

  it("update with same value is no-op (no event emitted)", () => {
    const fs = createFocusState();
    const listener = vi.fn();
    fs.on("focus-changed", listener);

    fs.update(false); // already false
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("FocusState — focus-changed event", () => {
  it("emits focus-changed with { focused: true } when gaining focus", () => {
    const fs = createFocusState();
    const events: Array<{ focused: boolean }> = [];
    fs.on("focus-changed", (e) => events.push(e));

    fs.update(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ focused: true });
  });

  it("emits focus-changed with { focused: false } when losing focus", () => {
    const fs = createFocusState({ initialFocused: true });
    const events: Array<{ focused: boolean }> = [];
    fs.on("focus-changed", (e) => events.push(e));

    fs.update(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ focused: false });
  });

  it("does NOT emit focus-changed when state is unchanged", () => {
    const fs = createFocusState({ initialFocused: true });
    const listener = vi.fn();
    fs.on("focus-changed", listener);

    fs.update(true); // same
    expect(listener).not.toHaveBeenCalled();
  });

  it("isFocused() returns current value synchronously after update()", () => {
    const fs = createFocusState();
    fs.update(true);
    // getter must be synchronous — no async/await needed
    expect(fs.isFocused()).toBe(true);
    fs.update(false);
    expect(fs.isFocused()).toBe(false);
  });

  it("can toggle focus multiple times", () => {
    const fs = createFocusState();
    const events: Array<{ focused: boolean }> = [];
    fs.on("focus-changed", (e) => events.push(e));

    fs.update(true);
    fs.update(false);
    fs.update(true);

    expect(events).toHaveLength(3);
    expect(events.map((e) => e.focused)).toEqual([true, false, true]);
  });
});
