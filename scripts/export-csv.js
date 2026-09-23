import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINKEDIN_LOOKUPS, LOCALES, UI_TEXT } from '../src/utils/linkedinPhrases.ts';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(rootDir, 'linkedinPhrases.csv');

function escapeCsvField(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function toCsvRow(cells) {
  return cells.map(escapeCsvField).join(',');
}

function localeCells(valuesByLocale) {
  return LOCALES.map((locale) => valuesByLocale[locale] ?? '');
}

const rows = [toCsvRow(['section', 'id', 'match', ...LOCALES])];

for (const [id, lookup] of Object.entries(LINKEDIN_LOOKUPS)) {
  const length = Math.max(0, ...LOCALES.map((locale) => lookup.phrases[locale]?.length ?? 0));
  const rowCount = Math.max(length, 1);
  for (let index = 0; index < rowCount; index += 1) {
    const values = {};
    for (const locale of LOCALES) {
      values[locale] = lookup.phrases[locale]?.[index] ?? '';
    }
    rows.push(toCsvRow(['lookup', id, lookup.match, ...localeCells(values)]));
  }
}

for (const [id, copy] of Object.entries(UI_TEXT)) {
  rows.push(toCsvRow(['ui', id, '', ...localeCells(copy)]));
}

writeFileSync(outPath, `\uFEFF${rows.join('\n')}\n`, 'utf8');
console.log(`Wrote ${rows.length - 1} phrase rows to ${outPath}`);
