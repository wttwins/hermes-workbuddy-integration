import fs from 'node:fs';
import path from 'node:path';

try {
  const cfg = JSON.parse(fs.readFileSync(path.join(process.env.WB_CONFIG_DIR || '/data', 'config.json'), 'utf8'));
  let host = cfg.host || '0.0.0.0';
  if (host === '0.0.0.0') host = '127.0.0.1';
  else if (host === '::') host = '::1';
  if (host.includes(':') && !host.startsWith('[')) host = '[' + host + ']';
  const response = await fetch(`http://${host}:${cfg.port}/health`, { signal: AbortSignal.timeout(4000) });
  if (response.status !== 200) process.exitCode = 1;
} catch { process.exitCode = 1; }
