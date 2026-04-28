// Supervisor-side apply path for submission envelopes.
//
// Two-pass design:
//   1. Verify pass — checks SHAs (and existence) without touching the fs.
//      Any failure collects into an error list and aborts the batch.
//   2. Apply pass — runs in fixed priority order (writes → edits → moves →
//      deletes) so compositions like "edit X then move it to Y" work
//      deterministically regardless of the order artifacts arrive in.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Artifact } from "./bus-envelope";

export interface ApplyResult {
  ok: boolean;
  applied: string[]; // relPaths (or src for moves) successfully applied
  errors: string[];  // human-readable errors (empty when ok)
}

const KIND_ORDER: Record<Artifact["kind"], number> = {
  write: 0,
  edit: 1,
  move: 2,
  delete: 3,
};

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function applyUnique(
  content: string,
  oldStr: string,
  newStr: string,
): { ok: true; out: string } | { ok: false; err: string } {
  if (oldStr.length === 0) return { ok: false, err: "oldString is empty" };
  const idx = content.indexOf(oldStr);
  if (idx < 0) return { ok: false, err: "oldString not found in content" };
  if (content.indexOf(oldStr, idx + 1) >= 0)
    return { ok: false, err: "oldString matches multiple times; add surrounding context" };
  return { ok: true, out: content.slice(0, idx) + newStr + content.slice(idx + oldStr.length) };
}

export async function applyArtifacts(
  canonicalRoot: string,
  artifacts: Artifact[],
): Promise<ApplyResult> {
  const verifyErrors: string[] = [];

  // --- VERIFY PASS ---
  for (const a of artifacts) {
    switch (a.kind) {
      case "write":
        // No SHA verification for writes — SHA is informational only.
        break;

      case "edit": {
        const abs = path.join(canonicalRoot, a.relPath);
        if (!fs.existsSync(abs)) {
          verifyErrors.push(`${a.relPath}: file does not exist`);
          break;
        }
        const content = fs.readFileSync(abs, "utf8");
        const actual = sha256(content);
        if (actual !== a.sha256OfOriginal) {
          verifyErrors.push(
            `${a.relPath}: sha256 mismatch (expected ${a.sha256OfOriginal.slice(0, 10)}, got ${actual.slice(0, 10)})`,
          );
        }
        break;
      }

      case "move": {
        const srcAbs = path.join(canonicalRoot, a.src);
        const dstAbs = path.join(canonicalRoot, a.dst);
        if (!fs.existsSync(srcAbs)) {
          verifyErrors.push(`${a.src}: source file does not exist`);
          break;
        }
        const content = fs.readFileSync(srcAbs, "utf8");
        const actual = sha256(content);
        if (actual !== a.sha256OfSource) {
          verifyErrors.push(
            `${a.src}: sha256 mismatch (expected ${a.sha256OfSource.slice(0, 10)}, got ${actual.slice(0, 10)})`,
          );
          break;
        }
        if (fs.existsSync(dstAbs)) {
          verifyErrors.push(`${a.dst}: destination already exists`);
        }
        break;
      }

      case "delete": {
        const abs = path.join(canonicalRoot, a.relPath);
        if (!fs.existsSync(abs)) {
          verifyErrors.push(`${a.relPath}: file does not exist`);
          break;
        }
        const content = fs.readFileSync(abs, "utf8");
        const actual = sha256(content);
        if (actual !== a.sha256) {
          verifyErrors.push(
            `${a.relPath}: sha256 mismatch (expected ${a.sha256.slice(0, 10)}, got ${actual.slice(0, 10)})`,
          );
        }
        break;
      }
    }
  }

  if (verifyErrors.length > 0) {
    return { ok: false, applied: [], errors: verifyErrors };
  }

  // --- APPLY PASS (sorted by kind priority) ---
  const sorted = [...artifacts].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const applied: string[] = [];
  const applyErrors: string[] = [];

  for (const a of sorted) {
    switch (a.kind) {
      case "write": {
        try {
          const abs = path.join(canonicalRoot, a.relPath);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, a.content, "utf8");
          applied.push(a.relPath);
        } catch (e) {
          applyErrors.push(`${a.relPath}: write failed — ${(e as Error).message}`);
        }
        break;
      }

      case "edit": {
        try {
          const abs = path.join(canonicalRoot, a.relPath);
          let content = fs.readFileSync(abs, "utf8");
          let editOk = true;
          for (const e of a.edits) {
            const r = applyUnique(content, e.oldString, e.newString);
            if (!r.ok) {
              applyErrors.push(`${a.relPath}: edit failed — ${r.err}`);
              editOk = false;
              break;
            }
            content = r.out;
          }
          if (editOk) {
            fs.writeFileSync(abs, content, "utf8");
            applied.push(a.relPath);
          }
        } catch (e) {
          applyErrors.push(`${a.relPath}: edit failed — ${(e as Error).message}`);
        }
        break;
      }

      case "move": {
        try {
          const srcAbs = path.join(canonicalRoot, a.src);
          const dstAbs = path.join(canonicalRoot, a.dst);
          fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
          try {
            fs.renameSync(srcAbs, dstAbs);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EXDEV") {
              fs.copyFileSync(srcAbs, dstAbs);
              fs.unlinkSync(srcAbs);
            } else {
              throw e;
            }
          }
          applied.push(a.src);
        } catch (e) {
          applyErrors.push(`${a.src} → ${a.dst}: move failed — ${(e as Error).message}`);
        }
        break;
      }

      case "delete": {
        try {
          const abs = path.join(canonicalRoot, a.relPath);
          fs.unlinkSync(abs);
          applied.push(a.relPath);
        } catch (e) {
          applyErrors.push(`${a.relPath}: delete failed — ${(e as Error).message}`);
        }
        break;
      }
    }
  }

  return { ok: applyErrors.length === 0, applied, errors: applyErrors };
}
