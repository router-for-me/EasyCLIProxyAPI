import { expect, test } from 'bun:test';
import { privateAccountLabel } from '../src/services/accountPrivacy';

test('aliases remain stable across refresh, priority changes and auth-index rotation', () => {
  const file={name:'alice@example.com.json',auth_index:'old',priority:1};
  const alias=privateAccountLabel(file,'claude');
  expect(privateAccountLabel({...file,auth_index:'new',priority:9},'claude')).toBe(alias);
  expect(alias).not.toContain('alice');
  expect(alias).not.toContain('@');
  expect(privateAccountLabel({...file,name:'bob@example.com.json'},'claude')).not.toBe(alias);
  expect(privateAccountLabel(file,'codex')).not.toBe(alias);
});

test('aliases are deterministic across reordering and independent calls', () => {
  const files=Array.from({length:1000},(_,i)=>({name:`account-${i}.json`}));
  const before=files.map(file=>privateAccountLabel(file,'kimi'));
  expect(new Set(before).size).toBe(files.length);
  expect([...files].reverse().map(file=>privateAccountLabel(file,'kimi')).reverse()).toEqual(before);
  expect(privateAccountLabel({authIndex:42},'kimi')).toBe(privateAccountLabel({auth_index:'42'},'kimi'));
});
