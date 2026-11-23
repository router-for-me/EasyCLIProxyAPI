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
  it('covers every English message with the same variables', () => {
    const english = flatten(en as Tree);
    const portuguese = flatten(ptBR as Tree);
    expect(Object.keys(portuguese).sort()).toEqual(Object.keys(english).sort());
    for (const [key, value] of Object.entries(english)) {
      expect(portuguese[key].trim()).not.toBe('');
      expect({ key, variables: variables(portuguese[key]) }).toEqual({ key, variables: variables(value) });
    }
  });

  it('selects the PT-BR document messages instead of English', () => {
    const english = configDocumentMessages('en');
    const portuguese = configDocumentMessages('pt-BR');
    expect(Object.keys(portuguese).sort()).toEqual(Object.keys(english).sort());
    expect(portuguese.reconnect).toBe('Reconectar');
    expect(portuguese).not.toBe(english);
  });
});
