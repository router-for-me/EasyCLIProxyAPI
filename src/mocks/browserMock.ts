import { emit } from '@tauri-apps/api/event';
import { mockConvertFileSrc, mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import {
  createBrowserMockRuntime,
  resolveBrowserMockOptions,
  type BrowserMockScenario,
} from './browserMockRuntime';
import './browserMock.css';

const STORAGE_KEY = 'easy-cli-proxy-api.browser-mock-scenario';

export type InstalledBrowserMock = {
  scenario: BrowserMockScenario;
  delayMs: number;
};

function readStoredScenario() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeScenario(scenario: BrowserMockScenario) {
  try {
    window.localStorage.setItem(STORAGE_KEY, scenario);
  } catch {
  }
}

function installToolbar(scenario: BrowserMockScenario, delayMs: number) {
  document.getElementById('browser-mock-toolbar')?.remove();

  const toolbar = document.createElement('aside');
  toolbar.id = 'browser-mock-toolbar';
  toolbar.setAttribute('aria-label', 'Browser Mock controls');
  toolbar.title = '仅在普通浏览器开发模式中显示；Tauri 和正式构建不会启用 Mock。';

  const badge = document.createElement('strong');
  badge.textContent = 'MOCK';

  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Browser Mock 场景');
  const scenarios: Array<[BrowserMockScenario, string]> = [
    ['running', '内核运行'],
    ['stopped', '内核停止'],
    ['empty', '未安装内核'],
    ['error', '请求错误'],
  ];
  scenarios.forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === scenario;
    select.append(option);
  });
  select.addEventListener('change', () => {
    const next = select.value as BrowserMockScenario;
    storeScenario(next);
    const url = new URL(window.location.href);
    url.searchParams.set('mock', next);
    window.location.assign(url);
  });

  const hint = document.createElement('span');
  hint.textContent = delayMs > 0 ? `${delayMs} ms` : '浏览器调试';

  toolbar.append(badge, select, hint);
  document.body.append(toolbar);
  document.body.dataset.browserMock = scenario;
}

export function installBrowserMock(): InstalledBrowserMock | null {
  const options = resolveBrowserMockOptions(window.location.search, readStoredScenario());
  if (options.mode === 'off') {
    console.info('[Browser Mock] 已通过 ?mock=off 禁用。');
    return null;
  }

  storeScenario(options.mode);
  mockWindows('main');
  mockConvertFileSrc('windows');

  const runtime = createBrowserMockRuntime(
    options.mode,
    (event, payload) => {
      queueMicrotask(() => {
        void emit(event, payload);
      });
    },
    options.delayMs,
  );

  mockIPC((command, payload) => runtime.invoke(command, payload), {
    shouldMockEvents: true,
  });
  installToolbar(options.mode, options.delayMs);

  console.info(
    `[Browser Mock] 已启用场景“${options.mode}”${options.delayMs ? `，延迟 ${options.delayMs} ms` : ''}。`,
    '使用 ?mock=running|stopped|empty|error 切换，?mock=off 禁用。',
  );
  return { scenario: options.mode, delayMs: options.delayMs };
}
