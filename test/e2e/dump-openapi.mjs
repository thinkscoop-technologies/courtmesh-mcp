#!/usr/bin/env node
/**
 * Dumps the CourtMesh public API OpenAPI spec to test/e2e/openapi.json, which
 * is gitignored: this is a public repo and the dump is for local comparison only.
 *
 * The source is a TypeScript module that builds the spec as a JS object, so run
 * this with a tsx that can resolve that module's own imports.
 *
 * Usage:
 *   node --import tsx test/e2e/dump-openapi.mjs <path/to/spec-module.ts> [output.json]
 *
 * The output defaults to test/e2e/openapi.json next to this script.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

if (!process.argv[2]) {
  console.error("Usage: dump-openapi.mjs <path/to/spec-module.ts> [output.json]");
  process.exit(1);
}
const SPEC_MODULE = path.resolve(process.argv[2]);
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : path.join(HERE, "openapi.json");

const mod = await import(SPEC_MODULE);

// The module may export the spec under different names; try the common ones.
const candidateNames = ["openApiSpec", "OPENAPI_SPEC", "spec", "default", "buildOpenApiSpec", "getOpenApiSpec"];
let specValue;
for (const name of candidateNames) {
  const v = mod[name];
  if (v === undefined) continue;
  specValue = typeof v === "function" ? v() : v;
  if (specValue) break;
}
if (!specValue) {
  console.error("Exports found on module:", Object.keys(mod));
  throw new Error("Could not find the OpenAPI spec export. Inspect the exports above and adjust candidateNames.");
}

fs.writeFileSync(OUT, JSON.stringify(specValue, null, 2));
console.error(`Wrote ${OUT} (${fs.statSync(OUT).size} bytes)`);
