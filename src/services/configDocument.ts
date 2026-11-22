import { invoke } from './platform';

export type KeyRemark = { key: string; remark: string };

export type ConfigDocument = {
  yaml: string;
  etag: string | null;
  remarks: KeyRemark[];
  remarksUnavailable: boolean;
};

type ConfigSaveResult = {
  document: ConfigDocument | null;
  restartRequired: boolean;
  syncFailed: boolean;
  remarksFailed: boolean;
  readbackChanged: boolean;
};

export const readConfigDocument = (revision: number) =>
  invoke<ConfigDocument>('read_cpa_config_document', { revision });

export const saveConfigDocument = (revision: number, etag: string, yaml: string, remarks: KeyRemark[]) =>
  invoke<ConfigSaveResult>('save_cpa_config_document', { revision, etag, yaml, remarks });
