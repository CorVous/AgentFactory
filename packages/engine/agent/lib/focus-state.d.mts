/**
 * focus-state.d.mts — TypeScript declarations for focus-state.mjs
 */

import { EventEmitter } from "node:events";

export interface FocusChangedEvent {
  focused: boolean;
}

export interface FocusStateOptions {
  initialFocused?: boolean;
}

/**
 * FocusState — single-peer focus tracking.
 * Emits "focus-changed" ({ focused: boolean }) when focus state changes.
 */
export class FocusState extends EventEmitter {
  constructor(opts?: FocusStateOptions);

  /** Returns whether this peer is currently focused. */
  isFocused(): boolean;

  /**
   * Update focus state based on a signal from the launcher.
   * Emits "focus-changed" only when the state actually changes.
   */
  update(focused: boolean): void;

  on(event: "focus-changed", listener: (e: FocusChangedEvent) => void): this;
  on(event: string, listener: (...args: unknown[]) => void): this;

  emit(event: "focus-changed", arg: FocusChangedEvent): boolean;
  emit(event: string, ...args: unknown[]): boolean;
}

/**
 * Factory function — creates a new FocusState instance.
 */
export function createFocusState(opts?: FocusStateOptions): FocusState;
