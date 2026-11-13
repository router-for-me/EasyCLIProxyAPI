import { useState } from 'react';
import { useI18n } from '../i18n';
import example from '../../docs/themes/custom-theme.example.json';
import { themeSchemaJson } from '../themes/themeSchema';
import { builtinThemes } from '../themes/registry';
import { Dialog } from './Dialog';
import { Notice } from './Notice';

export function ThemeDiyGuide({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const json = JSON.stringify(example, null, 2);
  const prompt = [
    t('app.theme.diy.agentTask'),
    t('app.theme.diy.deliverables'),
    t('app.theme.diy.validation'),
    t('app.theme.diy.defaults'),
    t('app.theme.diy.image'),
    'Optional top-level image field: "assets": { "backdropImage": "assets/backdrop.webp" }',
    t('app.theme.diy.gradient'),
    t('app.theme.diy.recovery'),
    'Resource rules: theme.json <= 64 KiB; images <= 8 MiB. Image files must exist inside the theme folder. No remote URLs, absolute asset paths, .. or symlinks. Do not add CSS, scripts, layout, font size or font weight settings; font families only via fontFamilySans and fontFamilyMono. The optional icon path is validated but is not displayed in theme cards.',
    'Built-in/reserved IDs: system, ' + builtinThemes.map(theme => theme.id).join(', ') + '.',
    'Complete reference example (adapt the ID, name and colors to the request):',
    '```json\n' + json + '\n```',
    'JSON Schema (validate the final theme against this contract):',
    '```json\n' + themeSchemaJson() + '\n```',
  ].join('\n\n');
  return <Dialog className="theme-diy-guide surface-panel" title={t('app.theme.diy.title')}
    onClose={onClose} dismissOnBackdrop>
    <div className="theme-diy-content">
      <p>{t('app.theme.diy.intro')}</p>
      <button type="button" className="primary-button" onClick={async () => {
        try { await navigator.clipboard.writeText(prompt); setCopyState('copied'); }
        catch { setCopyState('failed'); }
      }}>{t('app.theme.diy.copy')}</button>
      {copyState !== 'idle' ? <Notice variant="text" tone={copyState === 'failed' ? 'error' : 'success'}>
        {t(copyState === 'failed' ? 'app.theme.diy.copyFailed' : 'app.theme.diy.copied')}
      </Notice> : null}
      {copyState === 'failed' ? <textarea className="config-dialog-text-input theme-diy-fallback"
        aria-label={t('app.theme.diy.copy')} value={prompt} readOnly rows={5}
        onFocus={event => event.currentTarget.select()} /> : null}
      <div className="theme-diy-install">
        <h3>{t('app.theme.diy.install')}</h3>
        <p>{t('app.theme.diy.installHint')}</p>
      </div>
    </div>
  </Dialog>;
}
