import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAppVersion } from '../scripts/version.mjs';
import { fullReleaseMatrix, resolveBuildMatrix } from '../scripts/release-matrix.mjs';

const releaseWorkflow = Bun.YAML.parse(readFileSync('.github/workflows/release.yml', 'utf8')) as any;
const anchors = JSON.parse(readFileSync('app-version-anchors.json', 'utf8'));
const sourceVersion = await readAppVersion();
const baseVersion = sourceVersion.split(/[-+]/)[0];

function runResolveVersionScript(env: Record<string, string>, sourceOverride?: string) {
  const versionJob = releaseWorkflow.jobs.version;
  const resolveStep = versionJob.steps.find((step: any) => step.id === 'resolve');
  const script = sourceOverride
    ? resolveStep.run.replace('source_version="$(node scripts/version.mjs)"', `source_version="${sourceOverride}"`)
    : resolveStep.run;

  const tempDir = mkdtempSync(join(tmpdir(), 'resolve-ver-'));
  const outputPath = join(tempDir, 'output');
  try {
    const result = spawnSync('bash', ['-c', script], {
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_RUN_NUMBER: '10',
        GITHUB_RUN_ATTEMPT: '1',
        PR_NUMBER: '42',
        MIAOMIAO_PREVIEW: 'false',
        MANUAL_PRERELEASE: 'true',
        ...env,
      },
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(`Script failed: ${result.stderr}`);
    }

    const lines = readFileSync(outputPath, 'utf8').trim().split('\n');
    const outputs: Record<string, string> = {};
    for (const line of lines) {
      const match = line.match(/^([^=]+)=(.*)$/);
      if (match) {
        outputs[match[1]] = match[2];
      }
    }
    return outputs;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('release version resolution workflow', () => {
  it('supports non-semver preview tags such as only-preview', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: 'only-preview',
      MIAOMIAO_PREVIEW: 'false',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    });
    expect(outputs.tag).toBe('only-preview');
    expect(outputs.version.startsWith(`${baseVersion}-preview.`)).toBe(true);
    expect(outputs.version).toMatch(/-preview\.\d{8}-\d{4}$/);
    expect(outputs.release_family).toBe('preview');
    expect(outputs.preview_series_version).toBe(outputs.version.split('-preview.')[1]);
    expect(outputs.stable_series_version).toBe(anchors.stable);
  });

  it('normalizes bare semver to v-prefixed tag', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: '1.2.3',
      MIAOMIAO_PREVIEW: 'false',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    });
    expect(outputs.tag).toBe('v1.2.3');
    expect(outputs.version).toBe('1.2.3');
  });

  it('preserves v-prefixed semver tag', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: 'v2.0.0-rc.1',
      MIAOMIAO_PREVIEW: 'false',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    });
    expect(outputs.tag).toBe('v2.0.0-rc.1');
    expect(outputs.version).toBe('2.0.0-rc.1');
  });

  it('defaults to source version when requested version is empty', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: '',
      MIAOMIAO_PREVIEW: 'false',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    });
    expect(outputs.tag).toBe(`v${sourceVersion}`);
    expect(outputs.version).toBe(sourceVersion);
  });

  it('resolves rolling miaomiao preview tag and version', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: '',
      MIAOMIAO_PREVIEW: 'true',
      GITHUB_EVENT_NAME: 'workflow_call',
    });
    expect(outputs.tag).toBe(`v${baseVersion}-miaomiao.10.1`);
    expect(outputs.version).toBe(`${baseVersion}-miaomiao.10.1`);
  });

  it('resolves pull request tag and version', () => {
    const outputs = runResolveVersionScript({
      REQUESTED_VERSION: '',
      MIAOMIAO_PREVIEW: 'false',
      GITHUB_EVENT_NAME: 'pull_request',
    });
    expect(outputs.tag).toBe(`v${baseVersion}-pr.42.10.1`);
    expect(outputs.version).toBe(`${baseVersion}-pr.42.10.1`);
  });

  it('stamps both coordinates for ordinary stable and preview workflows, never for test artifacts', () => {
    const tag = runResolveVersionScript({ REQUESTED_VERSION: 'v1.2.3', EVENT_NAME: 'push', REF_TYPE: 'tag', REF_NAME: 'v1.2.3' });
    expect(tag.stable_series_version).toBe('1.2.3');
    expect(tag.release_family).toBe('stable');
    expect(tag.preview_series_version).toBe(anchors.preview);
    const preview = runResolveVersionScript({ REQUESTED_VERSION: '', EVENT_NAME: 'push', REF_TYPE: 'branch', REF_NAME: 'preview' });
    expect(preview.release_family).toBe('preview');
    expect(preview.preview_series_version).toBe(preview.tag.slice('preview-'.length));
    expect(preview.version).toBe(`${baseVersion}-preview.${preview.preview_series_version}`);
    expect(preview.stable_series_version).toBe(anchors.stable);
    const manual = { REQUESTED_VERSION: 'v1.2.3', EVENT_NAME: 'workflow_dispatch', REF_TYPE: 'branch', REF_NAME: 'dev' };
    expect(runResolveVersionScript({ ...manual, MANUAL_PRERELEASE: 'false' }).stable_series_version).toBe('1.2.3');
    for (const env of [
      { ...manual, MANUAL_PRERELEASE: 'true' },
      { ...manual, REQUESTED_VERSION: '', MANUAL_PRERELEASE: 'false' },
      { ...manual, EVENT_NAME: 'pull_request' },
      { ...manual, MIAOMIAO_PREVIEW: 'true' },
    ]) {
      const build = runResolveVersionScript(env);
      expect(build.release_family).toBe('unknown');
      expect(build.stable_series_version).toBe('');
      expect(build.preview_series_version).toBe('');
    }
  });

  it.each(['push', 'workflow_dispatch'])('retains the supplied timestamped Preview tag for %s', (event) => {
    const stamp = '20261121-0146';
    const tag = `preview-${stamp}`;
    const resolved = runResolveVersionScript({
      EVENT_NAME: event,
      REF_TYPE: event === 'push' ? 'tag' : 'branch',
      REF_NAME: event === 'push' ? tag : 'dev',
      REQUESTED_VERSION: tag,
    });
    expect(resolved).toEqual({
      tag,
      version: `${baseVersion}-preview.${stamp}`,
      release_family: 'preview',
      stable_series_version: anchors.stable,
      preview_series_version: stamp,
    });
  });

  it('builds pull requests only from Roomen', () => {
    expect(String(releaseWorkflow.jobs.version.if)).toContain("github.event.pull_request.user.login == 'Roomen'");
    expect(releaseWorkflow.on.pull_request.types).not.toContain('edited');
  });
});

