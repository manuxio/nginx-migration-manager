import fs from 'node:fs';
import { parseCsv } from './csv.js';
import { validateRow } from './validate.js';
import {
  existingFileFor, confPath, renderHost, mergeHost, writeHostFile,
} from './nginxHost.js';
import { loadManifest, saveManifest, recordHost } from './manifest.js';
import { commitAll } from './gitStore.js';

function detail({ address, port, altAddress, altPort }) {
  const primary = `${address}:${port}`;
  return altAddress ? `${primary}  (alt ${altAddress}:${altPort})` : primary;
}

// Plan/apply a CSV import. apply=false -> dry run (no writes).
// Returns { applied, summary, plan, errors }.
export function importCsv(csvText, apply) {
  const rows = parseCsv(csvText);
  const plan = [];
  const errors = [];
  const manifest = apply ? loadManifest() : null;

  for (const row of rows) {
    const v = validateRow(row);
    if (!v.ok) {
      plan.push({ domain: v.domain || row.domain || '(blank)', status: 'invalid', detail: v.reason });
      errors.push({ row, reason: v.reason });
      continue;
    }
    const { domain } = v.value;
    const file = existingFileFor(domain);

    if (!file) {
      plan.push({ domain, status: 'create', detail: detail(v.value) });
      if (apply) {
        writeHostFile(confPath(domain), renderHost(v.value));
        recordHost(manifest, v.value, 'csv');
      }
      continue;
    }

    const existing = fs.readFileSync(file, 'utf8');
    const merged = mergeHost(existing, v.value);

    if (merged.manual) {
      plan.push({ domain, status: 'skip-manual', detail: 'no managed markers — hand-authored' });
    } else if (merged.changed) {
      plan.push({ domain, status: 'update', detail: detail(v.value) });
      if (apply) {
        writeHostFile(file, merged.content);
        recordHost(manifest, v.value, 'csv');
      }
    } else {
      plan.push({ domain, status: 'unchanged', detail: detail(v.value) });
    }
  }

  const summary = tally(plan);

  if (apply) {
    saveManifest(manifest);
    const msg =
      `import: ${summary.create} created, ${summary.update} updated, ` +
      `${summary['skip-manual']} manual-skipped, ${summary.unchanged} unchanged`;
    commitAll(msg);
  }

  return { applied: !!apply, summary, plan, errors };
}

function tally(plan) {
  const t = { create: 0, update: 0, unchanged: 0, 'skip-manual': 0, invalid: 0 };
  for (const p of plan) t[p.status] = (t[p.status] || 0) + 1;
  return t;
}
