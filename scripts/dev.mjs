#!/usr/bin/env node
/**
 * One-command local development: `pnpm dev`.
 *
 * 1. Creates .env from .env.example if it is missing, and loads it.
 * 2. Starts Postgres (with pgvector) and the Temporal dev server:
 *    - with Docker Compose when Docker is running, or
 *    - from local binaries (Homebrew postgresql@18 + temporal CLI) under ./.data otherwise.
 * 3. Waits for both, runs database migrations.
 * 4. Starts web, worker, egress and dashboard with prefixed, live output.
 * Ctrl+C stops the apps and the local services this script started.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, '.data');
const say = (msg) => console.log(`\x1b[1m[dev]\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[1m[dev] ERROR:\x1b[0m ${msg}`);
  process.exit(1);
};

// 1. Environment
const envPath = path.join(root, '.env');
if (!existsSync(envPath)) {
  copyFileSync(path.join(root, '.env.example'), envPath);
  say('created .env from .env.example');
}
// Generate a local session secret once, so nobody has to invent one.
if (!/^SESSION_SECRET=.{32,}$/m.test(readFileSync(envPath, 'utf8'))) {
  const secret = randomBytes(32).toString('base64url');
  const content = readFileSync(envPath, 'utf8');
  writeFileSync(
    envPath,
    /^SESSION_SECRET=.*$/m.test(content)
      ? content.replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${secret}`)
      : `${content.trimEnd()}\nSESSION_SECRET=${secret}\nAUTH_DEV_LOGIN=true\n`,
  );
  say('generated SESSION_SECRET in .env');
}
// Same for the key that encrypts stored refresh tokens.
if (!/^TOKEN_ENCRYPTION_KEY=.{40,}$/m.test(readFileSync(envPath, 'utf8'))) {
  const key = randomBytes(32).toString('base64');
  const content = readFileSync(envPath, 'utf8');
  writeFileSync(
    envPath,
    /^TOKEN_ENCRYPTION_KEY=.*$/m.test(content)
      ? content.replace(/^TOKEN_ENCRYPTION_KEY=.*$/m, `TOKEN_ENCRYPTION_KEY=${key}`)
      : `${content.trimEnd()}\nTOKEN_ENCRYPTION_KEY=${key}\n`,
  );
  say('generated TOKEN_ENCRYPTION_KEY in .env');
}
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
}
process.env.LC_ALL ??= 'en_US.UTF-8';
process.env.LANG ??= 'en_US.UTF-8';

const has = (cmd, args = ['--version']) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

function waitForPort(port, label, timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs)
          reject(new Error(`${label} did not open port ${port} within ${timeoutMs / 1000}s`));
        else setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

const cleanups = [];

// 2. Services
const dockerRunning = has('docker', ['info']);
if (dockerRunning) {
  say('starting Postgres and Temporal with Docker Compose');
  if (run('docker', ['compose', 'up', '-d', '--wait']).status !== 0)
    fail('docker compose up failed');
} else {
  const pgBin = '/opt/homebrew/opt/postgresql@18/bin';
  if (!existsSync(path.join(pgBin, 'pg_ctl'))) {
    fail(
      'Docker is not running and Postgres 18 is not installed. Install Docker, or run: brew install postgresql@18 pgvector temporal',
    );
  }
  if (!has('temporal'))
    fail('Temporal CLI not found. Install Docker, or run: brew install temporal');
  mkdirSync(dataDir, { recursive: true });

  const pgData = path.join(dataDir, 'postgres');
  const pgOpts = { env: process.env };
  if (!existsSync(pgData)) {
    say('initializing local Postgres in .data/postgres');
    run(`${pgBin}/initdb`, ['-D', pgData, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], {
      ...pgOpts,
      stdio: 'ignore',
    });
  }
  const pgRunning =
    spawnSync(`${pgBin}/pg_ctl`, ['-D', pgData, 'status'], { stdio: 'ignore' }).status === 0;
  if (!pgRunning) {
    say('starting local Postgres on :5432');
    const res = run(
      `${pgBin}/pg_ctl`,
      [
        '-D',
        pgData,
        '-l',
        path.join(dataDir, 'postgres.log'),
        '-o',
        '-p 5432 -k /tmp',
        '-w',
        'start',
      ],
      { ...pgOpts, stdio: 'ignore' },
    );
    if (res.status !== 0) fail('Postgres failed to start; see .data/postgres.log');
    cleanups.push(() =>
      spawnSync(`${pgBin}/pg_ctl`, ['-D', pgData, 'stop', '-m', 'fast'], { stdio: 'ignore' }),
    );
  }
  for (const db of ['ai_workforce', 'ai_workforce_test']) {
    spawnSync(`${pgBin}/createdb`, ['-h', 'localhost', '-U', 'postgres', db], { stdio: 'ignore' });
    spawnSync(
      `${pgBin}/psql`,
      [
        '-h',
        'localhost',
        '-U',
        'postgres',
        '-d',
        db,
        '-qc',
        'create extension if not exists vector',
      ],
      { stdio: 'ignore' },
    );
  }

  const temporalUp = await waitForPort(7233, 'Temporal', 300).then(
    () => true,
    () => false,
  );
  if (!temporalUp) {
    say(
      'starting Temporal dev server on :7233 (UI http://localhost:8233); log in .data/temporal.log',
    );
    const log = openSync(path.join(dataDir, 'temporal.log'), 'a');
    const temporal = spawn(
      'temporal',
      [
        'server',
        'start-dev',
        '--ip',
        '127.0.0.1',
        '--db-filename',
        path.join(dataDir, 'temporal.db'),
        '--log-level',
        'warn',
      ],
      {
        stdio: ['ignore', log, log],
      },
    );
    cleanups.push(() => temporal.kill('SIGTERM'));
  }
}

try {
  await waitForPort(5432, 'Postgres');
  await waitForPort(7233, 'Temporal');
} catch (err) {
  fail(err.message);
}

// 3. Migrations
say('running database migrations');
if (run('pnpm', ['db:migrate'], { env: process.env }).status !== 0)
  fail('migrations failed (see the log above)');

// 4. Apps
say('starting web :4000, worker, egress :4100, dashboard http://localhost:3000');
const apps = spawn('pnpm', ['dev:apps'], { stdio: 'inherit', cwd: root, env: process.env });

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  say('stopping');
  apps.kill('SIGINT');
  setTimeout(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
    process.exit(code);
  }, 1500);
};
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
apps.on('exit', (code) => stop(code ?? 0));
