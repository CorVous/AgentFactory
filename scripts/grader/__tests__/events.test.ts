import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { readFinalAssistantText } from "../lib/events.ts";

/** Build a minimal NDJSON events stream with the given messages. */
function buildNdjson(msgs: Array<{ type: string; text?: string }>): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: "session_start" }));
  for (const m of msgs) {
    if (m.type === "tool_read_procedure") {
      lines.push(
        JSON.stringify({
          type: "tool_execution_end",
          toolName: "read",
          result: {
            content: [
              {
                type: "text",
                text:
                  // literal echo of procedure.md's GAP template
                  'GAP: I don\'t have a component for "<user\'s ask, quoted>".\n' +
                  "Patterns I know: recon, drafter-with-approval, ...\n",
              },
            ],
          },
        }),
      );
    } else if (m.type === "message_end") {
      lines.push(
        JSON.stringify({
          type: "message_end",
          message: { content: [{ type: "text", text: m.text ?? "" }] },
        }),
      );
    } else if (m.type === "thinking_end") {
      lines.push(
        JSON.stringify({
          type: "message_end",
          message: { content: [{ type: "thinking", text: m.text ?? "" }] },
        }),
      );
    }
  }
  return lines.join("\n") + "\n";
}

describe("readFinalAssistantText", () => {
  it("returns the text of the last message_end event", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "events-test-"));
    try {
      const file = path.join(tmp, "events.ndjson");
      fs.writeFileSync(
        file,
        buildNdjson([
          { type: "message_end", text: "first reply" },
          { type: "message_end", text: "final reply" },
        ]),
      );
      assert.equal(readFinalAssistantText(file), "final reply");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns null when events.ndjson is missing", () => {
    assert.equal(readFinalAssistantText("/definitely/not/a/path.ndjson"), null);
  });

  it("returns null when no message_end is present (run aborted mid-turn)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "events-test-"));
    try {
      const file = path.join(tmp, "events.ndjson");
      fs.writeFileSync(file, buildNdjson([{ type: "tool_read_procedure" }]));
      assert.equal(readFinalAssistantText(file), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores tool-read echoes of procedure.md (false-positive guard)", () => {
    // The model read procedure.md (template echoed verbatim) but its
    // actual final message contains no GAP marker. The helper must
    // return ONLY the final assistant text, not the tool echo.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "events-test-"));
    try {
      const file = path.join(tmp, "events.ndjson");
      fs.writeFileSync(
        file,
        buildNdjson([
          { type: "tool_read_procedure" },
          { type: "message_end", text: "Here's your extension." },
        ]),
      );
      const out = readFinalAssistantText(file);
      assert.equal(out, "Here's your extension.");
      // Regression assertion: the procedure echo must NOT leak into
      // the returned string.
      assert.ok(out !== null && !out.includes("I don't have a component"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ignores non-text content blocks (thinking, tool_use)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "events-test-"));
    try {
      const file = path.join(tmp, "events.ndjson");
      fs.writeFileSync(
        file,
        buildNdjson([
          { type: "thinking_end", text: "deliberation only, no user-facing text" },
        ]),
      );
      // message_end with only a thinking block and no text block returns null.
      assert.equal(readFinalAssistantText(file), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("handles files above the v8 string-size cap by tailing", () => {
    // Simulate a runaway output: prepend ~6 MB of filler, then the
    // genuine final message at the end. The full-read path would work
    // here too, but the test pins the tail path's behavior: that
    // trimming the first (partial) line doesn't drop the trailing
    // message_end.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "events-test-"));
    try {
      const file = path.join(tmp, "events.ndjson");
      const filler =
        JSON.stringify({ type: "message_update", delta: "x".repeat(1024) }) + "\n";
      const fd = fs.openSync(file, "w");
      try {
        // ~6 MB of filler is above the 5 MB tail window.
        for (let i = 0; i < 6 * 1024; i++) fs.writeSync(fd, filler);
        const trailing = buildNdjson([
          { type: "message_end", text: "the real final" },
        ]);
        fs.writeSync(fd, trailing);
      } finally {
        fs.closeSync(fd);
      }
      assert.equal(readFinalAssistantText(file), "the real final");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
