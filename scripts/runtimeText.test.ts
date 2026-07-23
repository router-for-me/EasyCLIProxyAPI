import { describe, expect, test } from 'bun:test';
import { localizeRuntimeText } from '../src/i18n/runtimeText';

describe('localizeRuntimeText', () => {
  test('translates known core status messages for English', () => {
    expect(localizeRuntimeText('en', '未安装 CPA 内核，请先安装最新版'))
      .toBe('CPA core is not installed. Install the latest version first.');
    expect(localizeRuntimeText('en', 'CPA 内核正在运行')).toBe('CPA core is running');
  });

  test('translates port errors while preserving the port number', () => {
    expect(localizeRuntimeText('en', '端口 8317 已被其他程序占用，请更换端口后重试'))
      .toBe('Port 8317 is already in use. Choose another port and try again.');
  });

  test('never returns Han text for an unknown runtime error in English', () => {
    expect(localizeRuntimeText('en', '未知的中文运行时错误')).toBe('The operation failed.');
  });

  test('leaves non-Chinese technical errors unchanged', () => {
    expect(localizeRuntimeText('en', 'Connection refused: http://127.0.0.1:8317'))
      .toBe('Connection refused: http://127.0.0.1:8317');
  });
});
