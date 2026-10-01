import { describe, expect, it } from "vitest";

import { clipStatement, stmtSummary } from "../src/sqlsummary.js";

/**
 * Mirrors the Go (sqltrace_test.go) and Python suites: the same statement
 * must render the same span name in every fleet SDK.
 */
describe("stmtSummary", () => {
  it("renders verb + first table reference", () => {
    const cases: [string, string][] = [
      ["SELECT id, total FROM orders WHERE id = $1", "SELECT orders"],
      ["  insert into users (email) values ($1)", "INSERT users"],
      ["UPDATE public.items SET total = total - 1", "UPDATE items"],
      ["DELETE FROM sessions WHERE expires < now()", "DELETE sessions"],
      ["CREATE TABLE IF NOT EXISTS migrations (id int)", "CREATE migrations"],
      ["select u.id\nfrom users u\njoin orders o on o.user_id = u.id", "SELECT users"],
      ["PRAGMA journal_mode=WAL", "PRAGMA"],
      ["WITH x AS (SELECT 1) SELECT * FROM users", "WITH users"],
      ["(SELECT 1)", "SELECT"],
      // The fleet's table regex skips a single leading quote character, so
      // fully quoted qualified names report the first quoted identifier.
      ["SELECT * FROM \"public\".\"items\"", "SELECT public"],
      ["INSERT INTO logs VALUES (1)", "INSERT logs"],
      ["BEGIN", "BEGIN"],
      ["", "QUERY"],
      ["   ", "QUERY"],
    ];
    for (const [statement, want] of cases) {
      expect(stmtSummary(statement)).toBe(want);
    }
  });

  it("clips statements to 200 single-spaced characters", () => {
    const long = "SELECT " + "x, ".repeat(100) + "1";
    expect(clipStatement(long)).toHaveLength(200);
    expect(clipStatement("SELECT   *\n  FROM   t")).toBe("SELECT * FROM t");
    expect(clipStatement("")).toBe("");
  });
});
