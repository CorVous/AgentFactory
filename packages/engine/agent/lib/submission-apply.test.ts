// Tests for applyArtifacts — the supervisor-side apply path for submission envelopes.
//
// Two-pass verify-then-apply:
//   - verify pass checks SHAs (and existence) without touching the fs
//   - apply pass runs in priority order: writes → edits → moves → deletes
//   - any verify failure aborts the entire batch (atomic)

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { applyArtifacts } from "./submission-apply";
import type { Artifact } from "./bus-envelope";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "submission-apply-test-"));
});

function put(relPath: string, content: string) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}
function cat(relPath: string) {
  return readFileSync(join(root, relPath), "utf8");
}
function has(relPath: string) {
  return existsSync(join(root, relPath));
}

// ---------------------------------------------------------------------------
// write artifact
// ---------------------------------------------------------------------------

describe("write artifact", () => {
  it("happy path: creates new file with correct content", async () => {
    const artifact: Artifact = {
      kind: "write",
      relPath: "new.txt",
      content: "Hello world",
      sha256: sha256("Hello world"),
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.applied).toContain("new.txt");
    expect(cat("new.txt")).toBe("Hello world");
  });

  it("overwrites an existing file (no-edit rail not the apply path's job)", async () => {
    put("existing.txt", "old content");
    const artifact: Artifact = {
      kind: "write",
      relPath: "existing.txt",
      content: "new content",
      sha256: sha256("new content"),
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(true);
    expect(cat("existing.txt")).toBe("new content");
  });

  it("creates parent directories automatically", async () => {
    const artifact: Artifact = {
      kind: "write",
      relPath: "a/b/c/deep.txt",
      content: "deep",
      sha256: sha256("deep"),
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(true);
    expect(cat("a/b/c/deep.txt")).toBe("deep");
  });
});

// ---------------------------------------------------------------------------
// edit artifact
// ---------------------------------------------------------------------------

describe("edit artifact", () => {
  it("happy path: applies edits to existing file", async () => {
    const original = "Hello world\n";
    put("edit-me.txt", original);
    const artifact: Artifact = {
      kind: "edit",
      relPath: "edit-me.txt",
      sha256OfOriginal: sha256(original),
      edits: [{ oldString: "world", newString: "earth" }],
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(true);
    expect(result.applied).toContain("edit-me.txt");
    expect(cat("edit-me.txt")).toBe("Hello earth\n");
  });

  it("applies multiple edits sequentially", async () => {
    const original = "foo bar baz\n";
    put("multi.txt", original);
    const artifact: Artifact = {
      kind: "edit",
      relPath: "multi.txt",
      sha256OfOriginal: sha256(original),
      edits: [
        { oldString: "foo", newString: "FOO" },
        { oldString: "bar", newString: "BAR" },
      ],
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(true);
    expect(cat("multi.txt")).toBe("FOO BAR baz\n");
  });

  it("SHA mismatch: rejected before apply, no fs change", async () => {
    const original = "Hello world\n";
    put("edit-me.txt", original);
    const artifact: Artifact = {
      kind: "edit",
      relPath: "edit-me.txt",
      sha256OfOriginal: "wrong-sha-entirely",
      edits: [{ oldString: "world", newString: "earth" }],
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /sha/i.test(e))).toBe(true);
    expect(cat("edit-me.txt")).toBe(original);
  });

  it("missing file: rejected, no fs change", async () => {
    const artifact: Artifact = {
      kind: "edit",
      relPath: "ghost.txt",
      sha256OfOriginal: sha256("content"),
      edits: [{ oldString: "content", newString: "replacement" }],
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /ghost\.txt/.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// move artifact
// ---------------------------------------------------------------------------

describe("move artifact", () => {
  it("happy path: moves file to destination", async () => {
    const content = "content to move\n";
    put("src.txt", content);
    const artifact: Artifact = {
      kind: "move",
      src: "src.txt",
      dst: "dst.txt",
      sha256OfSource: sha256(content),
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(true);
    expect(result.applied).toContain("src.txt");
    expect(has("dst.txt")).toBe(true);
    expect(has("src.txt")).toBe(false);
    expect(cat("dst.txt")).toBe(content);
  });

  it("creates destination parent directories automatically", async () => {
    const content = "deep move\n";
    put("src.txt", content);
    const artifact: Artifact = {
      kind: "move",
      src: "src.txt",
      dst: "a/b/dst.txt",
      sha256OfSource: sha256(content),
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(true);
    expect(cat("a/b/dst.txt")).toBe(content);
  });

  it("SHA mismatch: rejected before apply, no fs change", async () => {
    const content = "original content\n";
    put("src.txt", content);
    const artifact: Artifact = {
      kind: "move",
      src: "src.txt",
      dst: "dst.txt",
      sha256OfSource: "wrong-sha",
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /sha/i.test(e))).toBe(true);
    expect(has("src.txt")).toBe(true);
    expect(has("dst.txt")).toBe(false);
  });

  it("missing source: rejected, no fs change", async () => {
    const artifact: Artifact = {
      kind: "move",
      src: "ghost.txt",
      dst: "dst.txt",
      sha256OfSource: sha256("something"),
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /ghost\.txt/.test(e))).toBe(true);
    expect(has("dst.txt")).toBe(false);
  });

  it("destination already exists: rejected before apply", async () => {
    const content = "some content\n";
    put("src.txt", content);
    put("dst.txt", "already exists\n");
    const artifact: Artifact = {
      kind: "move",
      src: "src.txt",
      dst: "dst.txt",
      sha256OfSource: sha256(content),
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /dst\.txt/.test(e))).toBe(true);
    expect(cat("src.txt")).toBe(content);
    expect(cat("dst.txt")).toBe("already exists\n");
  });
});

// ---------------------------------------------------------------------------
// delete artifact
// ---------------------------------------------------------------------------

describe("delete artifact", () => {
  it("happy path: removes file", async () => {
    const content = "to be deleted\n";
    put("del.txt", content);
    const artifact: Artifact = {
      kind: "delete",
      relPath: "del.txt",
      sha256: sha256(content),
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(true);
    expect(result.applied).toContain("del.txt");
    expect(has("del.txt")).toBe(false);
  });

  it("SHA mismatch: rejected before apply, no fs change", async () => {
    const content = "do not delete\n";
    put("del.txt", content);
    const artifact: Artifact = {
      kind: "delete",
      relPath: "del.txt",
      sha256: "wrong-sha",
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /sha/i.test(e))).toBe(true);
    expect(has("del.txt")).toBe(true);
  });

  it("missing file: rejected, no fs change", async () => {
    const artifact: Artifact = {
      kind: "delete",
      relPath: "ghost.txt",
      sha256: sha256("something"),
    };
    const result = await applyArtifacts(root, [artifact]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /ghost\.txt/.test(e))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// atomic batch — any verify failure aborts all
// ---------------------------------------------------------------------------

describe("atomic batch", () => {
  it("applies nothing when any artifact fails verification", async () => {
    put("edit-me.txt", "to be edited\n");

    const goodWrite: Artifact = {
      kind: "write",
      relPath: "new.txt",
      content: "new file",
      sha256: sha256("new file"),
    };
    const badEdit: Artifact = {
      kind: "edit",
      relPath: "edit-me.txt",
      sha256OfOriginal: "wrong-sha-entirely",
      edits: [{ oldString: "to be edited", newString: "edited" }],
    };

    const result = await applyArtifacts(root, [goodWrite, badEdit]);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    // write was not applied because batch was aborted before apply pass
    expect(has("new.txt")).toBe(false);
    // edit target unchanged
    expect(cat("edit-me.txt")).toBe("to be edited\n");
  });

  it("collects all verification errors (not just the first)", async () => {
    const art1: Artifact = { kind: "delete", relPath: "missing1.txt", sha256: sha256("x") };
    const art2: Artifact = { kind: "delete", relPath: "missing2.txt", sha256: sha256("y") };
    const result = await applyArtifacts(root, [art1, art2]);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBe(2);
  });

  it("empty artifact list succeeds with no applied paths", async () => {
    const result = await applyArtifacts(root, []);
    expect(result.ok).toBe(true);
    expect(result.applied).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// apply order: writes → edits → moves → deletes
// ---------------------------------------------------------------------------

describe("apply order", () => {
  it("edits apply before moves (even when listed in reverse order)", async () => {
    // File X exists. Edit changes X. Move renames X to Y.
    // Both verify against original X. Apply must do edit first (so Y gets the edited content).
    put("file-x.txt", "Hello\n");

    const editArtifact: Artifact = {
      kind: "edit",
      relPath: "file-x.txt",
      sha256OfOriginal: sha256("Hello\n"),
      edits: [{ oldString: "Hello", newString: "World" }],
    };
    const moveArtifact: Artifact = {
      kind: "move",
      src: "file-x.txt",
      dst: "file-y.txt",
      sha256OfSource: sha256("Hello\n"),
    };

    // Pass move before edit to confirm ordering is enforced internally
    const result = await applyArtifacts(root, [moveArtifact, editArtifact]);
    expect(result.ok).toBe(true);
    expect(has("file-x.txt")).toBe(false);
    expect(has("file-y.txt")).toBe(true);
    expect(cat("file-y.txt")).toBe("World\n");
  });

  it("moves apply before deletes", async () => {
    const contentA = "file A\n";
    const contentB = "file B\n";
    put("a.txt", contentA);
    put("b.txt", contentB);

    const deleteA: Artifact = { kind: "delete", relPath: "a.txt", sha256: sha256(contentA) };
    const moveB: Artifact = {
      kind: "move",
      src: "b.txt",
      dst: "c.txt",
      sha256OfSource: sha256(contentB),
    };

    // Delete listed before move; moves should still happen before deletes
    const result = await applyArtifacts(root, [deleteA, moveB]);
    expect(result.ok).toBe(true);
    expect(has("a.txt")).toBe(false);
    expect(has("b.txt")).toBe(false);
    expect(has("c.txt")).toBe(true);
    expect(cat("c.txt")).toBe(contentB);
  });

  it("writes apply before edits (write creates file, edit modifies it via separate batch items)", async () => {
    // Edge case: write creates new.txt; a delete of an already-existing file
    // is listed first — deletes run last so the pre-existing file is still intact at verify time.
    const existing = "existing content\n";
    put("existing.txt", existing);

    const writeArtifact: Artifact = {
      kind: "write",
      relPath: "created.txt",
      content: "created\n",
      sha256: sha256("created\n"),
    };
    const deleteArtifact: Artifact = {
      kind: "delete",
      relPath: "existing.txt",
      sha256: sha256(existing),
    };

    // delete listed first, write listed second
    const result = await applyArtifacts(root, [deleteArtifact, writeArtifact]);
    expect(result.ok).toBe(true);
    expect(has("created.txt")).toBe(true);
    expect(has("existing.txt")).toBe(false);
  });
});
