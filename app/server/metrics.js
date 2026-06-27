// Scrapes nginx's loopback stub_status (app-only) on a timer and keeps a short rolling
// window so the API can answer "requests served in the last ~60s" + live connection counts.
// stub_status gives totals only (no per-status breakdown) — errored counts would need VTS.
import http from 'node:http';
import { STATUS_URL } from './config.js';

const WINDOW_MS = 60_000;
const KEEP_MS = 75_000;            // retain a little more than the window
const samples = [];                // ascending by time: { t, requests, active, reading, writing, waiting }
let lastOk = false;

function parse(text) {
  const active = /Active connections:\s+(\d+)/.exec(text);
  const nums = /\n\s*(\d+)\s+(\d+)\s+(\d+)/.exec(text);             // accepts handled requests
  const rww = /Reading:\s+(\d+)\s+Writing:\s+(\d+)\s+Waiting:\s+(\d+)/.exec(text);
  if (!active || !nums) return null;
  return {
    active: +active[1],
    accepts: +nums[1], handled: +nums[2], requests: +nums[3],
    reading: rww ? +rww[1] : 0, writing: rww ? +rww[2] : 0, waiting: rww ? +rww[3] : 0,
  };
}

function scrape() {
  return new Promise((resolve) => {
    const req = http.get(STATUS_URL, { timeout: 2000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(parse(body)));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function tick() {
  const s = await scrape();
  if (!s) { lastOk = false; return; }
  lastOk = true;
  samples.push({ t: Date.now(), ...s });
  const cutoff = Date.now() - KEEP_MS;
  while (samples.length && samples[0].t < cutoff) samples.shift();
}

export function startMetrics(intervalMs = 5000) {
  tick();
  const h = setInterval(tick, intervalMs);
  if (h.unref) h.unref();
}

export function metricsSnapshot() {
  const latest = samples[samples.length - 1];
  if (!latest) return { ok: lastOk, active: null, requestsWindow: null, windowSec: 0, perSec: 0 };
  // reference = the most recent sample that is at least WINDOW_MS old (else the oldest we have)
  const targetT = latest.t - WINDOW_MS;
  let ref = samples[0];
  for (const s of samples) { if (s.t <= targetT) ref = s; else break; }
  const windowSec = Math.max(0, (latest.t - ref.t) / 1000);
  const requestsWindow = latest.requests - ref.requests;
  return {
    ok: lastOk,
    active: latest.active,
    reading: latest.reading, writing: latest.writing, waiting: latest.waiting,
    requestsWindow,                                   // requests served over the window below
    windowSec: Math.round(windowSec),                 // ~60 once warmed up; smaller right after boot
    perSec: windowSec > 0 ? +(requestsWindow / windowSec).toFixed(1) : 0,
    totalRequests: latest.requests,
  };
}
