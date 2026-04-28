// Recursive approval primitive — canonical home for requestHumanApproval
// and its RPC helper. Extracted from deferred-confirm.ts (Phase 3c).
//
// Routes an approval request to whoever can answer:
//   - ctx.hasUI → render ctx.ui.confirm locally
//   - getHabitat().rpcSock set → forward to parent via Unix socket RPC
//   - else → loud-fail to stderr, return false
//
// Used by deferred-confirm's agent_end and by supervisor's escalate action.

import net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getHabitat } from "./habitat";

export interface ApprovalRequest {
  title: string;
  summary: string;
  preview: string;
}

export async function requestHumanApproval(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  req: ApprovalRequest,
): Promise<boolean> {
  if (ctx.hasUI) {
    return ctx.ui.confirm(req.title, req.preview);
  }
  let sockPath: string | undefined;
  try { sockPath = getHabitat().rpcSock; } catch { sockPath = undefined; }
  if (sockPath) {
    return rpcRequestApproval(sockPath, req);
  }
  process.stderr.write(
    `[deferred] dropped: no UI and no --rpc-sock (title: ${req.title})\n`,
  );
  return false;
}

export function rpcRequestApproval(sockPath: string, req: ApprovalRequest): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    let buf = "";
    let settled = false;
    const settle = (approved: boolean) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners();
      sock.destroy();
      resolve(approved);
    };
    sock.setEncoding("utf8");
    sock.once("connect", () => {
      const line = JSON.stringify({ type: "request-approval", ...req }) + "\n";
      sock.write(line, "utf8", (err?: Error | null) => {
        if (err) settle(false);
      });
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      try {
        const msg = JSON.parse(line) as { type?: string; approved?: unknown };
        if (msg.type === "approval-result" && typeof msg.approved === "boolean") {
          settle(msg.approved);
          return;
        }
      } catch {
        /* fall through to false */
      }
      settle(false);
    });
    sock.once("error", () => settle(false));
    sock.once("close", () => settle(false));
  });
}
