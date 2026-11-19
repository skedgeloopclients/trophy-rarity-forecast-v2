// Entry point for the trophy-rarity forecast runner. It leans only on Node 22
// standard modules and makes no network calls: discover input cases, forecast
// each one, and emit a sibling output file with the results.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forecast, type Case } from './lib/model.ts';

// Honour the harness overrides when present, else use the standard container paths.
const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Make sure the destination exists, then process the .in files in stable order.
mkdirSync(outputDir, { recursive: true });
const cases = readdirSync(inputDir).filter((name) => name.endsWith('.in')).sort();
for (const file of cases) {
  const caseId = file.slice(0, -'.in'.length);
  const payload = JSON.parse(readFileSync(join(inputDir, file), 'utf8')) as Case;
  const trophies = forecast(payload);
  const output = `${JSON.stringify({ trophies })}\n`;
  writeFileSync(join(outputDir, `${caseId}.out`), output);
}
process.stdout.write(`trophy forecast: ${cases.length} case(s) handled\n`);
