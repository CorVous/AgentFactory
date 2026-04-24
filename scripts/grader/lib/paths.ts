import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FRAMEWORK_ROOT = path.resolve(HERE, "..", "..");
export const REPO_ROOT = path.resolve(FRAMEWORK_ROOT, "..");
