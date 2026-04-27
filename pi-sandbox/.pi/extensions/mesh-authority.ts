// mesh-authority extension — lifecycle management for long-running mesh peer
// nodes. Works alongside agent-bus (the authority is itself a bus peer).
//
// Registers three tools:
//   mesh_spawn({recipe, name, sandbox?, task?}) — start a peer node in the
//     background; it binds to the shared PI_AGENT_BUS_ROOT and can be reached
//     by its instance name.
//   mesh_stop({name}) — send SIGTERM to a spawned node; SIGKILL after 3 s.
//   mesh_nodes() — list nodes spawned this session with uptime.
//
// On session_shutdown all registered nodes are killed automatically.
//
// Recipe name vs instance name: the recipe is the YAML template in
// pi-sandbox/agents/; the instance name (--agent-name) is the unique
// runtime identity used for bus socket binding and peer addressing. Multiple
// instances of the same recipe can run simultaneously under different names.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { generateInstanceName } from "./_lib/agent-naming.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const RUNNER_PATH = path.join(REPO_ROOT, "scripts", "run-agent.mjs");

const AGENTS_DIR = path.join(REPO_ROOT, "pi-sandbox", "agents");

interface SpawnedNode {
  name: string;
  recipe: string;
  child: ChildProcess;
  sandbox: string;
  startedAt: number;
}

function readRecipeMeta(recipeName: string): { shortName?: string; tier?: string } {
  try {
    const file = path.join(AGENTS_DIR, `${recipeName}.yaml`);
    const recipe = parseYaml(fs.readFileSync(file, "utf8")) as {
      shortName?: unknown;
      model?: unknown;
    };
    return {
      shortName: typeof recipe.shortName === "string" ? recipe.shortName : undefined,
      tier: typeof recipe.model === "string" ? recipe.model : undefined,
    };
  } catch {
    return {};
  }
}

function getRegistry(): Map<string, SpawnedNode> {
  const g = globalThis as { __pi_mesh_nodes__?: Map<string, SpawnedNode> };
  return (g.__pi_mesh_nodes__ ??= new Map());
}

function killNode(node: SpawnedNode): Promise<void> {
  return new Promise((resolve) => {
    if (node.child.exitCode !== null || node.child.killed) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (!settled) { settled = true; resolve(); }
    };
    node.child.once("exit", done);
    try { node.child.kill("SIGTERM"); } catch { /* noop */ }
    // SIGKILL fallback after 3 s
    setTimeout(() => {
      if (!settled) {
        try { node.child.kill("SIGKILL"); } catch { /* noop */ }
      }
      done();
    }, 3000);
  });
}

