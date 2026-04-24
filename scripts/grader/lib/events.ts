import fs from "node:fs";

const TAIL_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Read events.ndjson and return the assistant's final message text —
 * the concatenated `text` blocks of the last `{"type":"message_end"}`
 * event. Returns null when the file is missing or contains no
 * message_end.
 *
 * Used by the assembler grader's GAP check. Earlier versions of that
 * check greped the whole file for the GAP marker, which false-
 * positived whenever the model called `read` on procedure.md (the
 * skill's template text gets echoed into a tool_execution_end event)
 * and crashed with ERR_STRING_TOO_LONG when a runaway model produced
 * an events.ndjson above the v8 string-size cap. Reading only the
 * final assistant message fixes both: tool echoes are ignored, and a
 * tail-read path handles files over the cap.
 */
export function readFinalAssistantText(eventsPath: string): string | null {
  if (!fs.existsSync(eventsPath)) return null;
  const size = fs.statSync(eventsPath).size;

  let text: string;
  if (size > TAIL_BYTES) {
    const fd = fs.openSync(eventsPath, "r");
    try {
      const buf = Buffer.alloc(TAIL_BYTES);
      fs.readSync(fd, buf, 0, TAIL_BYTES, size - TAIL_BYTES);
      text = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    // The tail almost certainly starts mid-line; drop the partial prefix
    // so the remaining JSON lines parse cleanly.
    const firstNewline = text.indexOf("\n");
    if (firstNewline >= 0) text = text.slice(firstNewline + 1);
  } else {
    text = fs.readFileSync(eventsPath, "utf8");
  }

  let last: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith('{"type":"message_end"')) continue;
    try {
      const ev = JSON.parse(line) as {
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      const content = ev?.message?.content;
      if (!Array.isArray(content)) continue;
      const chunks = content
        .filter((c) => c && c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string);
      if (chunks.length > 0) last = chunks.join("\n");
    } catch {
      // Tolerate malformed lines (e.g. the tail-mode partial that
      // survived the newline trim, or a truncated write).
    }
  }
  return last;
}
