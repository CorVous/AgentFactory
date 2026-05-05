// template-loader.mjs — loads and validates a named YAML template from the
// pi-sandbox/templates/ directory, verifying that every listed extension has a
// corresponding .ts file in the extensions directory.
//
// Exports a single named function: loadTemplate(name, fsContext) → string[]
//
// This module is intentionally not yet imported by the runner (Slice 1).
// Runtime behaviour of npm run agent and npm run mesh is unchanged.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/**
 * Loads a YAML template by name and returns its extensions list.
 *
 * @param {string} name - Template name (without .yaml extension).
 * @param {{ templatesDir: string, extensionsDir: string }} fsContext
 *   - templatesDir: absolute path to the templates directory.
 *   - extensionsDir: absolute path to the extensions directory.
 * @returns {string[]} The extensions list declared in the template, in order.
 * @throws {Error} On any validation failure, with a "template-loader: " prefix.
 */
export function loadTemplate(name, fsContext) {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("template-loader: name must be a non-empty string");
  }

  const { templatesDir, extensionsDir } = fsContext ?? {};

  if (typeof templatesDir !== "string") {
    throw new Error("template-loader: fsContext.templatesDir must be a string");
  }
  if (typeof extensionsDir !== "string") {
    throw new Error("template-loader: fsContext.extensionsDir must be a string");
  }

  const templatePath = path.join(templatesDir, `${name}.yaml`);

  if (!existsSync(templatePath)) {
    throw new Error(`template-loader: template not found: ${templatePath}`);
  }

  const raw = readFileSync(templatePath, "utf8");

  let parsed;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`template-loader: failed to parse ${templatePath}: ${e.message}`);
  }

  if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`template-loader: template ${templatePath} must be a YAML mapping at top level`);
  }

  if (parsed.extensions === undefined || parsed.extensions === null) {
    throw new Error(`template-loader: template ${templatePath} missing 'extensions' list`);
  }

  if (!Array.isArray(parsed.extensions)) {
    throw new Error(`template-loader: template ${templatePath} 'extensions' must be a list`);
  }

  if (parsed.extensions.length === 0) {
    return [];
  }

  for (let i = 0; i < parsed.extensions.length; i++) {
    const entry = parsed.extensions[i];
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(
        `template-loader: template ${templatePath} 'extensions[${i}]' must be a non-empty string`
      );
    }
    const extPath = path.join(extensionsDir, `${entry}.ts`);
    if (!existsSync(extPath)) {
      throw new Error(
        `template-loader: extension '${entry}' listed in ${templatePath} not found at ${extPath}`
      );
    }
  }

  return [...parsed.extensions];
}
