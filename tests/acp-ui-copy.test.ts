import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { acpZhCN, acpEn } from '../src/i18n/acp';

// Source/copy contracts only. Native layout, focus and interaction acceptance
// belongs to the direct computer-use operator, not a simulated browser verdict.
const source = readFileSync(new URL('../src/pages/AcpAccessPage.tsx', import.meta.url), 'utf8');
const service = readFileSync(new URL('../src/services/acp.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/pages/AcpAccessPage.css', import.meta.url), 'utf8');

test('ACP locales match and all interface/error references resolve', () => {
  expect(Object.keys(acpZhCN).sort()).toEqual(Object.keys(acpEn).sort());
  const used = [...(source + service).matchAll(/['"]((?:acp|oauth\.acp)\.[A-Za-z0-9.]+)['"]/g)].map(match => match[1]);
  for (const key of new Set(used)) {
    expect(acpZhCN[key as keyof typeof acpZhCN]).toBeTruthy();
    expect(acpEn[key as keyof typeof acpEn]).toBeTruthy();
  }
});

test('ACP does not render design notes or duplicate form help', () => {
  for (const removed of ['savedNotVerified', 'localRecoveryHint', 'newAccountHint', 'noteHint', 'cancelledHint', 'sharedCli', 'apiDescription', 'apiHint', 'apiSwitchStartHint', 'apiSwitchStopHint', 'modelHint', 'connectionFlow']) {
    expect(source).not.toContain(`acp.${removed}`);
    expect(Object.keys(acpEn)).not.toContain(`acp.${removed}`);
  }
  expect(source).not.toContain('acp-footnote');
  expect(source).toContain('acp-note-count');
  expect(source).not.toContain('acp-note-help');
  expect(source).toContain("aria-describedby={formError ? 'acp-note-error' : undefined}");
  expect(source).toContain('!editor && !confirmationDialog ? actionNotice : null');
  expect(source).toContain("apiEnabled && !apiReady ? t('acp.apiSwitchWaitingConnection') : ''");
  expect(css).toContain('justify-content: flex-end');
  expect(css).toContain('.acp-account-menu { position: absolute');
});

test('short confirmations keep the actual consequences, not implementation promises', () => {
  const locales = [acpZhCN, acpEn];
  for (const locale of locales) {
    expect(locale['acp.removeMessage'].length).toBeLessThan(150);
    expect(locale['acp.logoutMessage'].length).toBeLessThan(85);
    expect(locale['acp.reloginMessage'].length).toBeLessThan(85);
    const copy = [locale['acp.removeMessage'], locale['acp.logoutMessage'], locale['acp.reloginMessage']].join(' ');
    expect(copy).not.toMatch(/removed-accounts|continuation|全局|回收目录|first remaining|empty slot/i);
  }
  expect(acpEn['acp.removeMessage']).toMatch(/Login data stays on this device/);
  expect(acpEn['acp.removeMessage']).toMatch(/does not sign out or delete your Google account/);
  expect(acpZhCN['acp.removeMessage']).toMatch(/登录数据仍保留在本机/);
  expect(acpEn['acp.logoutMessage']).toMatch(/Keep its local record and label/);
  expect(acpEn['acp.reloginMessage']).toMatch(/Sign out.*then open Google authorization/);
});

test('maintenance errors do not claim account success or hidden safety guarantees', () => {
  for (const locale of [acpZhCN, acpEn]) {
    expect(locale['acp.errorProviderSyncFailed']).not.toMatch(/已处理|processed|successful|unchanged|保持原设置/i);
    expect(locale['acp.errorLogoutUnsupported']).not.toMatch(/silently|静默/);
  }
  expect(source).toContain('acp-error-detail');
  expect(source).toContain('privacy.text(shownError)');
  expect(service).toContain('return null;');
});

test('current-account removal warns about disconnection and API icon follows its own enabled state', () => {
  expect(source).toContain("warning: kind === 'remove' && account.id === status?.activeAccount ? t('acp.removeCurrentWarning') : undefined");
  expect(acpZhCN['acp.removeCurrentWarning']).toBe('当前连接将断开。');
  expect(acpEn['acp.removeCurrentWarning']).toBe('This will disconnect the current account.');
  expect(css).toContain(".acp-access-page[data-connected='true'] .acp-model-card:not(.acp-api-card) .acp-section-icon");
  expect(css).not.toContain(".acp-access-page[data-connected='true'] .acp-model-card .acp-section-icon");
  expect(css).toContain(".acp-api-card[data-enabled='true'] .acp-section-icon");
  expect(acpEn['acp.labelInvalid']).toBe('Enter a 1–80 character label without control characters.');
});
