import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Known install locations for Google Antigravity CLI (`agy`).
 * On Windows, agy installs to `%LOCALAPPDATA%\agy\bin\agy.exe`.
 * On POSIX, typically `~/.local/bin/agy` or `~/.agy/bin/agy`.
 */
export function agyInstallCandidates(
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      join(localAppData, 'agy', 'bin', 'agy.exe'),
      join(home, '.local', 'bin', 'agy.exe'),
    ];
  }
  return [
    join(home, '.local', 'bin', 'agy'),
    join(home, '.agy', 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/usr/bin/agy',
  ];
}

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function onSearchPath(
  bin: string,
  searchPath: string,
  platform: NodeJS.Platform,
): boolean {
  const suffixes = platform === 'win32' ? ['.exe', '.com'] : [''];
  const names = suffixes.map((suffix) => (suffix ? `${bin}${suffix}` : bin));
  const sep = platform === 'win32' ? ';' : ':';
  return searchPath.split(sep).some((dir) => dir && names.some((name) => isExecutable(join(dir, name))));
}

/**
 * Resolve the Antigravity CLI binary to spawn:
 * 1. Explicit override passed to runner constructor (`optsBin`)
 * 2. `CEZ_AGY_BIN` environment variable
 * 3. `agy` on PATH
 * 4. Known install candidate directories
 * 5. Fallback `'agy'`
 */
export function resolveAgyBin(
  optsBin?: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  candidates: string[] = agyInstallCandidates(home, platform, env),
): string {
  if (optsBin) return optsBin;
  if (env.CEZ_AGY_BIN) return env.CEZ_AGY_BIN;
  if (onSearchPath('agy', env.PATH ?? '', platform)) return 'agy';
  return candidates.find(isExecutable) ?? 'agy';
}
