import { useId, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, Undo2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { templateText } from '../i18n/templateConfig';
import { configRecord, defaultStructuredValue, type ConfigShape, type ConfigText } from '../services/structuredConfig';
import { SettingsHelp } from './SettingsHelp';
import './StructuredConfigEditor.css';

export function useConfigText() {
  const { locale } = useI18n();
  return (value: ConfigText | undefined): string => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return templateText(value, locale);
  };
}

type Props = { shape: ConfigShape; value: unknown; onChange: (value: unknown) => void; disabled?: boolean; id?: string };
export function StructuredConfigEditor({ shape, value, onChange, disabled = false, id: providedId }: Props) {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const tx = useConfigText();
  const [newKey, setNewKey] = useState('');
  const [keyError, setKeyError] = useState('');
  const addText = tx({ zh: '添加', en: 'Add', ja: '追加' });
  const removeText = tx({ zh: '删除', en: 'Remove', ja: '削除' });
  const inheritText = tx({ zh: '继承 / 未设置', en: 'Inherit / not set', ja: '継承 / 未設定' });
  const label = tx(shape.label) || id;

  if (shape.type === 'any') {
    const current = Array.isArray(value) ? 'array' : configRecord(value) ? 'map' : value === null ? 'null' : typeof value;
    const types = {
      string: { zh: '文本', en: 'Text', ja: 'テキスト' },
      number: { zh: '数值', en: 'Number', ja: '数値' },
      boolean: { zh: '布尔值', en: 'Boolean', ja: '真偽値' },
      null: { zh: '空值', en: 'Null', ja: '空値' },
      array: { zh: '列表', en: 'List', ja: 'リスト' },
      map: { zh: '对象', en: 'Object', ja: 'オブジェクト' },
    };
    return <div className="structured-any">
      <select className="select-input" aria-label={`${label} ${tx({ zh: '类型', en: 'type', ja: 'の型' })}`} value={current} disabled={disabled}
        onChange={event => onChange(({ string: '', number: 0, boolean: false, null: null, array: [], map: {} } as Record<string, unknown>)[event.currentTarget.value])}>
        {Object.entries(types).map(([type, text]) => <option key={type} value={type}>{tx(text)}</option>)}
      </select>
      {current !== 'null' && <StructuredConfigEditor shape={{ type: current as ConfigShape['type'], item: { type: 'any' }, label: shape.label, integer: false }} value={value} onChange={onChange} disabled={disabled} id={id} />}
    </div>;
  }
  if (shape.type === 'array') {
    const rows = Array.isArray(value) ? value : [];
    const item = shape.item ?? { type: 'any' };
    const update = (index: number, next: unknown) => onChange(rows.map((row, i) => i === index ? next : row));
    const move = (index: number, delta: number) => {
      const next = [...rows];
      [next[index], next[index + delta]] = [next[index + delta], next[index]];
      onChange(next);
    };
    return <div className="structured-list">
      {rows.map((row, index) => <div className="structured-list-item" key={index}>
        <div className="structured-list-toolbar"><span>{index + 1}</span><div>
          <button type="button" className="icon-button quiet" disabled={disabled || index === 0} onClick={() => move(index, -1)} aria-label={tx({ zh: '上移', en: 'Move up', ja: '上へ' })}><ArrowUp size={14} /></button>
          <button type="button" className="icon-button quiet" disabled={disabled || index === rows.length - 1} onClick={() => move(index, 1)} aria-label={tx({ zh: '下移', en: 'Move down', ja: '下へ' })}><ArrowDown size={14} /></button>
          <button type="button" className="icon-button quiet" disabled={disabled} onClick={() => onChange(rows.filter((_, i) => i !== index))} aria-label={`${removeText} ${index + 1}`}><Trash2 size={14} /></button>
        </div></div>
        <StructuredConfigEditor shape={{ ...item, label: item.label ?? `${label} ${index + 1}` }} value={row} onChange={next => update(index, next)} disabled={disabled} id={`${id}-${index}`} />
      </div>)}
      <button type="button" className="secondary-button structured-add" disabled={disabled} onClick={() => onChange([...rows, defaultStructuredValue(item)])}><Plus size={14} />{addText}</button>
    </div>;
  }
  if (shape.type === 'object') {
    const record = configRecord(value) ? value : {};
    const update = (key: string, next: unknown) => {
      const result = { ...record };
      if (next === undefined) delete result[key]; else result[key] = next;
      onChange(result);
    };
    return <div className="structured-object">
      {Object.entries(shape.fields ?? {}).map(([key, field]) => <div key={key} className={`structured-field${['array', 'map', 'object', 'any'].includes(field.type) ? ' structured-field-wide' : ''}`}>
        <div className="structured-label"><label htmlFor={`${id}-${key}`}>{tx(field.label) || key}</label>
          {field.hint && <SettingsHelp label={tx(field.label) || key}>{tx(field.hint)}</SettingsHelp>}
          {field.optional && record[key] !== undefined && <button type="button" className="icon-button quiet" disabled={disabled} onClick={() => update(key, undefined)} title={inheritText} aria-label={`${inheritText}: ${tx(field.label) || key}`}><Undo2 size={13} /></button>}
        </div>
        {field.optional && record[key] == null ? <button type="button" className="secondary-button structured-unset" disabled={disabled} aria-label={`${tx(field.label) || key}: ${inheritText}`} onClick={() => update(key, defaultStructuredValue(field))}>{inheritText} · {tx({ zh: '设置', en: 'Set', ja: '設定' })}</button>
          : <StructuredConfigEditor shape={field} value={record[key]} onChange={next => update(key, next)} disabled={disabled} id={`${id}-${key}`} />}
      </div>)}
    </div>;
  }
  if (shape.type === 'map') {
    const record = configRecord(value) ? value : {};
    const item = shape.item ?? { type: 'any' };
    return <div className="structured-map">
      {Object.entries(record).map(([key, entry]) => <div className="structured-map-item" key={key}>
        <div className="structured-map-key"><strong>{key}</strong><button type="button" className="icon-button quiet" disabled={disabled} aria-label={`${removeText} ${key}`} onClick={() => {
          const next = { ...record }; delete next[key]; onChange(next);
        }}><Trash2 size={14} /></button></div>
        <StructuredConfigEditor shape={{ ...item, label: item.label ?? key }} value={entry} onChange={next => onChange({ ...record, [key]: next })} disabled={disabled} id={`${id}-${key}`} />
      </div>)}
      <div className="structured-map-add"><input className="text-input" aria-label={tx({ zh: '新字段名称', en: 'New field name', ja: '新しいフィールド名' })} value={newKey} disabled={disabled} placeholder={tx({ zh: '字段 / 通道名称', en: 'Field / channel name', ja: 'フィールド / チャンネル名' })}
        onChange={event => { setNewKey(event.currentTarget.value); setKeyError(''); }} />
        <button type="button" className="secondary-button" disabled={disabled || !newKey.trim()} onClick={() => {
          const key = newKey.trim();
          if (Object.prototype.hasOwnProperty.call(record, key) || ['__proto__', 'prototype', 'constructor'].includes(key)) { setKeyError(tx({ zh: '名称已存在或不可使用', en: 'Name already exists or is not allowed', ja: 'この名前は使用できません' })); return; }
          onChange({ ...record, [key]: defaultStructuredValue(item) }); setNewKey('');
        }}><Plus size={14} />{addText}</button></div>
      {keyError && <p role="alert" className="structured-error">{keyError}</p>}
    </div>;
  }
  if (shape.type === 'boolean' || shape.type === 'select') {
    const options = shape.type === 'boolean' ? [true, false] : shape.options ?? [];
    return <select id={id} className="select-input" aria-label={label} disabled={disabled} value={String(value)} onChange={event => onChange(options.find(option => String(option) === event.currentTarget.value))}>
      {!options.some(option => option === value) && <option value={String(value)}>{String(value ?? '')}</option>}
      {options.map(option => <option value={String(option)} key={String(option)}>{option === true ? tx({ zh: '启用', en: 'Enabled', ja: '有効' }) : option === false ? tx({ zh: '禁用', en: 'Disabled', ja: '無効' }) : String(option)}</option>)}
    </select>;
  }
  return <input id={id} aria-label={label} className="text-input" type={shape.secret ? 'password' : shape.type === 'number' ? 'number' : 'text'} autoComplete="off" spellCheck={false} disabled={disabled}
    min={shape.min} max={shape.max} step={shape.type === 'number' ? shape.integer === false ? 'any' : 1 : undefined} value={typeof value === 'string' || typeof value === 'number' ? value : ''}
    onChange={event => { const text = event.currentTarget.value; onChange(shape.type === 'number' && text !== '' && Number.isFinite(Number(text)) ? Number(text) : text); }} />;
}
