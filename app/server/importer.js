import fs from 'node:fs';
import { parseCsv } from './csv.js';
import { validateRow } from './validate.js';
import {
  existingFileFor, confPath, renderDomain, mergeDomain, writeHostFile, normPath,
} from './nginxHost.js';
import { loadManifest, saveManifest, safeKey } from './manifest.js';
import { commitAll } from './gitStore.js';

function routeSummary(routes) {
  return `${routes.length} route(s): ${routes.map((r) => normPath(r.path)).join(', ')}`;
}
function recordDomain(m, domain, routes) {
  if (!safeKey(domain)) return;
  m[domain] = {
    routes: routes.map((r) => ({
      path: normPath(r.path),
      primary: `${r.address}:${r.port}`,
      alt: r.altAddress ? `${r.altAddress}:${r.altPort}` : '',
    })),
    updatedAt: new Date().toISOString(),
  };
}

// Plan/apply a CSV import. Rows are grouped by domain into one file per domain. apply=false = dry run.
export function importCsv(csvText, apply) {
  const rows = parseCsv(csvText);
  const plan = [];
  const errors = [];
  const byDomain = new Map();

  for (const row of rows) {
    const v = validateRow(row);
    if (!v.ok) {
      plan.push({ domain: v.name || '(blank)', status: 'invalid', detail: v.reason });
      errors.push({ row, reason: v.reason });
      continue;
    }
    const { domain } = v.value;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(v.value);
  }

  const manifest = apply ? loadManifest() : null;
  for (const [domain, routes] of byDomain) {
    const file = existingFileFor(domain);
    if (!file) {
      plan.push({ domain, status: 'create', detail: routeSummary(routes) });
      if (apply) { writeHostFile(confPath(domain), renderDomain({ domain, routes })); recordDomain(manifest, domain, routes); }
      continue;
    }
    const merged = mergeDomain(fs.readFileSync(file, 'utf8'), { domain, routes });
    if (merged.manual) {
      plan.push({ domain, status: 'skip-manual', detail: 'no managed markers — hand-authored' });
    } else if (merged.changed) {
      plan.push({ domain, status: 'update', detail: routeSummary(routes) });
      if (apply) { writeHostFile(file, merged.content); recordDomain(manifest, domain, routes); }
    } else {
      plan.push({ domain, status: 'unchanged', detail: routeSummary(routes) });
    }
  }

  const summary = tally(plan);
  if (apply) {
    saveManifest(manifest);
    commitAll(`import: ${summary.create} created, ${summary.update} updated, ${summary['skip-manual']} manual-skipped, ${summary.unchanged} unchanged`);
  }
  return { applied: !!apply, summary, plan, errors };
}

function tally(plan) {
  const t = { create: 0, update: 0, unchanged: 0, 'skip-manual': 0, invalid: 0 };
  for (const p of plan) t[p.status] = (t[p.status] || 0) + 1;
  return t;
}
