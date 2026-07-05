// Dependency license allowlist gate. Fails CI if any production dependency
// carries a license outside ALLOWED. Extend the list via PR — additions are
// a reviewable decision, not a local override.
import { execFileSync } from "node:child_process";

const ALLOWED = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Unlicense",
]);

let raw;
try {
  raw = execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], {
    encoding: "utf8",
  });
} catch (err) {
  // pnpm exits non-zero when there are no dependencies at all; treat a clean
  // "no packages" report as a pass, anything else as a real failure.
  const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  if (/No (licenses|packages)/i.test(out)) {
    console.log("license-check: no production dependencies yet — pass");
    process.exit(0);
  }
  console.error("license-check: failed to run `pnpm licenses list`");
  console.error(out);
  process.exit(1);
}

if (!raw.trim() || /No (licenses|packages)/i.test(raw)) {
  console.log("license-check: no production dependencies yet — pass");
  process.exit(0);
}

const report = JSON.parse(raw);
const violations = [];
for (const [license, pkgs] of Object.entries(report)) {
  if (ALLOWED.has(license)) continue;
  for (const pkg of pkgs) {
    violations.push(`${pkg.name}@${(pkg.versions ?? []).join(",")} — ${license}`);
  }
}

if (violations.length > 0) {
  console.error("license-check: disallowed licenses found:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("license-check: all production dependency licenses allowed — pass");
