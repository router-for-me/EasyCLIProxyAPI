import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import {
  generatePortableUpdateManifest,
  portableUpdateManifestName,
  portableUpdateManifestNames,
} from '../scripts/manifest.mjs';

test('macOS uses a new primary channel and keeps the legacy manifest alias', () => {
  expect(portableUpdateManifestName('windows')).toBe('portable-update-windows.json');
  expect(portableUpdateManifestName('linux')).toBe('portable-update-linux.json');
  expect(portableUpdateManifestName('darwin')).toBe('portable-update-darwin-v2.json');
  expect(portableUpdateManifestNames('darwin')).toEqual([
    'portable-update-darwin-v2.json',
    'portable-update-darwin.json',
  ]);
  expect(portableUpdateManifestNames('linux')).toEqual(['portable-update-linux.json']);
});

test('macOS manifest CLI publishes both update channels', async () => {
  const root = await mkdtemp(join(tmpdir(), 'easycli-darwin-manifest-cli-'));
  try {
    for (const arch of ['amd64', 'aarch64']) {
      await writeFile(
        join(root, `EasyCLIProxyAPI-v1.2.3-Darwin-${arch}.dmg`),
        `darwin ${arch} release`,
      );
    }
    const script = fileURLToPath(new URL('../scripts/manifest.mjs', import.meta.url));
    const notes = { 'zh-CN': '## 新增\n\n- 软件更新说明。\n', en: '## Added\n\n- Release notes.\n' };
    const notesPath = join(root, 'release-notes.json');
    await writeFile(notesPath, JSON.stringify(notes), 'utf8');
    const result = spawnSync('node', [
      script,
      '--directory',
      root,
      '--platform',
      'darwin',
      '--repository',
      'router-for-me/EasyCLIProxyAPI',
      '--tag',
      'v1.2.3',
      '--release-notes',
      notesPath,
    ], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const primary = JSON.parse(
      await readFile(join(root, 'portable-update-darwin-v2.json'), 'utf8'),
    );
    const legacy = JSON.parse(
      await readFile(join(root, 'portable-update-darwin.json'), 'utf8'),
    );
    expect(legacy).toEqual(primary);
    expect(primary.releaseNotes).toEqual(notes);
    expect(primary.releaseNotes.ja).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe('Windows 便携更新清单', () => {
  test('URL、大小和哈希与实际上传资产一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'easycli-manifest-test-'));
    try {
      const payloads = {
        amd64: Buffer.from('amd64 full portable package'),
        aarch64: Buffer.from('aarch64 full portable package'),
      };
      for (const [arch, contents] of Object.entries(payloads)) {
        await writeFile(
          join(root, `EasyCLIProxyAPI-v1.2.3-Windows-${arch}.zip`),
          contents,
        );
      }

      const output = join(root, 'portable-update-windows.json');
      const manifest = await generatePortableUpdateManifest({
        directory: root,
        output,
        repository: 'router-for-me/EasyCLIProxyAPI',
        gitcodeRepository: 'mirror-owner/EasyCLIProxyAPI',
        tag: 'v1.2.3',
        publishedAt: '2026-07-24T00:00:00.000Z',
      });
      const saved = JSON.parse(await readFile(output, 'utf8'));

      expect(saved).toEqual(manifest);
      for (const arch of ['amd64', 'aarch64'] as const) {
        const asset = manifest.assets[`windows-${arch}`];
        expect(asset.url).toBe(
          `https://github.com/router-for-me/EasyCLIProxyAPI/releases/download/v1.2.3/EasyCLIProxyAPI-v1.2.3-Windows-${arch}.zip`,
        );
        expect(asset.fallbackUrls).toEqual([
          `https://api.gitcode.com/api/v5/repos/mirror-owner/EasyCLIProxyAPI/releases/v1.2.3/attach_files/EasyCLIProxyAPI-v1.2.3-Windows-${arch}.zip/download`,
        ]);
        expect(asset.sizeBytes).toBe(payloads[arch].byteLength);
        expect(asset.sha256).toBe(createHash('sha256').update(payloads[arch]).digest('hex'));
      }
      expect(manifest.fullAssets).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('缺少任一架构资产时拒绝生成清单', async () => {
    const root = await mkdtemp(join(tmpdir(), 'easycli-manifest-missing-'));
    try {
      await writeFile(
        join(root, 'EasyCLIProxyAPI-v1.2.3-Windows-amd64.zip'),
        'amd64',
      );
      await expect(generatePortableUpdateManifest({
        directory: root,
        output: join(root, 'portable-update-windows.json'),
        repository: 'router-for-me/EasyCLIProxyAPI',
        tag: 'v1.2.3',
      })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});

describe('跨平台便携更新清单', () => {
  test.each([
    ['linux', 'Linux', 'tar.gz'],
    ['darwin', 'Darwin', 'dmg'],
  ] as const)('%s 清单直接引用完整发布包', async (platform, display, suffix) => {
    const root = await mkdtemp(join(tmpdir(), `easycli-${platform}-manifest-test-`));
    try {
      for (const arch of ['amd64', 'aarch64']) {
        await writeFile(
          join(root, `EasyCLIProxyAPI-v1.2.3-${display}-${arch}.${suffix}`),
          `${platform} ${arch} full package`,
        );
      }
      const output = join(root, portableUpdateManifestName(platform));
      const manifest = await generatePortableUpdateManifest({
        directory: root,
        platform,
        repository: 'router-for-me/EasyCLIProxyAPI',
        tag: 'v1.2.3',
        publishedAt: '2026-08-10T00:00:00.000Z',
      });

      expect(manifest.fullAssets).toBeUndefined();
      for (const arch of ['amd64', 'aarch64']) {
        expect(manifest.assets[`${platform}-${arch}`].url).toEndWith(
          `/EasyCLIProxyAPI-v1.2.3-${display}-${arch}.${suffix}`,
        );
      }
      expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(manifest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
