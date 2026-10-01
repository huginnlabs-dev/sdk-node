/**
 * Client-side PII classification — a verbatim port of dataflow-go/pii.go
 * (the Python SDK carries the identical keyword lists).
 *
 * Field *names* are matched against privacy keywords and reduced to category
 * labels ("email,phone"). Only labels travel in span metadata; values stay
 * in the E2E-encrypted payload. Multiword keywords ("first_name") match by
 * substring of the normalized name, single tokens ("card", "ip") by exact
 * word match so "description" never lights up the "ip" category.
 */

interface PiiCategory {
  category: string;
  keywords: string[];
}

const PII_CATEGORIES: PiiCategory[] = [
  { category: "password", keywords: ["password", "passwd", "pwd"] },
  { category: "secret", keywords: ["token", "secret", "apikey", "api_key", "credential", "session", "jwt", "auth"] },
  { category: "payment", keywords: ["card", "pan", "cvv", "cvc", "iban", "expiry"] },
  { category: "email", keywords: ["email", "e_mail", "mail"] },
  { category: "phone", keywords: ["phone", "mobile", "tel", "msisdn"] },
  { category: "government_id", keywords: ["ssn", "passport", "tax_id", "national_id"] },
  { category: "birth", keywords: ["birth", "dob", "age"] },
  { category: "name", keywords: ["first_name", "last_name", "full_name", "surname", "customer_name", "display_name"] },
  { category: "address", keywords: ["street", "zip", "postal", "street_address", "postal_address", "home_address", "billing_address", "shipping_address", "mailing_address"] },
  { category: "geo", keywords: ["city", "country", "region", "location", "lat", "lon", "lng"] },
  { category: "ip", keywords: ["ip", "ip_address", "client_ip", "remote_addr"] },
  { category: "device", keywords: ["device", "user_agent", "imei", "fingerprint"] },
];

/** Maps field names to a deduplicated, comma-joined category list. */
export function classifyPII(fields: readonly string[]): string {
  const seen = new Map<string, boolean>();
  for (const field of fields) {
    const n = String(field).toLowerCase().replace(/[-\s.]/g, "_");
    const tokens = new Set(n.split("_"));
    for (const cat of PII_CATEGORIES) {
      if (seen.get(cat.category)) continue;
      for (const kw of cat.keywords) {
        const hit = kw.includes("_") ? n.includes(kw) : tokens.has(kw);
        if (hit) {
          seen.set(cat.category, true);
          break;
        }
      }
    }
  }
  return [...seen.keys()].sort().join(",");
}
