// .pi/extensions/recon-summarize.ts — recon agent.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PHASE_TIMEOUT_MS = 120_000;
const SUMMARY_BYTE_CAP = 8_000;
const TOTAL_BYTE_CAP = 32_000;

const EMIT_SUMMARY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "components", "emit-summary.ts",
);

export default function (pi: ExtensionAPI) {
  pi.registerCommand("recon-summarize", {
    description: "Provide a high-level overview of a directory's contents.",
    handler: async (args, ctx) => {
      const target = args.trim() || ".";
      const MODEL = process.env.TASK_MODEL;
      if (!MODEL) {
        ctx.ui.notify("TASK_MODEL env var not set. Source models.env.", "error");
        return;
      }
      if (!fs.existsSync(EMIT_SUMMARY)) {
        ctx.ui.notify(`emit-summary missing at ${EMIT_SUMMARY}`, "error");
        return;
      }
      const sandboxRoot = path.resolve(process.cwd());
      const targetAbs = path.resolve(sandboxRoot, target);
      if (targetAbs !== sandboxRoot && !targetAbs.startsWith(sandboxRoot + path.sep)) {
        ctx.ui.notify(`${target}: escapes sandbox ${sandboxRoot}`, "error");
        return;
      }

      const agentPrompt =
        `You are a RECON AGENT. Survey ${targetAbs} and produce bounded ` +
        `summaries. Use only 'ls', 'read', 'grep', 'glob' (no write, no edit, ` +
        `no bash). Instead of producing a final assistant message, call ` +
        `emit_summary({title, body}) with a short title and a body <= ${SUMMARY_BYTE_CAP} ` +
        `bytes naming the files/directories you actually saw. Call it once for ` +
        `the overall directory survey; call it a second time only if you have ` +
        `a distinct, differently-scoped view to report. ` +
        `Focus on the folder structure, key files, and overall organization. Reply DONE and stop.`;

      const summaries: Array<{ title: string; body: string }> = [];
      const child = spawn(
        "pi",
        [
          "-e", EMIT_SUMMARY,
          "--mode", "json",
          "--tools", "ls,read,grep,glob,emit_summary",
          "--no-extensions",
          "--provider", "openrouter",
          "--model", MODEL,
          "--no-session",
          "--thinking", "off",
          "-p", agentPrompt,
        ],
        { stdio: ["ignore", "pipe", "pipe"], cwd: sandboxRoot },
      );

      let buffer = "";
      let stderr = "";
      let toolCalls = 0;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, PHASE_TIMEOUT_MS);

      child.stdout.on("data", (d) => {
        buffer += d.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let e: Record<string, unknown>;
          try { e = JSON.parse(line); } catch { continue; }
          if (e.type === "tool_execution_start" && e.toolName === "emit_summary") {
            toolCalls++;
            const a = e.args as Record<string, unknown> | undefined;
            const title = typeof a?.title === "string" ? a.title : "";
            const body = typeof a?.body === "string" ? a.body : "";
            if (title && body) {
              summaries.push({ title, body });
              ctx.ui.notify(`Recon → emit_summary "${title}" (${Buffer.byteLength(body, "utf8")} bytes)`, "info");
            }
          } else if (e.type === "tool_execution_start") {
            toolCalls++;
            ctx.ui.notify(`Recon → ${e.toolName}`, "info");
          }
        }
      });
      child.stderr.on("data", (d) => { stderr += d.toString(); });

      await new Promise<void>((resolve) => {
        child.on("close", () => { clearTimeout(timer); resolve(); });
        child.on("error", () => { clearTimeout(timer); resolve(); });
      });

      if (timedOut) {
        ctx.ui.notify(`Recon timed out after ${PHASE_TIMEOUT_MS / 1000}s.`, "error");
        return;
      }
      if (summaries.length === 0) {
        ctx.ui.notify(`Recon produced no emit_summary calls. Stderr: ${stderr.slice(-1000)}`, "error");
        return;
      }

      // Per-summary byte cap, then total-length cap on the concatenation.
      const capped = summaries.map((s) => {
        const bytes = Buffer.byteLength(s.body, "utf8");
        const body = bytes > SUMMARY_BYTE_CAP ? s.body.slice(0, SUMMARY_BYTE_CAP) + "\n…(truncated)" : s.body;
        return `## ${s.title}\n\n${body}`;
      });
      let combined = capped.join("\n\n---\n\n");
      if (Buffer.byteLength(combined, "utf8") > TOTAL_BYTE_CAP) {
        combined = combined.slice(0, TOTAL_BYTE_CAP) + "\n…(truncated)";
      }

      const outDir = path.resolve(sandboxRoot, ".pi/scratch");
      fs.mkdirSync(outDir, { recursive: true });
      const outPath = path.join(outDir, "recon-summarize-summary.md");
      fs.writeFileSync(outPath, combined, "utf8");
      ctx.ui.notify(
        `Recon complete (${toolCalls} tool call(s), ${summaries.length} summary/summaries, ${Buffer.byteLength(combined, "utf8")} bytes). Summary: ${outPath}`,
        "info",
      );
    },
  });
}
