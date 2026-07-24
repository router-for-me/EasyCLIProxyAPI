import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { generatePortableUpdateManifest } from '../scripts/generate-portable-update-manifest.mjs';

describe('Windows 便携更新清单', () => {
  test('URL、大小和哈希与实际上传资产一致', async () => {
    const root = await mkdtemp(join(tmpdir(), 'easycli-manifest-test-'));
    try {
      const payloads = {
        amd64: Buffer.from('amd64 portable updater'),
        aarch64: Buffer.from('aarch64 portable updater'),
      };
      for (const [arch, contents] of Object.entries(payloads)) {
        await writeFile(
          join(root, `EasyCLIProxyAPI-update-v1.2.3-Windows-${arch}.zip`),
          contents,
        );
      }

      const output = join(root, 'portable-update-windows.json');
      const manifest = await generatePortableUpdateManifest({
        directory: root,
        output,
        repository: 'router-for-me/EasyCLIProxyAPI',
        tag: 'v1.2.3',
        publishedAt: '2026-07-24T00:00:00.000Z',
      });
      const saved = JSON.parse(await readFile(output, 'utf8'));

      expect(saved).toEqual(manifest);
      for (const arch of ['amd64', 'aarch64'] as const) {
        const asset = manifest.assets[`windows-${arch}`];
        expect(asset.url).toBe(
          `https://github.com/router-for-me/EasyCLIProxyAPI/releases/download/v1.2.3/EasyCLIProxyAPI-update-v1.2.3-Windows-${arch}.zip`,
        );
        expect(asset.sizeBytes).toBe(payloads[arch].byteLength);
        expect(asset.sha256).toBe(createHash('sha256').update(payloads[arch]).digest('hex'));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('缺少任一架构资产时拒绝生成清单', async () => {
    const root = await mkdtemp(join(tmpdir(), 'easycli-manifest-missing-'));
    try {
      await writeFile(
        join(root, 'EasyCLIProxyAPI-update-v1.2.3-Windows-amd64.zip'),
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