it('publishes an explicit Preview tag without pruning other releases', () => {
  const publish = releaseWorkflow.jobs.publish.steps.find((step: any) => step.name === 'Publish release');
  const result = spawnSync('bash', ['-c', `
    gh() {
      case "$1 $2" in
        'release view') return 1 ;;
        'release create') printf '%s\\n' "$1 $2 $3" ;;
        'release list'|'release delete') printf '%s\\n' "unexpected $1 $2" ;;
        *) return 2 ;;
      esac
    }
    ${publish.run}
  `], {
    env: { ...process.env, RELEASE_TAG: 'preview-20261121-0146', GITHUB_REF_TYPE: 'tag',
      GITHUB_SHA: 'source-revision', RUNNER_TEMP: tmpdir(), MANUAL_PRERELEASE: '' },
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('release create preview-20261121-0146');
});

describe('resolved release build matrix', () => {
  function matrixFor(env: Record<string, string>, source?: string) {
    const outputs = runResolveVersionScript(env, source);
    return { outputs, ...resolveBuildMatrix({ version: outputs.version, eventName: env.EVENT_NAME,
      rollingPreview: env.MIAOMIAO_PREVIEW === 'true' }) };
  }

  const windowsX64 = [{ runner: 'windows-2025', os: 'windows', display_os: 'Windows', arch: 'amd64', suffix: 'zip' }];
  it.each([
    { EVENT_NAME: 'push', REF_TYPE: 'branch', REF_NAME: 'preview', REQUESTED_VERSION: '' },
    { EVENT_NAME: 'push', REF_TYPE: 'tag', REF_NAME: 'preview-20261121-0146', REQUESTED_VERSION: 'preview-20261121-0146' },
    { EVENT_NAME: 'workflow_dispatch', REQUESTED_VERSION: 'preview-20261121-0146' },
    { EVENT_NAME: 'workflow_dispatch', REQUESTED_VERSION: 'only-preview' },
    { EVENT_NAME: 'workflow_dispatch', REQUESTED_VERSION: 'v0.3.117-preview.20261121-0146' },
    { EVENT_NAME: 'workflow_call', REQUESTED_VERSION: '', MIAOMIAO_PREVIEW: 'true' },
  ])('narrows Preview from its resolved version: %j', (env) => {
    const build = matrixFor(env);
    expect(build.isPreview).toBe(true);
    expect(build.matrix.include).toEqual(windowsX64);
  });

  it('recognizes artifact-only Preview without changing its version or minting a coordinate', () => {
    for (const source of ['0.3.117-preview.20261121-0146', '0.3.117-preview']) {
      const build = matrixFor({ EVENT_NAME: 'workflow_dispatch', REQUESTED_VERSION: '' }, source);
      expect(build.matrix.include).toEqual(windowsX64);
      expect(build.outputs.version).toBe(source);
      expect(build.outputs.tag).toBe(`v${source}`);
      expect(build.outputs.release_family).toBe('preview');
      expect(build.outputs.stable_series_version).toBe(anchors.stable);
      expect(build.outputs.preview_series_version).toBe(source.endsWith('-preview') ? '' : '20261121-0146');
    }
  });

  it('preserves the original six-platform stable and PR contracts, regardless of manual prerelease default', () => {
    expect(fullReleaseMatrix.map(({ os, arch }) => `${os}-${arch}`)).toEqual([
      'linux-amd64', 'linux-aarch64', 'darwin-amd64', 'darwin-aarch64', 'windows-amd64', 'windows-aarch64',
    ]);
    for (const env of [
      { EVENT_NAME: 'push', REF_TYPE: 'tag', REQUESTED_VERSION: 'v1.2.3' },
      { EVENT_NAME: 'workflow_dispatch', REQUESTED_VERSION: 'v1.2.3', MANUAL_PRERELEASE: 'true' },
      { EVENT_NAME: 'workflow_dispatch', REQUESTED_VERSION: '' },
      { EVENT_NAME: 'pull_request', REQUESTED_VERSION: '' },
    ]) {
      const build = matrixFor(env, '1.2.3');
      expect(build.isPreview).toBe(false);
      expect(build.matrix.include).toEqual(fullReleaseMatrix);
    }
    expect(matrixFor({ EVENT_NAME: 'pull_request', REQUESTED_VERSION: '' }, '1.2.3-preview.20261121-0146').matrix.include).toEqual(fullReleaseMatrix);
  });

  it('connects the matrix output and Preview-only publishing checks', () => {
    expect(releaseWorkflow.jobs.build.strategy.matrix).toBe('${{ fromJSON(needs.version.outputs.build_matrix) }}');
    const matrixStep = releaseWorkflow.jobs.version.steps.find((step: any) => step.id === 'matrix');
    expect(matrixStep.env.RESOLVED_VERSION).toBe('${{ steps.resolve.outputs.version }}');
    const publishScript = releaseWorkflow.jobs['publish-preview'].steps.find((step: any) => step.run)?.run;
    expect(publishScript).toContain('packages=("artifacts/EasyCLIProxyAPI-v${APP_VERSION}-Windows-amd64.zip")');
    expect(publishScript).not.toContain('for platform in Windows Linux Darwin');
    const manifests = releaseWorkflow.jobs.publish.steps.find((step: any) => step.name === 'Generate portable update manifests');
    expect(manifests.env.IS_PREVIEW).toBe('${{ needs.version.outputs.is_preview }}');
    expect(manifests.run).toContain('platforms=(windows linux darwin)');
    expect(manifests.run).toContain('platforms=(windows)');
  });
});

it('executes the matrix workflow step with the resolved version output', () => {
  const step = releaseWorkflow.jobs.version.steps.find((step: any) => step.id === 'matrix');
  const tempDir = mkdtempSync(join(tmpdir(), 'release-matrix-'));
  try {
    for (const version of ['1.2.3', '1.2.3-preview.20261121-0146']) {
      const output = join(tempDir, version);
      const result = spawnSync('bash', ['-c', step.run], { encoding: 'utf8', env: {
        ...process.env, GITHUB_OUTPUT: output, RESOLVED_VERSION: version,
        EVENT_NAME: 'workflow_dispatch', MIAOMIAO_PREVIEW: 'false',
      } });
      expect(result.status).toBe(0);
      const lines = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }));
      expect(lines.is_preview).toBe(String(version.includes('-preview.')));
      expect(JSON.parse(lines.matrix).include).toHaveLength(version.includes('-preview.') ? 1 : 6);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
