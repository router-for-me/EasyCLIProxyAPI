import { invoke } from '@tauri-apps/api/core';
import { getCurrentLocale, translate } from '../i18n';
import { isRecord, readString } from './managementApi';

export type VertexImportResult = {
  projectId: string;
  email: string;
  location: string;
  authFile: string;
};

export async function importVertexCredential(file: File, location: string): Promise<VertexImportResult> {
  const message = (key: 'oauth.vertex.invalidFile' | 'oauth.vertex.invalidResponse') =>
    translate(getCurrentLocale(), key);
  if (!file.name.toLowerCase().endsWith('.json')) throw new Error(message('oauth.vertex.invalidFile'));
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    if (!isRecord(JSON.parse(new TextDecoder().decode(bytes)))) throw new Error();
  } catch {
    throw new Error(message('oauth.vertex.invalidFile'));
  }
  // The core normalizes and validates the service account and creates the auth record.
  const response = await invoke<unknown>('import_vertex_credential', {
    name: file.name, data: Array.from(bytes), location: location.trim() || undefined,
  });
  if (!isRecord(response) || response.status !== 'ok') {
    throw new Error(message('oauth.vertex.invalidResponse'));
  }
  return {
    projectId: readString(response, 'project_id'),
    email: readString(response, 'email'),
    location: readString(response, 'location'),
    authFile: readString(response, 'auth-file', 'auth_file'),
  };
}
