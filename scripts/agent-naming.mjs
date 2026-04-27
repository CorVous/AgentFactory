// Per-instance agent naming. Generates a slug like `cottontail-writer`
// composed of a randomly-picked rabbit breed (or hare breed for the
// `LEAD_HARE_MODEL` tier) plus the recipe's `shortName:` (or filename
// stem). The slug is filesystem-safe and used as the canonical
// `--agent-name` flowing to header rendering, status envelopes, and
// agent-bus socket identity.
//
// Collision detection: the caller passes a `taken` set of slugs that
// must not be reused; the helper iterates breeds in a random order and
// returns the first uncollided pairing. If every breed is taken, it
// falls back to numeric suffixes (`-2`, `-3`, …) on a random breed.
//
// `probeBusRoot` mirrors `probeSocketLive` from agent-bus.ts to detect
// live peers in the bus root so the runner can populate `taken`
// without having to import extension code.

import { readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(readFileSync(path.join(HERE, "breed-names.json"), "utf8"));

export const RABBIT_BREEDS = Object.freeze([...DATA.rabbits]);
export const HARE_BREEDS = Object.freeze([...DATA.hares]);

export function generateInstanceName({ tier, shortName, taken }) {
  if (typeof shortName !== "string" || !shortName) {
    throw new TypeError("generateInstanceName: shortName must be a non-empty string");
  }
  const seen = taken instanceof Set ? taken : new Set();
  const pool = tier === "LEAD_HARE_MODEL" ? HARE_BREEDS : RABBIT_BREEDS;
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  for (const breed of shuffled) {
    const slug = `${breed}-${shortName}`;
    if (!seen.has(slug)) return slug;
  }
  const breed = pool[Math.floor(Math.random() * pool.length)];
  for (let n = 2; n < 1000; n++) {
    const slug = `${breed}-${shortName}-${n}`;
    if (!seen.has(slug)) return slug;
  }
  throw new Error(`agent-naming: exhausted suffix space for ${shortName}`);
}

function probeSocketLive(sockPath, timeoutMs = 50) {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    const done = (live) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      done(true);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

export async function probeBusRoot(busRoot) {
  const taken = new Set();
  let entries;
  try {
    const st = statSync(busRoot);
    if (!st.isDirectory()) return taken;
    entries = readdirSync(busRoot);
  } catch {
    return taken;
  }
  const probes = [];
  for (const entry of entries) {
    if (!entry.endsWith(".sock")) continue;
    const slug = entry.slice(0, -".sock".length);
    if (!slug) continue;
    const sockPath = path.join(busRoot, entry);
    probes.push(probeSocketLive(sockPath).then((live) => (live ? slug : null)));
  }
  const results = await Promise.all(probes);
  for (const r of results) if (r) taken.add(r);
  return taken;
}
