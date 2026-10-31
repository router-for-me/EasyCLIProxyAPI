import { isRecord, managementApi, readString } from './managementApi';
import { authFileCooldownResetIndex, isOAuthCredentialFile, type AuthFileRecord } from './authFiles';

export type CredentialResult = { id: string; success: boolean; error?: string };
type RefreshApi = Pick<typeof managementApi, 'post'>;

export function normalizeCredentialResults(payload: unknown): CredentialResult[] {
  if (!isRecord(payload) || payload.ok !== true || !Array.isArray(payload.results)) throw new Error('Invalid credential refresh response');
  return payload.results.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id.trim() || typeof entry.success !== 'boolean') throw new Error('Invalid credential refresh result');
    // Never retain the raw response: single refresh responses contain tokens.
    return { id: entry.id, success: entry.success, ...(!entry.success && typeof entry.error === 'string' ? { error: entry.error } : {}) };
  });
}

export async function refreshCredential(file: AuthFileRecord, api: RefreshApi = managementApi): Promise<void> {
  if (!isOAuthCredentialFile(file) || file.disabled === true) throw new Error('Credential cannot be refreshed');
  const authIndex = authFileCooldownResetIndex(file);
  const response = await api.post('/credentials/refresh', { name: readString(file, 'name'), ...(authIndex ? { auth_index: authIndex } : {}) }, { timeoutMs: 300_000 });
  if (!isRecord(response) || response.ok !== true) throw new Error('Invalid credential refresh response');
}

export async function refreshAllCredentials(api: RefreshApi = managementApi): Promise<CredentialResult[]> {
  return normalizeCredentialResults(await api.post('/credentials/refresh', { all: true }, { timeoutMs: 300_000 }));
}

/** Bounded sequential operations preserve individual failures and avoid request bursts. */
export async function runCredentialBatch(files: AuthFileRecord[], action: (file: AuthFileRecord) => Promise<unknown>): Promise<CredentialResult[]> {
  const results: CredentialResult[] = [];
  for (const file of files) {
    const id = readString(file, 'name');
    try { await action(file); results.push({ id, success: true }); }
    catch (error) { results.push({ id, success: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}
