/**
 * Client side CNR normalisation, the same rule the CourtMesh API applies:
 * trim, uppercase, remove spaces, hyphens, slashes, dots and colons, drop a
 * leading CNR, CNR: or CNR NO label. A valid CNR is 16 characters: a 6
 * character establishment code beginning with a 2 letter state code, 6 serial
 * digits and a 4 digit year. The API is the authority; this only tidies input
 * before it is sent.
 */
const CNR_PATTERN = /^[A-Z]{2}[A-Z0-9]{4}[0-9]{10}$/;

export function normalizeCnr(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim().toUpperCase().replace(/[\s\-/.:]+/g, "");
  if (!CNR_PATTERN.test(value)) {
    if (value.startsWith("CNRNO")) value = value.slice(5);
    else if (value.startsWith("CNR")) value = value.slice(3);
  }
  return CNR_PATTERN.test(value) ? value : null;
}

/** Canonical CNR when the input normalises, else the trimmed input so the API can answer INVALID_CNR itself. */
export function cnrForRequest(input: string): string {
  return normalizeCnr(input) ?? String(input).trim();
}
