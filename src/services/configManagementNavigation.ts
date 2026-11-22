import { selectedTargetRevision } from './remoteCpa';

let destination: { fieldId: string; revision: number } | undefined;

export function openConfigManagementField(fieldId: string) {
  destination = { fieldId, revision: selectedTargetRevision() };
  window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'config-management' }));
}

export function takeConfigManagementField(revision: number) {
  const requested = destination;
  destination = undefined;
  return requested?.revision === revision ? requested.fieldId : undefined;
}
