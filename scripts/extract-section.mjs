import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const store = process.argv[2];
const themeId = process.argv[3];
const sectionHint = process.argv[4] ?? "";

if (!store || !themeId) {
  console.error("Usage: node scripts/extract-section.mjs <store-slug> <theme-id> [section-hint]");
  process.exit(1);
}

const indexPath = resolve("themes", store, themeId, "templates/index.json");

if (!existsSync(indexPath)) {
  console.error(`Missing file: ${indexPath}`);
  console.error("Run scripts/pull-theme.ps1 first.");
  process.exit(1);
}

const template = JSON.parse(readFileSync(indexPath, "utf8"));
const sections = template.sections ?? {};
const order = template.order ?? Object.keys(sections);

console.log(`File: ${indexPath}\n`);
console.log("Homepage sections (in order):\n");

for (const id of order) {
  const section = sections[id];
  if (!section) continue;

  const marker = sectionHint && id.includes(sectionHint) ? " <-- customizer hint" : "";
  console.log(`- ${id} (type: ${section.type})${marker}`);
}

if (sectionHint) {
  const match = Object.entries(sections).find(([id]) => id.includes(sectionHint));

  if (match) {
    const [id, section] = match;
    console.log("\nMatched section JSON:\n");
    console.log(JSON.stringify({ id, ...section }, null, 2));
  } else {
    console.log(`\nNo section matched hint: ${sectionHint}`);
  }
}
