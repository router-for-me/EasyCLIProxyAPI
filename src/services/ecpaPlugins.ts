import bundledRegistry from '../data/ecpaRegistry.json';
import { isRecord } from './managementApi';

export const ECPA_REGISTRY_URL = 'https://raw.githubusercontent.com/stark-shadow/ecpa-plugins-store/main/registry.json';
export const ECPA_GITHUB_TOKEN_KEY = 'ecpa.github_token';
export const ECPA_REGISTRY_CACHE_KEY = 'ecpa.registry.cache';
export const ECPA_REGISTRY_CACHE_TTL_MS = 15 * 60 * 1000;
export const ECPA_REGISTRY_FETCH_TIMEOUT_MS = 5000;

export interface EcpaPluginEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  repository: string;
  logo: string;
  homepage: string;
  license: string;
  tags: string[];
}

export interface EcpaRegistry {
  schema_version: 1;
  plugins: EcpaPluginEntry[];
}

export interface EcpaRegistryCacheEnvelope {
  fetchedAt: number;
  payload: EcpaRegistry;
}

export interface EcpaRegistryFetchResult {
  registry: EcpaRegistry | null;
  source: 'remote' | 'cache' | 'bundled';
  tokenInvalid: boolean;
  usedFallback: boolean;
}

export interface FetchEcpaRegistryOptions {
  token?: string;
  forceRefresh?: boolean;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  now?: number;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function parsePluginEntry(value: unknown): EcpaPluginEntry | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const name = text(value.name);
  if (!id || !name) return null;
  const tags = Array.isArray(value.tags)
    ? Array.from(new Set(value.tags.map(text).filter(Boolean)))
    : [];
  return {
    id,
    name,
    description: text(value.description),
    author: text(value.author),
    version: text(value.version),
    repository: text(value.repository),
    logo: text(value.logo),
    homepage: text(value.homepage),
    license: text(value.license),
    tags,
  };
}

export function parseEcpaRegistry(value: unknown): EcpaRegistry | null {
  if (!isRecord(value)) return null;
  if (value.schema_version !== 1) return null;
  if (!Array.isArray(value.plugins)) return null;
  const plugins: EcpaPluginEntry[] = [];
  for (const item of value.plugins) {
    const parsed = parsePluginEntry(item);
    if (parsed) plugins.push(parsed);
  }
  return {
    schema_version: 1,
    plugins,
  };
}

export function getBundledEcpaRegistry(): EcpaRegistry {
  return parseEcpaRegistry(bundledRegistry) ?? { schema_version: 1, plugins: [] };
}

export function readEcpaGitHubToken(): string {
  try {
    if (typeof localStorage === 'undefined') return '';
    return (localStorage.getItem(ECPA_GITHUB_TOKEN_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

export function writeEcpaGitHubToken(token: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const trimmed = token.trim();
    if (trimmed) {
      localStorage.setItem(ECPA_GITHUB_TOKEN_KEY, trimmed);
    } else {
      localStorage.removeItem(ECPA_GITHUB_TOKEN_KEY);
    }
  } catch {
    // Ignore storage write errors in restricted environments.
  }
}

export function clearEcpaGitHubToken(): void {
  writeEcpaGitHubToken('');
}

export function readEcpaRegistryCache(now = Date.now()): EcpaRegistry | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(ECPA_REGISTRY_CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const fetchedAt = parsed.fetchedAt;
    if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return null;
    if (now - fetchedAt < 0 || now - fetchedAt >= ECPA_REGISTRY_CACHE_TTL_MS) return null;
    return parseEcpaRegistry(parsed.payload);
  } catch {
    return null;
  }
}

export function writeEcpaRegistryCache(payload: EcpaRegistry, now = Date.now()): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const envelope: EcpaRegistryCacheEnvelope = { fetchedAt: now, payload };
    localStorage.setItem(ECPA_REGISTRY_CACHE_KEY, JSON.stringify(envelope));
  } catch {
    // Ignore storage quota or access errors.
  }
}

async function fetchRegistryOnce(
  token: string | undefined,
  externalSignal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<{ status: number; payload: unknown } | null> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) return null;
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), ECPA_REGISTRY_FETCH_TIMEOUT_MS);
  try {
    const init: RequestInit = { signal: controller.signal };
    const trimmedToken = token?.trim();
    if (trimmedToken) {
      init.headers = { Authorization: `token ${trimmedToken}` };
    }
    const response = await fetchImpl(ECPA_REGISTRY_URL, init);
    if (response.status !== 200) {
      return { status: response.status, payload: null };
    }
    const payload: unknown = await response.json();
    return { status: 200, payload };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export async function fetchEcpaRegistry(
  options: FetchEcpaRegistryOptions = {},
): Promise<EcpaRegistryFetchResult> {
  try {
    const now = options.now ?? Date.now();
    if (!options.forceRefresh) {
      const cached = readEcpaRegistryCache(now);
      if (cached) {
        return {
          registry: cached,
          source: 'cache',
          tokenInvalid: false,
          usedFallback: false,
        };
      }
    }

    const fetchImpl = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!fetchImpl) {
      return {
        registry: null,
        source: 'bundled',
        tokenInvalid: false,
        usedFallback: true,
      };
    }

    const configuredToken = (options.token ?? readEcpaGitHubToken()).trim();
    let tokenInvalid = false;

    if (configuredToken) {
      const authedResult = await fetchRegistryOnce(configuredToken, options.signal, fetchImpl);
      if (authedResult && (authedResult.status === 401 || authedResult.status === 403)) {
        tokenInvalid = true;
      } else if (authedResult && authedResult.status === 200) {
        const parsed = parseEcpaRegistry(authedResult.payload);
        if (parsed) {
          writeEcpaRegistryCache(parsed, Date.now());
          return {
            registry: parsed,
            source: 'remote',
            tokenInvalid: false,
            usedFallback: false,
          };
        }
        return {
          registry: null,
          source: 'bundled',
          tokenInvalid: false,
          usedFallback: true,
        };
      } else {
        return {
          registry: null,
          source: 'bundled',
          tokenInvalid: false,
          usedFallback: true,
        };
      }
    }

    const anonResult = await fetchRegistryOnce(undefined, options.signal, fetchImpl);
    if (anonResult && anonResult.status === 200) {
      const parsed = parseEcpaRegistry(anonResult.payload);
      if (parsed) {
        writeEcpaRegistryCache(parsed, Date.now());
        return {
          registry: parsed,
          source: 'remote',
          tokenInvalid,
          usedFallback: false,
        };
      }
    }

    return {
      registry: null,
      source: 'bundled',
      tokenInvalid,
      usedFallback: true,
    };
  } catch {
    return {
      registry: null,
      source: 'bundled',
      tokenInvalid: false,
      usedFallback: true,
    };
  }
}
