import { useMemo, useRef, useState, type ReactNode } from 'react';
import CodeMirror, { EditorView, Text, type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';
import { SearchQuery } from '@codemirror/search';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import { useResolvedThemeId, useThemeRegistry } from '../../../theme';
import { useTranslation } from '../translation';

const extensions = [yaml(), EditorView.contentAttributes.of({ 'aria-label': 'YAML', spellcheck: 'false' })];
const basicSetup = { autocompletion: false, completionKeymap: false };

export function ConfigSourceEditor({ value, onChange, modeSwitch, validationNotice, readOnly }: {
  value: string;
  onChange: (value: string) => void;
  modeSwitch: ReactNode;
  validationNotice: ReactNode;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const registry = useThemeRegistry();
  const themeId = useResolvedThemeId();
  const theme = registry.get(themeId)?.appearance === 'dark' ? 'dark' : 'light';
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(-1);
  const editor = useRef<ReactCodeMirrorRef>(null);
  const matches = useMemo(() => {
    if (!query) return [];
    const cursor = new SearchQuery({ search: query, literal: true }).getCursor(Text.of(value.split('\n')));
    const results: { from: number; to: number }[] = [];
    for (let match = cursor.next(); !match.done; match = cursor.next()) results.push(match.value);
    return results;
  }, [query, value]);

  const find = (direction: 1 | -1) => {
    const view = editor.current?.view;
    if (!view || !matches.length) return;
    const index = activeMatch < 0 ? (direction === 1 ? 0 : matches.length - 1) : (activeMatch + direction + matches.length) % matches.length;
    const { from, to } = matches[index];
    setActiveMatch(index);
    view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) });
    view.focus();
  };

  const searchLabel = t('config_management.search_placeholder');
  const searchCount = matches.length ? `${activeMatch < 0 ? matches.length : `${activeMatch + 1} / ${matches.length}`}` : t('config_management.search_no_results');
  return <>
    <div className="mock-config-toolbar">
      <div className="mock-config-source-search">
        <div className="mock-config-source-query">
          <input className="input" type="search" value={query} aria-label={searchLabel} placeholder={searchLabel}
            onChange={(event) => { setQuery(event.target.value); setActiveMatch(-1); }} onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); find(event.shiftKey ? -1 : 1); }
            }} />
          <div className="mock-config-source-query-actions">
            <span role="status">{query && searchCount}</span>
            <button type="button" disabled={!matches.length} onClick={() => find(1)} aria-label={t('config_management.search_button')}><Search size={15} aria-hidden="true" /></button>
          </div>
        </div>
        <button type="button" className="secondary-button" disabled={!matches.length} onClick={() => find(-1)} aria-label={t('config_management.search_prev')} title={t('config_management.search_prev')}><ChevronUp size={16} aria-hidden="true" /></button>
        <button type="button" className="secondary-button" disabled={!matches.length} onClick={() => find(1)} aria-label={t('config_management.search_next')} title={t('config_management.search_next')}><ChevronDown size={16} aria-hidden="true" /></button>
      </div>
      {modeSwitch}
    </div>
    {validationNotice}
    <div className="mock-config-code">
      <CodeMirror ref={editor} value={value} height="100%" style={{ height: '100%' }} theme={theme}
        placeholder={t('config_management.editor_placeholder')} extensions={extensions} basicSetup={basicSetup} readOnly={readOnly} editable={!readOnly}
        onChange={(text) => { setActiveMatch(-1); onChange(text); }} />
    </div>
  </>;
}
