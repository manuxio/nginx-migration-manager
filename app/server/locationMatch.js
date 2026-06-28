// Replicates nginx's `location` selection for a given request URI, run against the actual
// directives in a host's .conf (so it honours hand-added blocks and every modifier, not just
// the managed routes). Used by POST /api/host/match to answer "which definition wins for X?".
//
// nginx algorithm (http core):
//   1. an exact `= /uri` that equals the URI wins immediately.
//   2. otherwise remember the LONGEST matching prefix location.
//   3. if that longest prefix is `^~`, use it and skip regexes.
//   4. else test regex locations (`~` / `~*`) in FILE ORDER; the first that matches wins.
//   5. if no regex matches, fall back to the longest prefix from step 2.

const normPath = (p) => { const v = String(p || '').trim(); return v === '' ? '/' : v; };

// "= /x" | "^~ /x" | "~ ^/x" | "~* ^/x" | "/x" -> { modifier, value }
function classifySpec(spec) {
  if (/^=\s*/.test(spec)) return { modifier: 'exact', value: spec.replace(/^=\s*/, '') };
  if (/^\^~\s*/.test(spec)) return { modifier: 'prefixPriority', value: spec.replace(/^\^~\s*/, '') };
  if (/^~\*\s*/.test(spec)) return { modifier: 'iregex', value: spec.replace(/^~\*\s*/, '') };
  if (/^~\s*/.test(spec)) return { modifier: 'regex', value: spec.replace(/^~\s*/, '') };
  return { modifier: 'prefix', value: spec };
}

// Every server-level `location` in file order, tagged with the managed route it belongs to
// (nearest preceding "# managed:route") and the upstream its proxy_pass points at.
export function serverLocations(content) {
  const lines = content.split('\n');
  const entries = [];
  let pendingRoute = null;
  for (let i = 0; i < lines.length; i++) {
    const rm = lines[i].match(/#\s*managed:route\b[ \t]*(.*)$/);
    if (rm) { pendingRoute = normPath((rm[1] || '').trim() || '/'); continue; }
    const lm = lines[i].match(/^\s*location\s+(.*?)\s*\{/);
    if (!lm) continue;
    const spec = lm[1].trim();
    const cls = classifySpec(spec);
    // walk the block to its matching close brace, grabbing the first proxy_pass target
    let depth = 0; let upstream = null;
    for (let k = i; k < lines.length; k++) {
      const pm = lines[k].match(/proxy_pass\s+https?:\/\/([^;\s/]+)/i);
      if (pm && !upstream) upstream = pm[1];
      for (const ch of lines[k]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
      if (depth <= 0 && k >= i) break;
    }
    entries.push({ ...cls, spec, directive: `location ${spec}`, routePath: pendingRoute, upstream, order: entries.length });
    pendingRoute = null;
  }
  return entries;
}

// Does one location individually match the URI (ignoring precedence)?
function individualMatch(e, uri) {
  if (e.modifier === 'exact') return e.value === uri;
  if (e.modifier === 'prefix' || e.modifier === 'prefixPriority') return uri.startsWith(e.value);
  try { return new RegExp(e.value, e.modifier === 'iregex' ? 'i' : '').test(uri); }
  catch { return false; }
}

// Full result for a URI against a file's locations.
export function matchPath(content, rawPath) {
  let uri = String(rawPath || '').split('#')[0].split('?')[0].trim();
  if (!uri) uri = '/';
  if (!uri.startsWith('/')) uri = `/${uri}`;

  const entries = serverLocations(content);

  let winner = null; let reason = 'none';
  const exact = entries.find((e) => e.modifier === 'exact' && e.value === uri);
  if (exact) { winner = exact; reason = 'exact'; }
  else {
    let best = null;
    for (const e of entries) {
      if ((e.modifier === 'prefix' || e.modifier === 'prefixPriority') && uri.startsWith(e.value)
        && (!best || e.value.length > best.value.length)) best = e;
    }
    if (best && best.modifier === 'prefixPriority') { winner = best; reason = 'prefixPriority'; }
    else {
      for (const e of entries) {
        if ((e.modifier === 'regex' || e.modifier === 'iregex') && individualMatch(e, uri)) {
          winner = e; reason = e.modifier; break;
        }
      }
      if (!winner && best) { winner = best; reason = 'prefix'; }
    }
  }

  const candidates = entries.map((e) => ({
    modifier: e.modifier,
    directive: e.directive,
    value: e.value,
    routePath: e.routePath,
    upstream: e.upstream,
    matches: individualMatch(e, uri),
    winner: !!winner && e.order === winner.order,
  }));

  return {
    uri,
    reason,
    matched: winner
      ? { modifier: winner.modifier, directive: winner.directive, routePath: winner.routePath, upstream: winner.upstream }
      : null,
    candidates,
  };
}
