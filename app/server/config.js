import path from 'node:path';

export const SITES_DIR = process.env.SITES_DIR || '/etc/nginx/sites';
export const DATA_DIR = process.env.DATA_DIR || '/data';
export const PORT = Number(process.env.PORT || 3000);

export const MANIFEST_PATH = path.join(DATA_DIR, 'manifest.json');

export const AUTH_USER = process.env.BASIC_AUTH_USER || '';
export const AUTH_PASS = process.env.BASIC_AUTH_PASS || '';

// status / request files exchanged with the nginx container's watcher
export const RELOAD_OK = path.join(SITES_DIR, '.reload-ok');
export const RELOAD_MSG = path.join(SITES_DIR, '.reload-msg');
export const RELOAD_REQUEST = path.join(SITES_DIR, '.reload-request');
export const TEST_OK = path.join(SITES_DIR, '.test-ok');
export const TEST_MSG = path.join(SITES_DIR, '.test-msg');
export const TEST_REQUEST = path.join(SITES_DIR, '.test-request');
