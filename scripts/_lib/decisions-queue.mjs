/**
 * decisions-queue.mjs — pure data structure for the launcher decisions queue.
 *
 * Manages a queue of pinned decisions that survive focus changes (sticky lifecycle).
 * Non-pinned items can be auto-dismissed by the caller on focus change; pinned items
 * are NOT auto-dismissed — they stay in the queue until explicitly resolved.
 *
 * The queue itself does NOT subscribe to focus events; that is the caller's
 * responsibility (decoupled from focus-controller).
 *
 * Each queued item carries:
 *   - msg_id: unique identifier (mirrors the bus envelope msg_id)
 *   - peer: the peer name that originated the decision
 *   - kind: "approval-request" | "submission" (or any envelope kind)
 *   - summary: short human-readable description
 *   - ts: timestamp (epoch ms) when the item was enqueued
 *   - pinned: boolean — sticky lifecycle when true
 */

import { randomUUID } from "node:crypto";

/**
 * @typedef {{
 *   msg_id: string;
 *   peer: string;
 *   kind: string;
 *   summary: string;
 *   ts: number;
 *   pinned: boolean;
 * }} DecisionItem
 */

/**
 * Create a new decisions queue.
 *
 * @returns {{
 *   enqueue(item: Omit<DecisionItem, 'ts' | 'pinned'>): DecisionItem;
 *   dismiss(msg_id: string): boolean;
 *   pin(msg_id: string): boolean;
 *   unpin(msg_id: string): boolean;
 *   list(): DecisionItem[];
 *   count(): number;
 * }}
 */
export function createDecisionsQueue() {
  /** @type {Map<string, DecisionItem>} */
  const items = new Map();

  /**
   * Enqueue a new (non-pinned) decision item.
   * If an item with the same msg_id already exists, it is replaced.
   *
   * @param {{ msg_id: string; peer: string; kind: string; summary: string }} item
   * @returns {DecisionItem}
   */
  function enqueue(item) {
    const full = {
      msg_id: item.msg_id,
      peer: item.peer,
      kind: item.kind,
      summary: item.summary,
      ts: Date.now(),
      pinned: false,
    };
    items.set(full.msg_id, full);
    return full;
  }

  /**
   * Remove an item from the queue by msg_id.
   * Returns true if the item was present and removed, false otherwise.
   *
   * @param {string} msg_id
   * @returns {boolean}
   */
  function dismiss(msg_id) {
    return items.delete(msg_id);
  }

  /**
   * Promote an item to pinned (sticky) lifecycle.
   * Pinned items survive focus-controller events — only explicit dismiss() removes them.
   * Returns true if the item was found and pinned, false if not found.
   *
   * @param {string} msg_id
   * @returns {boolean}
   */
  function pin(msg_id) {
    const item = items.get(msg_id);
    if (!item) return false;
    items.set(msg_id, { ...item, pinned: true });
    return true;
  }

  /**
   * Demote an item from pinned lifecycle back to non-pinned.
   * Returns true if the item was found and unpinned, false if not found.
   *
   * @param {string} msg_id
   * @returns {boolean}
   */
  function unpin(msg_id) {
    const item = items.get(msg_id);
    if (!item) return false;
    items.set(msg_id, { ...item, pinned: false });
    return true;
  }

  /**
   * Return all queued items in insertion order.
   *
   * @returns {DecisionItem[]}
   */
  function list() {
    return [...items.values()];
  }

  /**
   * Return the total number of queued items (pinned + non-pinned).
   *
   * @returns {number}
   */
  function count() {
    return items.size;
  }

  return { enqueue, dismiss, pin, unpin, list, count };
}
