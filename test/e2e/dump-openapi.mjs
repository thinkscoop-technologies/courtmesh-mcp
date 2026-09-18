#!/usr/bin/env node
/**
 * Dumps the CourtMesh public API OpenAPI spec to test/e2e/openapi.json.
 *
 * The spec lives in the research repo as a TypeScript module that builds a JS
 * object (not a static JSON file), so this imports it via tsx from that repo's
 * own node_modules (it has real dependents there: zod, etc). Run from the
 * courtmesh-mcp repo, but executed with the research repo's tsx binary so the
 * module resolution (relative imports inside research/server/**) works.
 *
 * Usage:
 *   node --import tsx test/e2e/dump-openapi.mjs [path/to/research/server/public-api/openapi.ts] [output.json]
 *
 * Both arguments are optional. This is a public repo, so neither path may be
 * hardcoded to one contributor's own machine: the source module defaults to
 * the standard sibling checkout layout (this repo and research checked out
 * next to each other), and the output defaults to test/e2e/openapi.json next
 * to this script. Pass either argument explicitly when your checkout layout
 * differs.
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_RESEARCH_OPENAPI = path.resolve(HERE, "../../../research/server/public-api/openapi.ts");
const RESEARCH_OPENAPI = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_RESEARCH_OPENAPI;
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : path.join(HERE, "openapi.json");

const mod = await import(RESEARCH_OPENAPI);

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
