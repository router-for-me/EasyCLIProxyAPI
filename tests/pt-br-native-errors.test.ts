import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { localizedOwnError } from '../src/services/localizedOwnError';

it('localizes only known app-owned error summaries, preserving technical detail and other locales', () => {
  expect(localizedOwnError('sensitiveWords', 'Cloud rule file exceeds 1 MiB', 'pt-BR'))
    .toBe('O arquivo de regras da nuvem excede 1 MiB.');
  expect(localizedOwnError('sensitiveWords', 'GitHub API: 503; Raw fallback: Invalid rule JSON: line 4', 'pt-BR'))
    .toBe('O JSON do arquivo de regras é inválido. (GitHub API: 503; Raw fallback: Invalid rule JSON: line 4)');
  expect(localizedOwnError('reverseProxyTls', 'Certificate file does not exist: C:/demo/cert.pem', 'pt-BR'))
    .toBe('O arquivo de certificado não existe: C:/demo/cert.pem');
  expect(localizedOwnError('acp', 'Refresh available ACP models first', 'pt-BR'))
    .toBe('Atualize primeiro a lista de modelos ACP disponíveis.');
  expect(localizedOwnError('acp', 'Upstream service unavailable', 'pt-BR')).toBe('Upstream service unavailable');
  for (const locale of ['en', 'zh-CN', 'ja', 'ru', 'zh-TW']) {
    expect(localizedOwnError('acp', 'Refresh available ACP models first', locale)).toBe('Refresh available ACP models first');
  }
});

it('covers every mapped Rust error without dropping supplied diagnostics', () => {
  const sensitiveWordCases = [
    ['Cloud rule file exceeds 1 MiB', 'O arquivo de regras da nuvem excede 1 MiB.'],
    ['Rule file must contain antigravity or devin', 'O arquivo de regras deve conter uma seção antigravity ou devin.'],
    ['Rule file may contain at most 2000 entries', 'O arquivo de regras pode conter no máximo 2.000 entradas.'],
    ['Invalid rule JSON: example', 'O JSON do arquivo de regras é inválido. (Invalid rule JSON: example)'],
  ];
  const tlsCases = [
    ['Certificate file does not exist: ', 'O arquivo de certificado não existe: '],
    ['Failed to read certificate file ', 'Não foi possível ler o arquivo de certificado '],
    ['Failed to parse certificate PEM in ', 'Não foi possível ler o certificado PEM em '],
    ['No certificates found in ', 'Nenhum certificado encontrado em '],
    ['Private key file does not exist: ', 'O arquivo de chave privada não existe: '],
    ['Failed to read private key file ', 'Não foi possível ler o arquivo de chave privada '],
    ['Failed to parse private key PEM in ', 'Não foi possível ler a chave privada PEM em '],
    ['No private key found in ', 'Nenhuma chave privada encontrada em '],
    ['Invalid TLS certificate/key configuration: ', 'Configuração inválida do certificado ou da chave TLS: '],
  ];
  const wordsRust = rustSource('sensitive_words.rs');
  const tlsRust = rustSource('reverse_proxy.rs');
  for (const [message, translated] of sensitiveWordCases) {
    const producer = message.replace(/: example$/, ':');
    expect(wordsRust.includes(`"${producer}`)).toBe(true);
    expect(localizedOwnError('sensitiveWords', message, 'pt-BR')).toBe(translated);
  }
  for (const [prefix, translation] of tlsCases) {
    const details = "C:/demo/key.pem: example diagnostic";
    expect(tlsRust.includes(`"${prefix}`)).toBe(true);
    expect(localizedOwnError('reverseProxyTls', new Error(prefix + details), 'pt-BR')).toBe(translation + details);
  }
  expect(rustSource('acp/mod.rs').includes('"Refresh available ACP models first"')).toBe(true);
});

function rustSource(relativePath: string): string {
  return readFileSync(new URL(`../src-tauri/src/${relativePath}`, import.meta.url), 'utf8');
}
