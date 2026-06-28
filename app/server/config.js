import path from 'node:path';

export const SITES_DIR = process.env.SITES_DIR || '/etc/nginx/sites';
export const DATA_DIR = process.env.DATA_DIR || '/data';
export const PORT = Number(process.env.PORT || 3000);

export const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');
// Short hash of the commit nginx is currently serving (recorded on each successful reload).
export const SERVED_FILE = path.join(DATA_DIR, 'served-commit');

export const AUTH_USER = process.env.BASIC_AUTH_USER || '';
export const AUTH_PASS = process.env.BASIC_AUTH_PASS || '';
// This API writes nginx config, so it must fail CLOSED: without both a user AND pass it
// refuses to serve (503) rather than silently running open. To deliberately run without
// auth (e.g. behind your own authenticating gateway), set AUTH_DISABLED=1.
export const AUTH_CONFIGURED = AUTH_USER !== '' && AUTH_PASS !== '';
export const AUTH_DISABLED = ['1', 'true', 'yes', 'on'].includes(String(process.env.AUTH_DISABLED || '').toLowerCase());

// nginx stub_status (listens on 0.0.0.0:8080, never published). Reach it on the right host
// for the topology: same-pod loopback in k8s (kubelet always sets KUBERNETES_SERVICE_HOST),
// the "nginx" service name in docker-compose. Set NGINX_STATUS_URL to override explicitly.
const STATUS_HOST = process.env.KUBERNETES_SERVICE_HOST ? '127.0.0.1' : 'nginx';
export const STATUS_URL = process.env.NGINX_STATUS_URL || `http://${STATUS_HOST}:8080/stub_status`;

// In-GUI raw file editor over the nginx config dir. Powerful + dangerous (arbitrary writes
// under CONFIG_ROOT) — ON by default, disable with FILE_EDITOR=0 (or false/no/off).
export const CONFIG_ROOT = path.resolve(process.env.CONFIG_ROOT || path.dirname(SITES_DIR));
export const EDITOR_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.FILE_EDITOR || '').toLowerCase());

// status / request files exchanged with the nginx container's watcher
export const RELOAD_OK = path.join(SITES_DIR, '.reload-ok');
export const RELOAD_MSG = path.join(SITES_DIR, '.reload-msg');
export const RELOAD_REQUEST = path.join(SITES_DIR, '.reload-request');
export const TEST_OK = path.join(SITES_DIR, '.test-ok');
export const TEST_MSG = path.join(SITES_DIR, '.test-msg');
export const TEST_REQUEST = path.join(SITES_DIR, '.test-request');
export const PENDING = path.join(SITES_DIR, '.pending');
