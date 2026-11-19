// Runner for the trophy-rarity forecast. It uses only Node 22 built-ins, makes
// no network requests, and follows a simple contract: read every .in case from
// the input folder, forecast it, and drop a matching .out file in the output
// folder.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forecast, type Case } from './lib/model.ts';

// Pick up the harness-supplied directories, falling back to the container norms.
const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Create the destination if needed, then walk the case files in sorted order so
// results are deterministic no matter how the filesystem lists entries.
mkdirSync(outputDir, { recursive: true });
const files = readdirSync(inputDir).filter((name) => name.endsWith('.in')).sort();

for (const file of files) {
  const caseId = file.slice(0, -'.in'.length);
  const payload = JSON.parse(readFileSync(join(inputDir, file), 'utf8')) as Case;
  const trophies = forecast(payload);
  const text = `${JSON.stringify({ trophies })}\n`;
  writeFileSync(join(outputDir, `${caseId}.out`), text);
}

// Emit one terse status line so the harness log confirms how many cases ran.
process.stdout.write(`trophy forecast: ${files.length} case(s) handled\n`);