export default function (pi: ExtensionAPI) {
  const registry = getRegistry();

  // Kill all spawned nodes on session end
  const cleanup = async () => {
    await Promise.all([...registry.values()].map(killNode));
    registry.clear();
  };
  pi.on("session_shutdown", async () => cleanup());
  process.once("exit", () => {
    for (const node of registry.values()) {
      try { node.child.kill("SIGKILL"); } catch { /* noop */ }
    }
  });

  pi.registerTool({
    name: "mesh_spawn",
    label: "Mesh Spawn",
    description:
      "Start a long-running peer node on the mesh bus. The node binds to the " +
      "shared PI_AGENT_BUS_ROOT under its instance name and can be reached by " +
      "any peer via agent_call or agent_send. Returns immediately; the node runs " +
      "in the background until mesh_stop or session end. Recipe is the YAML " +
      "template (e.g. 'mesh-node'); name is the unique instance identity on the bus.",
    parameters: Type.Object({
      recipe: Type.String({ description: "Recipe YAML name in pi-sandbox/agents/ (without .yaml)." }),
      name: Type.Optional(Type.String({ description: "Unique instance name for this node on the bus. Auto-generated as <breed>-<shortName> if omitted." })),
      sandbox: Type.Optional(Type.String({ description: "Working directory for the node. Auto-created if absent." })),
      task: Type.Optional(Type.String({ description: "If set, passed as -p <task> (non-interactive). Omit for interactive mode." })),
    }),
    async execute(_id, params) {
      // Resolve instance name: explicit override or auto-generated slug
      let instanceName = params.name;
      if (!instanceName) {
        const meta = readRecipeMeta(params.recipe);
        const shortName = meta.shortName ?? params.recipe;
        const taken = new Set<string>(registry.keys());
        instanceName = generateInstanceName({ tier: meta.tier, shortName, taken });
      }

      if (registry.has(instanceName)) {
        return {
          content: [{ type: "text", text: `mesh_spawn: instance "${instanceName}" already running.` }],
          details: { spawned: false, reason: "name collision" },
        };
      }

      const recipeFile = path.join(REPO_ROOT, "pi-sandbox", "agents", `${params.recipe}.yaml`);
      if (!existsSync(recipeFile)) {
        return {
          content: [{ type: "text", text: `mesh_spawn: recipe "${params.recipe}" not found at ${recipeFile}.` }],
          details: { spawned: false, reason: "recipe not found" },
        };
      }

      if (!existsSync(RUNNER_PATH)) {
        return {
          content: [{ type: "text", text: `mesh_spawn: runner missing at ${RUNNER_PATH}.` }],
          details: { spawned: false, reason: "runner not found" },
        };
      }

      const sandbox = params.sandbox
        ? path.resolve(params.sandbox)
        : path.join(os.tmpdir(), `pi-mesh-${instanceName}`);
      mkdirSync(sandbox, { recursive: true });

      const busRoot = process.env.PI_AGENT_BUS_ROOT;

      const args = [
        RUNNER_PATH,
        params.recipe,
        "--sandbox",
        sandbox,
        ...(busRoot ? ["--agent-bus", busRoot] : []),
        "--",
        "--agent-name",
        instanceName,
        ...(params.task ? ["-p", params.task] : []),
      ];

      const child = spawn(process.execPath, args, {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_AGENT_NAME: instanceName,
          ...(busRoot ? { PI_AGENT_BUS_ROOT: busRoot } : {}),
        },
      });

      const node: SpawnedNode = {
        name: instanceName,
        recipe: params.recipe,
        child,
        sandbox,
        startedAt: Date.now(),
      };
      registry.set(instanceName, node);

      child.once("exit", (code, sig) => {
        registry.delete(instanceName);
        if (process.env.AGENT_DEBUG === "1") {
          process.stderr.write(`[mesh-authority] node "${instanceName}" exited (code=${code} signal=${sig})\n`);
        }
      });

      return {
        content: [{ type: "text", text: `Spawned node "${instanceName}" (recipe: ${params.recipe}, sandbox: ${sandbox}).` }],
        details: { spawned: true, name: instanceName, recipe: params.recipe, sandbox },
      };
    },
  });

  pi.registerTool({
    name: "mesh_stop",
    label: "Mesh Stop",
    description: "Stop a running mesh node by instance name. Sends SIGTERM; SIGKILL after 3 s.",
    parameters: Type.Object({
      name: Type.String({ description: "Instance name of the node to stop." }),
    }),
    async execute(_id, params) {
      const node = registry.get(params.name);
      if (!node) {
        return {
          content: [{ type: "text", text: `mesh_stop: no running node named "${params.name}".` }],
          details: { stopped: false, reason: "not found" },
        };
      }
      registry.delete(params.name);
      await killNode(node);
      return {
        content: [{ type: "text", text: `Stopped node "${params.name}".` }],
        details: { stopped: true, name: params.name },
      };
    },
  });

  pi.registerTool({
    name: "mesh_nodes",
    label: "Mesh Nodes",
    description: "List mesh nodes spawned in this session, with their recipe, sandbox, and uptime.",
    parameters: Type.Object({}),
    async execute() {
      if (registry.size === 0) {
        return {
          content: [{ type: "text", text: "(no nodes spawned this session)" }],
          details: { nodes: [] },
        };
      }
      const now = Date.now();
      const nodes = [...registry.values()].map((n) => ({
        name: n.name,
        recipe: n.recipe,
        sandbox: n.sandbox,
        uptime_s: Math.floor((now - n.startedAt) / 1000),
        pid: n.child.pid,
      }));
      const lines = nodes.map((n) => `${n.name} (${n.recipe}) — ${n.uptime_s}s uptime, pid ${n.pid}, sandbox: ${n.sandbox}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { nodes },
      };
    },
  });
}
