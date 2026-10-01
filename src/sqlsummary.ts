/**
 * Statement summaries: a short human name for a SQL statement — the verb
 * plus the first table reference when one exists ("SELECT orders",
 * "INSERT users"); bare verbs and non-SQL fall back to the first word
 * uppercased ("QUERY" when there is none). This is a line-for-line port of
 * the fleet's stmtSummary (Go sqltrace.go / Python transport.py), so the
 * same statement renders the same span name in every SDK.
 */

// (?is) in Go: case-insensitive + DOTALL. The verb must open the statement
// (leading parens allowed: "(SELECT ...)").
const STMT_VERB_RE =
  /^\s*\(?\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|WITH|BEGIN|COMMIT|ROLLBACK|SET|CALL|EXEC|SHOW|EXPLAIN)\b/is;

// The first FROM|INTO|UPDATE|TABLE|JOIN, skipping "IF [NOT] EXISTS" and any
// leading quote character; captures the (possibly schema-qualified) table.
// Not g-flagged: this regex is exec()'d repeatedly and must stay stateless.
const STMT_TABLE_RE =
  /\b(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?[`"'\[]?([A-Za-z_][\w$.]*)/i;

/** Single-spaced statement text, truncated to 200 characters. */
export function clipStatement(statement: string): string {
  return singleSpaced(statement).slice(0, 200);
}

/**
 * Renders the span name for one statement: verb + first table reference
 * ("SELECT orders"); schema-qualified names ("public.items") report the
 * bare table and "IF [NOT] EXISTS" is skipped. Non-SQL falls back to the
 * first word uppercased; the empty statement yields "QUERY".
 */
export function stmtSummary(statement: string): string {
  const one = singleSpaced(statement);
  const m = STMT_VERB_RE.exec(one);
  if (m === null) {
    // No known verb: first word uppercased ("PRAGMA journal_mode..." ->
    // "PRAGMA"), "QUERY" when there is no first word.
    const i = firstBreak(one);
    if (i > 0) return one.slice(0, i).toUpperCase();
    return "QUERY";
  }
  const verb = m[1]?.toUpperCase() ?? "";
  const t = STMT_TABLE_RE.exec(one);
  if (t === null || t[1] === undefined) return verb;
  // Schema-qualified names ("public.items") report the bare table.
  let table: string = t[1];
  const cut = Math.max(table.lastIndexOf("."), table.lastIndexOf("$"));
  if (cut >= 0) table = table.slice(cut + 1);
  return `${verb} ${table}`;
}

/** Go strings.Fields + Join(" "): collapse every whitespace run. */
function singleSpaced(statement: string): string {
  return (statement ?? "").trim().split(/\s+/).filter(Boolean).join(" ");
}

/** First space or open-paren, like the fleet's first-word fallback. */
function firstBreak(one: string): number {
  const space = one.indexOf(" ");
  const paren = one.indexOf("(");
  if (space < 0) return paren;
  if (paren < 0) return space;
  return Math.min(space, paren);
}
