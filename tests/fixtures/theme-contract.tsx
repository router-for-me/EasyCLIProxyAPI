import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n';
import { Dialog } from '../../src/components/Dialog';
import { Switch } from '../../src/components/Switch';
import { Select } from '../../src/components/Select';
import { SelectMenu } from '../../src/components/SelectMenu';
import { Tabs } from '../../src/components/Tabs';
import { builtinThemes, createThemeRegistry } from '../../src/themes/registry';
import { initializeTheme } from '../../src/theme';
import '../../src/styles/index.css';

const contractTheme = {
  schemaVersion: 1,
  id: 'contract-dark',
  name: 'Contract',
  appearance: 'dark',
  order: 90,
  windowBackground: '#101820',
  tokens: {
    workspaceBackground: '#101820', surface: '#18242C', softSurface: '#1E2B34', hoverBackground: '#243440',
    textPrimary: '#E7F1F2', textSecondary: '#C2D3D6', textTertiary: '#A6BABD', textMuted: '#93A9AC',
    border: '#2E4650', borderSubtle: '#223741', borderStrong: '#3E5C68', borderHover: '#557A88',
    accent: '#6FD3C1', accentStrong: '#8FE0D1', accentSoft: '#1D3B3A', accentContrast: '#0E1A1F',
    controlBorderWidth: '2px', cardBorderWidth: '3px',
    radiusSmall: '1px', radiusMedium: '2px', radiusLarge: '20px',
    shadowSmall: '0 0 0 3px #ff0000', shadowLarge: '0 0 0 4px #00ff00', shadowPopover: '0 0 0 5px #0000ff',
  },
} as const;

const registry = createThemeRegistry([...builtinThemes, contractTheme]);
const controller = initializeTheme(registry);
let setDialogState: (open: boolean) => void = () => {};

function Probe() {
  const [checked, setChecked] = useState(false);
  const [tab, setTab] = useState('one');
  const [value, setValue] = useState('a');
  const [menuValue, setMenuValue] = useState('first');
  const [dialogOpen, setDialogOpen] = useState(true);
  useEffect(() => { setDialogState = setDialogOpen; }, []);
  return <div className="workspace">
    <button type="button" className="secondary-button">Secondary</button>
    <button type="button" className="primary-button">Primary</button>
    <button type="button" className="secondary-button" disabled>Disabled</button>
    <div className="panel" data-probe="panel">Panel</div>
    <div className="surface-card" data-probe="card">Card</div>
    <div className="surface-section" data-probe="section">Section</div>
    <div className="surface-frame" data-probe="frame">Frame</div>
    <div className="surface-sunken" data-probe="sunken">Sunken</div>
    <div className="surface-dashed" data-probe="dashed">Dashed</div>
    <Switch checked={checked} onChange={(event) => setChecked(event.currentTarget.checked)} label="Switch" />
    <Select value={value} onChange={(event) => setValue(event.currentTarget.value)} aria-label="Probe select">
      <option value="a">A</option>
      <option value="b">B</option>
    </Select>
    <SelectMenu ariaLabel="Probe menu" value={menuValue} onChange={setMenuValue}
      options={[{ value: 'first', label: 'First' }, { value: 'second', label: 'Second' }]} />
    <Tabs className="usage-tabs" aria-label="Probe tabs" items={[
      { value: 'one', id: 'probe-tab-one', panelId: 'probe-panel-one', label: 'One' },
      { value: 'two', id: 'probe-tab-two', panelId: 'probe-panel-two', label: 'Two' },
    ]} value={tab} onChange={setTab} />
    {dialogOpen ? <Dialog title="Probe dialog" onClose={() => setDialogOpen(false)} actions={<button type="button" className="primary-button">OK</button>}>
      <input className="config-dialog-text-input" defaultValue="value" aria-label="Probe input" />
    </Dialog> : null}
  </div>;
}

Object.assign(window, {
  themeContractFixture: {
    apply: (id: string) => controller.setPreference(id),
    setDialog: (open: boolean) => setDialogState(open),
  },
});

createRoot(document.getElementById('root')!).render(<I18nProvider><Probe /></I18nProvider>);
