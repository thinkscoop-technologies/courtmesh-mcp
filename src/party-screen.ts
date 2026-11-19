/**
 * Shaping of party screen results for an MCP client.
 *
 * A common name screen is 50 to 80 KB of JSON, most of it repeated scoring detail per match
 * (signals, rationale, strategies). An assistant reading ten screens runs out of room long before
 * the analyst runs out of names. The compact shape keeps what a reader decides on: who, which case,
 * where, its status, the identity verdict and what would settle it, acts and FIR. Nothing is cut
 * from the summary, excluded, toVerify, addressCourts, coverage, warnings or notice, and detail
 * "full" returns the API's own response unchanged.
 */

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The fields of one match kept in the compact shape, in reading order. */
const MATCH_FIELDS = [
  "caseId",
  "cnr",
  "caseNumber",
  "title",
  "court",
  "caseType",
  "partyRole",
  "status",
  "caseStatus",
  "disposalNature",
  "filingDate",
  "decisionDate",
  "nextHearingDate",
  "casePageUrl",
  "identity",
  "acts",
  "sections",
  "courtRecordActs",
  "courtRecordFir",
] as const;

function compactMatch(m: unknown): unknown {
  if (!isObject(m)) return m;
  const out: Obj = {};
  for (const key of MATCH_FIELDS) {
    const v = m[key];
    if (v !== undefined && v !== null && v !== "") out[key] = v;
  }
  if (isObject(m.confidence) && typeof m.confidence.band === "string") out.band = m.confidence.band;
  if (isObject(m.evidence)) {
    // A match with no identity verdict (a company) keeps its evidence whole: an identifier match is
    // its only proof. A person keeps the two small fields that say what matched.
    if (!isObject(m.identity)) out.evidence = m.evidence;
    else {
      const ev: Obj = {};
      if (Array.isArray(m.evidence.matchedFields)) ev.matchedFields = m.evidence.matchedFields;
      if (typeof m.evidence.disambiguatorPresent === "boolean") ev.disambiguatorPresent = m.evidence.disambiguatorPresent;
      if (Object.keys(ev).length > 0) out.evidence = ev;
    }
  }
  if (Array.isArray(m.sameMatter)) out.sameMatterCount = m.sameMatter.length;
  return out;
}

/** One screen result (the API's `data`), compacted. Anything not shaped like a screen passes through. */
export function compactScreen(screen: unknown): unknown {
  if (!isObject(screen) || !Array.isArray(screen.matches)) return screen;
  const out: Obj = { ...screen, matches: screen.matches.map(compactMatch) };
  if (Array.isArray(screen.relatedButUnverified)) {
    out.relatedButUnverified = screen.relatedButUnverified.map(compactMatch);
  }
  return out;
}

/** A batch result (the API's `data` with `results`), each item's screen compacted. */
export function compactBatch(batch: unknown): unknown {
  if (!isObject(batch) || !Array.isArray(batch.results)) return batch;
  return {
    ...batch,
    results: batch.results.map((r) => (isObject(r) && isObject(r.screen) ? { ...r, screen: compactScreen(r.screen) } : r)),
  };
}

/** The error code a batch item carries when its search did not finish (never charged). */
export const ITEM_SEARCH_UNFINISHED = "PARTY_SCREEN_ITEM_FAILED";

/** The errorIds of the failed items worth sending again, in order. */
export function failedItemErrorIds(batch: unknown): string[] {
  if (!isObject(batch) || !Array.isArray(batch.results)) return [];
  return failedItemPositions(batch).map((at) => {
    const r = (batch.results as unknown[])[at];
    return isObject(r) && isObject(r.error) && typeof r.error.errorId === "string" ? r.error.errorId : String(at);
  });
}

/** Positions (in the results array) of items that failed and are worth sending again. */
export function failedItemPositions(batch: unknown): number[] {
  if (!isObject(batch) || !Array.isArray(batch.results)) return [];
  const out: number[] = [];
  batch.results.forEach((r, i) => {
    if (isObject(r) && r.ok === false && isObject(r.error) && r.error.code === ITEM_SEARCH_UNFINISHED) out.push(i);
  });
  return out;
}

/**
 * Puts a rerun's results back in the places of the items it reran. `positions[k]` is where the
 * rerun's k-th result goes; index and clientRef stay those of the original request. The summary is
 * recounted from the merged results.
 */
export function mergeBatchRerun(batch: Obj, positions: number[], rerun: unknown): Obj {
  const results = Array.isArray(batch.results) ? [...batch.results] : [];
  const fresh = isObject(rerun) && Array.isArray(rerun.results) ? rerun.results : [];
  positions.forEach((at, k) => {
    // The rerun's own index is the item's place in the rerun request.
    const r = fresh.find((x) => isObject(x) && x.index === k);
    const original = results[at];
    if (!isObject(r) || !isObject(original)) return;
    results[at] = { ...r, index: original.index, ...(original.clientRef !== undefined ? { clientRef: original.clientRef } : {}) };
  });
  const summary = { items: results.length, matchesFound: 0, noMatches: 0, inconclusive: 0, errors: 0 };
  for (const r of results) {
    if (!isObject(r) || r.ok !== true || !isObject(r.screen) || !isObject(r.screen.summary)) {
      summary.errors += 1;
      continue;
    }
    const v = r.screen.summary.verdict;
    if (v === "matches_found") summary.matchesFound += 1;
    else if (v === "no_matches_found") summary.noMatches += 1;
    else summary.inconclusive += 1;
  }
  return { ...batch, results, summary };
}
