export interface Habitat {
  // Identity
  agentName: string;
  description?: string;
  tier?: string;
  type?: string;

  // Filesystem
  scratchRoot: string;

  // Bus
  busRoot: string;

  // Recipe metadata exposed for footer rendering
  skills: string[];
  agents: string[];

  // No-edit rail config (carried forward; recipe-schema removal deferred)
  noEditAdd: string[];
  noEditSkip: string[];

  // Phase 3b: peer relationships
  supervisor?: string;
  submitTo?: string;
  acceptedFrom: string[];
  peers: string[];
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== "string") {
    throw new Error(`materialiseHabitat: required field '${key}' must be a non-null string (got ${JSON.stringify(v)})`);
  }
  return v;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return undefined;
  return v;
}

function stringList(obj: Record<string, unknown>, key: string): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string");
}

export function materialiseHabitat(rawJson: string): Habitat {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e) {
    throw new Error(`materialiseHabitat: invalid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("materialiseHabitat: spec must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  return {
    agentName: requireString(obj, "agentName"),
    scratchRoot: requireString(obj, "scratchRoot"),
    busRoot: requireString(obj, "busRoot"),
    description: optionalString(obj, "description"),
    tier: optionalString(obj, "tier"),
    type: optionalString(obj, "type"),
    skills: stringList(obj, "skills"),
    agents: stringList(obj, "agents"),
    noEditAdd: stringList(obj, "noEditAdd"),
    noEditSkip: stringList(obj, "noEditSkip"),
    supervisor: optionalString(obj, "supervisor"),
    submitTo: optionalString(obj, "submitTo"),
    acceptedFrom: stringList(obj, "acceptedFrom"),
    peers: stringList(obj, "peers"),
  };
}

export function setHabitat(h: Habitat): void {
  (globalThis as { __pi_habitat__?: Habitat }).__pi_habitat__ = h;
}

export function getHabitat(): Habitat {
  const h = (globalThis as { __pi_habitat__?: Habitat }).__pi_habitat__;
  if (!h) throw new Error("getHabitat: Habitat has not been materialised yet; habitat.ts extension must load first");
  return h;
}
