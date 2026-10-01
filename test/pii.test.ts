import { describe, expect, it } from "vitest";

import { classifyPII } from "../src/pii.js";

/**
 * Port contract with dataflow-go/pii.go: identical categories, identical
 * keyword lists, identical matching rules (multiword by substring, single
 * tokens by exact word match) and a sorted, comma-joined result.
 */
describe("classifyPII", () => {
  it("hits every category", () => {
    expect(classifyPII(["password"])).toBe("password");
    expect(classifyPII(["api_key"])).toBe("secret");
    expect(classifyPII(["card_number"])).toBe("payment");
    expect(classifyPII(["email_address"])).toBe("email");
    expect(classifyPII(["phone_number"])).toBe("phone");
    expect(classifyPII(["ssn"])).toBe("government_id");
    expect(classifyPII(["dob"])).toBe("birth");
    expect(classifyPII(["first_name"])).toBe("name");
    expect(classifyPII(["zip_code"])).toBe("address");
    expect(classifyPII(["city"])).toBe("geo");
    expect(classifyPII(["client_ip"])).toBe("ip");
    expect(classifyPII(["user_agent"])).toBe("device");
  });

  it("matches multiword keywords as substrings of the normalized name", () => {
    expect(classifyPII(["customer_first_name"])).toBe("name");
    expect(classifyPII(["billing_address_line"])).toBe("address");
    expect(classifyPII(["user-session-token"])).toBe("secret");
  });

  it("matches single tokens by exact word match", () => {
    expect(classifyPII(["ip"])).toBe("ip");
    // "description" contains "ip" as a substring but never as a word:
    expect(classifyPII(["description"])).toBe("");
    expect(classifyPII(["cardinality"])).toBe("");
    expect(classifyPII(["total_age_seconds"])).toBe("birth"); // word "age"
  });

  it("normalizes separators before matching", () => {
    expect(classifyPII(["first-name"])).toBe("name");
    expect(classifyPII(["first name"])).toBe("name");
    expect(classifyPII(["FIRST.NAME"])).toBe("name");
  });

  it("deduplicates, sorts and comma-joins", () => {
    const out = classifyPII(["email", "phone", "mail", "mobile", "card"]);
    expect(out).toBe("email,payment,phone");
    expect(classifyPII(["zip", "city", "country"])).toBe("address,geo");
  });

  it("returns the empty string for clean fields", () => {
    expect(classifyPII(["order_id", "total_cents", "created_at"])).toBe("");
    expect(classifyPII([])).toBe("");
  });
});
