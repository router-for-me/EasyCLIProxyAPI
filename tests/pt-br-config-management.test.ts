import { describe, expect, it } from 'bun:test';
import en from '../src/pages/configManagement/en.json';
import ptBR from '../src/pages/configManagement/pt-BR.json';
import { configDocumentMessages } from '../src/pages/configManagement/configDocumentMessages';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [[path, value]] : Object.entries(flatten(value, path));
  }));
}

const variables = (value: string) => [...value.matchAll(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g)].map(match => match[1] ?? match[2]).sort();

describe('PT-BR configuration management', () => {
  it('uses only known English keys with the same variables (missing keys fall back to English)', () => {
    const english = flatten(en as Tree);
    const portuguese = flatten(ptBR as Tree);
    expect(Object.keys(portuguese).filter((key) => !(key in english))).toEqual([]);
    for (const [key, value] of Object.entries(portuguese)) {
      expect(value.trim()).not.toBe('');
      expect({ key, variables: variables(value) }).toEqual({ key, variables: variables(english[key]) });
    }
  });

  it('selects the PT-BR document messages instead of English', () => {
    const english = configDocumentMessages('en');
    const portuguese = configDocumentMessages('pt-BR');
    expect(Object.keys(portuguese).sort()).toEqual(Object.keys(english).sort());
    expect(portuguese.reconnect).toBe('Reconectar');
    expect(portuguese).not.toBe(english);
    for (const key of Object.keys(english) as (keyof typeof english)[]) expect(portuguese[key].trim()).not.toBe('');
  });
});
