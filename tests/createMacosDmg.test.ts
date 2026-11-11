import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function createDmg(failures: number, detachFails = false, forceFails = false) {
  const tempDir = mkdtempSync(join(tmpdir(), 'dmg-retry-'));
  const script = [
    'set -euo pipefail',
    'cd "$TEST_DIR"',
    'mkdir staging',
    'calls=0',
    'hdiutil() {',
    '  printf "%s\n" "$*" >> calls.log',
    '  case "$1" in',
    '    create)',
    '      calls=$((calls + 1))',
    '      touch "$output_dmg"',
    '      if [ "$calls" -le "$FAILURES" ]; then return 16; fi',
    '      ;;',
    '    info)',
    '      image_path="$output_dmg"',
    '      if command -v cygpath >/dev/null; then image_path="$(cygpath -m "$output_dmg")"; fi',
    '      printf \'<plist version="1.0"><dict><key>images</key><array><dict><key>image-path</key><string>%s</string><key>system-entities</key><array><dict><key>mount-point</key><string>/Volumes/EasyCLIProxyAPI</string><key>dev-entry</key><string>/dev/disk-test</string></dict></array></dict><dict><key>image-path</key><string>/unrelated.dmg</string><key>system-entities</key><array><dict><key>mount-point</key><string>/Volumes/Other</string><key>dev-entry</key><string>/dev/disk-other</string></dict></array></dict></array></dict></plist>\' "$image_path"',
    '      ;;',
    '    detach)',
    '      if [ "$2" = "-force" ]; then',
    '        if [ "$FORCE_FAILS" = true ]; then return 17; fi',
    '      elif [ "$DETACH_FAILS" = true ]; then return 17; fi',
    '      ;;',
    '  esac',
    '}',
    'sleep() { printf "sleep %s\n" "$1" >> calls.log; }',
    process.platform === 'win32'
      ? 'python3() { python -c "$2" "$(cygpath -m "$3")" | tr -d "\r"; }' : '',
    'set -- staging output.dmg',
    'source "$DMG_SCRIPT"',
  ].join('\n');
  try {
    const result = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env, TEST_DIR: tempDir.replaceAll('\\', '/'),
        DMG_SCRIPT: join(process.cwd(), 'scripts/create-macos-dmg.sh').replaceAll('\\', '/'),
        FAILURES: String(failures), DETACH_FAILS: String(detachFails), FORCE_FAILS: String(forceFails),
      },
    });
    if (result.error) throw result.error;
    if (!existsSync(join(tempDir, 'calls.log'))) throw new Error(result.stderr || result.stdout);
    return {
      ...result,
      calls: readFileSync(join(tempDir, 'calls.log'), 'utf8').trim().split(/\r?\n/),
      outputExists: existsSync(join(tempDir, 'output.dmg')),
      indexingDisabled: existsSync(join(tempDir, 'staging/.metadata_never_index')),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test('creates a DMG without cleanup or delay on first success', () => {
  const result = createDmg(0);
  expect(result.status).toBe(0);
  expect(result.calls).toHaveLength(1);
  expect(result.outputExists).toBe(true);
  expect(result.indexingDisabled).toBe(true);
});

test('retries busy images and detaches only the matching output volume', () => {
  const result = createDmg(2, true);
  expect(result.stderr).not.toContain('::error::');
  expect(result.status).toBe(0);
  expect(result.calls.filter(call => call.startsWith('create '))).toHaveLength(3);
  expect(result.calls.filter(call => call.startsWith('detach '))).toEqual([
    'detach /dev/disk-test', 'detach -force /dev/disk-test',
    'detach /dev/disk-test', 'detach -force /dev/disk-test',
  ]);
  expect(result.calls.filter(call => call.startsWith('sleep '))).toEqual(['sleep 2', 'sleep 4']);
  expect(result.outputExists).toBe(true);
});

test('stops after six failures, removes the partial image and preserves exit status', () => {
  const result = createDmg(6);
  expect(result.status).toBe(16);
  expect(result.stderr).toContain('DMG creation failed after 6 attempts');
  expect(result.calls.filter(call => call.startsWith('create '))).toHaveLength(6);
  expect(result.calls.filter(call => call.startsWith('sleep '))).toHaveLength(5);
  expect(result.outputExists).toBe(false);
});

test('stops safely when the failed output volume cannot be detached', () => {
  const result = createDmg(1, true, true);
  expect(result.status).toBe(16);
  expect(result.stderr).toContain('Could not clean up the failed DMG');
  expect(result.calls.filter(call => call.startsWith('create '))).toHaveLength(1);
  expect(result.calls.filter(call => call.startsWith('sleep '))).toHaveLength(0);
  expect(result.outputExists).toBe(true);
});
