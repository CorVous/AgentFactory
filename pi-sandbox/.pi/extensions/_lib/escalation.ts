// Recursive approval primitive — canonical home for requestHumanApproval.
//
// Routes an approval request to the local UI when one is available, else
// loud-fails to stderr and returns false. The bus-routed escalation
// (supervisor.ts's `escalate` action) is now the only escalation path
// that crosses agent boundaries.

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export interface ApprovalRequest {
  title: string;
  summary: string;
  preview: string;
}

export async function requestHumanApproval(
  ctx: ExtensionContext,
  _pi: ExtensionAPI,
  req: ApprovalRequest,
): Promise<boolean> {
  if (ctx.hasUI) {
    return ctx.ui.confirm(req.title, req.preview);
  }
  process.stderr.write(
    `[deferred] dropped: no UI available (title: ${req.title})\n`,
  );
  return false;
}
