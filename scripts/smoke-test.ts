// Smoke test — verifies the package structure loads without the pi runtime.
// Note: the extension entry is not yet implemented; this only checks that the
// skill manifest and package metadata are present and parseable.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
let failures = 0;

function check(label, cond, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[${tag}] ${label}${detail ? ` — ${detail}` : ""}`);
}

// package.json is valid JSON with required fields
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
check("package.json parses", !!pkg);
check("package.json has name", pkg.name === "pi-scold-reminder");
check("package.json has pi manifest", !!pkg.pi?.extensions && !!pkg.pi?.skills);
check("package.json has pi keywords", (pkg.keywords || []).includes("pi-package"));
check("package.json has repository url", !!pkg.repository?.url);

// SKILL.md present
check("skills/scold-reminder/SKILL.md exists", existsSync(join(root, "skills/scold-reminder/SKILL.md")));

// LICENSE present
check("LICENSE exists", existsSync(join(root, "LICENSE")));

// docs present
check("docs/plan.md exists", existsSync(join(root, "docs/plan.md")), "primary implementation plan");
check("docs/intention.md exists", existsSync(join(root, "docs/intention.md")));

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
