import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { HomeAccessPanel } from '../src/pages/HomeAccessPanel';
import { I18nProvider } from '../src/i18n';
import { Tabs } from '../src/components/Tabs';
import { SegmentedControl } from '../src/components/SegmentedControl';

const items = ['one', 'two'].map(value => ({ value, id: `tab-${value}`, panelId: 'panel', label: value }));
const isChoiceOwner = (name: string) => ['components/Tabs.tsx', 'components/SegmentedControl.tsx'].includes(name.replaceAll('\\', '/'));
const violations = (text: string, name: string) => {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const collect = (node: ts.Node) => {
    if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      && ['tablist', 'tab', 'radiogroup', 'radio'].includes(node.text)) found.push(node.text);
    ts.forEachChild(node, collect);
  };
  const propertyName = (name: ts.PropertyName) => ts.isComputedPropertyName(name)
    ? ts.isStringLiteralLike(name.expression) ? name.expression.text : undefined
    : ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'role' && node.initializer) collect(node.initializer);
    if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'role') collect(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

describe('shared choice controls', () => {
  it('exposes vertical navigation for settings categories', () => {
    const html = renderToStaticMarkup(<Tabs items={items} value="one" onChange={() => {}} orientation="vertical" />);
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).not.toContain('orientation="vertical" role');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });
  it('classifies Windows choice owner paths like POSIX paths', () => {
    expect(isChoiceOwner('components\\Tabs.tsx')).toBe(true);
    expect(isChoiceOwner('components\\SegmentedControl.tsx')).toBe(true);
    expect(isChoiceOwner('pages\\Example.tsx')).toBe(false);
  });

  it('links tabs to panels and keeps one selected tab stop', () => {
    const html = renderToStaticMarkup(<Tabs items={items} value="two" onChange={() => {}} aria-label="Tabs" />);
    for (const fragment of ['role="tablist"', 'aria-orientation="horizontal"', 'id="tab-two"', 'aria-controls="panel"', 'aria-label="Tabs"']) expect(html).toContain(fragment);
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });
  it('uses one radio semantic for all segments and forwards labels and disabled states', () => {
    const html = renderToStaticMarkup(<SegmentedControl items={items} value="two" onChange={() => {}} disabled aria-labelledby="label" aria-describedby="hint" buttonClassName="segment" selectedClassName="selected" />);
    for (const fragment of ['role="radiogroup"', 'aria-labelledby="label"', 'aria-describedby="hint"', 'class="segment selected"']) expect(html).toContain(fragment);
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain('aria-pressed');
  });
  it('selects the displayed fallback protocol when OpenAI is unavailable', () => {
    const html = renderToStaticMarkup(<I18nProvider><HomeAccessPanel profiles={[{ id: 'claude', name: 'Claude', description: '', baseUrl: '/mock' }]}
      apiKey={null} keyError={false} ready copiedField="" onCopy={async () => {}} /></I18nProvider>);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-labelledby="home-protocol-claude"');
    expect(html).toContain('tabindex="0"');
  });
  it('keeps exactly one available tab stop for missing or disabled values', () => {
    for (const Component of [Tabs, SegmentedControl]) for (const value of ['missing', 'one']) {
      const html = renderToStaticMarkup(<Component items={[{ ...items[0], disabled: true }, items[1]]} value={value} onChange={() => {}} />);
      expect(html.match(/tabindex="0"/g)).toHaveLength(1);
      expect(html).toMatch(/(?:id="tab-two"|data-value="two")[^>]*tabindex="0"/);
    }
  });
  it('detects recursive role expressions and object properties without flagging panel ownership', () => {
    for (const role of ['tablist', 'tab', 'radiogroup', 'radio']) {
      const examples = [
        `<div role="${role}"/>`, `<div role={"${role}"}/>`, `<div role={\`${role}\`}/>`,
        `<div role={condition ? '${role}' : undefined}/>`, `<div role={condition && '${role}'}/>`,
        `<div role={condition || ('${role}')}/>`, `<div role={\`\${condition ? '${role}' : ''}\`}/>`,
        `<div {...{role: '${role}'}}/>`, `<div {...{...{role: condition && '${role}'}}}/>`,
        `createElement('div', { role: condition ? '${role}' : undefined })`,
        `React.createElement('div', { ...{ role: '${role}' } })`, `const props = { ['role']: '${role}' };`,
      ];
      for (const source of examples) expect(violations(source, 'example.tsx')).toEqual([role]);
    }
    for (const source of [
      `<div role={condition ? 'tabpanel' : undefined}/>`, `<div role={condition && 'group'}/>`,
      `<div {...{...{role: 'option'}}}/>`, `createElement('div', { role: 'tabpanel' })`,
      `const props = { title: 'tab', description: 'radio' };`, `<div title="tablist"/>`,
    ]) expect(violations(source, 'example.tsx')).toEqual([]);
  });
  it('owns every tab and radio implementation without exceptions', () => {
    const root = join(import.meta.dir, '../src');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
    expect(files(root).flatMap(file => {
      const name = relative(root, file).replaceAll('\\', '/');
      return isChoiceOwner(name) ? [] : violations(readFileSync(file, 'utf8'), name).map(role => `${name}: ${role}`);
    })).toEqual([]);
  });
});
