import { createHash } from "node:crypto";

/** SHA-256 of a UTF-8 string, hex-encoded. */
export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
