import { invoke, isTauri } from './platform';
import { resetTargetQuotaCache } from './quotaCache';
import { selectCredentialTagStore } from './credentialTags';

export type CpaConnection = {
  remoteActive: boolean;
  remoteSelected: boolean;
  endpoint: string | null;
  savedEndpoints?: string[];
  needsRepair: boolean;
  revision: number;
};

type ConnectionDraft = { revision: number; remote: boolean; endpoint: string; key: string };
export type RemoteKeys = { keys: string[]; snapshot: number };
type RemoteScope = { revision: number };

export const localCpaConnection: CpaConnection = {
  remoteActive: false, remoteSelected: false, endpoint: null, needsRepair: false, revision: 0,
};

export const cpaConnectionPending = (connection: CpaConnection) => connection.remoteActive !== connection.remoteSelected;
export const canManageRemoteCpa = (connection: CpaConnection) =>
  connection.remoteActive && connection.remoteSelected && !connection.needsRepair && Boolean(connection.endpoint);

let current: CpaConnection = localCpaConnection;
export const selectedTargetRevision = () => current.revision;
export const selectedRemoteEndpoint = () => current.remoteActive ? current.endpoint : null;
export const remoteTargetRevision = () => current.remoteActive ? current.revision : undefined;
export function useConnectionTarget(connection: CpaConnection) {
  if (current.endpoint !== connection.endpoint || current.revision !== connection.revision) resetTargetQuotaCache();
  current = connection;
  selectCredentialTagStore(connection.remoteActive ? connection.endpoint : null);
  return connection;
}
export const getCpaConnection = async () => {
  const connection = isTauri() ? await invoke<CpaConnection>('get_cpa_connection') : localCpaConnection;
  return useConnectionTarget(connection);
};
export const testRemoteCpa = ({ revision, endpoint, key }: ConnectionDraft) =>
  invoke<void>('test_remote_cpa', { revision, endpoint, key });
export const selectCpaConnection = ({ revision, remote, endpoint, key }: ConnectionDraft) =>
  invoke<CpaConnection>('select_cpa_connection', { revision, remote, endpoint: remote ? endpoint : '', key: remote ? key : '' }).then(useConnectionTarget);
export const forgetCpaInstance = (revision: number, endpoint: string) =>
  invoke<CpaConnection>('forget_cpa_instance', { revision, endpoint }).then(useConnectionTarget);
export const getRemoteCpaKeys = (revision: number) => invoke<RemoteKeys>('get_remote_cpa_keys', { revision });
export const saveRemoteCpaKeys = ({ revision, snapshot, keys }: RemoteScope & RemoteKeys) =>
  invoke<void>('save_remote_cpa_keys', { revision, snapshot, keys });

export function parseClientKeys(text: string): string[] {
  return text.split(/\r?\n/).map(key => key.trim()).filter(Boolean);
}

// Only display closed-set native error codes. Never render raw exceptions (which
// can contain request arguments, URLs, authorization headers, or response bodies).
const remoteErrors = new Set([
  'invalidEndpoint', 'invalidKey', 'keyRequired', 'profileInvalid', 'profileWrite',
  'busy', 'notActive', 'stopFailed', 'startFailed', 'rollbackFailed', 'managedTarget', 'endpointChanged', 'notAuthorized', 'unreachable', 'transport',
  'redirect', 'unsupported', 'serverRejected', 'invalidResponse', 'conflict', 'invalidKeys',
  'keyMatchesManagement', 'saveUnconfirmed',
]);
export function remoteCpaErrorKey(error: unknown): string {
  return typeof error === 'string' && remoteErrors.has(error) ? `remote.error.${error}` : 'remote.error.unknown';
}
