import { invoke } from '@tauri-apps/api/core';
import { isRecord, readString } from './managementApi';

export type PluginTranslationModel = {
  name: string;
  displayName?: string;
};

type TranslationCacheEntry = { value: string; updatedAt: number };

const MODEL_KEY = 'easy-cli-proxy-api.plugin-translation-model.v1';
const CACHE_KEY = 'easy-cli-proxy-api.plugin-translation-cache.v1';
const MAX_CACHE_ENTRIES = 100;
const MAX_TRANSLATION_CHUNK_CHARS = 12_000;
const memoryCache = new Map<string, TranslationCacheEntry>();
const MAX_CONCURRENT_TRANSLATIONS = 3;
let availableTranslationSlots = MAX_CONCURRENT_TRANSLATIONS;
const translationWaiters: Array<() => void> = [];

async function acquireTranslationSlot(): Promise<void> {
  if (availableTranslationSlots > 0) {
    availableTranslationSlots -= 1;
    return;
  }
  await new Promise<void>(resolve => translationWaiters.push(resolve));
}

function releaseTranslationSlot(): void {
  const next = translationWaiters.shift();
  if (next) next();
  else availableTranslationSlots += 1;
}

async function withTranslationSlot<T>(task: () => Promise<T>): Promise<T> {
  await acquireTranslationSlot();
  try {
    return await task();
  } finally {
    releaseTranslationSlot();
  }
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cacheKey(text: string, model: string, targetLocale: string): string {
  return `${targetLocale}:${model}:${hashText(text)}`;
}

export function splitTranslationChunks(text: string, maxChars = MAX_TRANSLATION_CHUNK_CHARS): string[] {
  const source = text.trim();
  if (!source) return [];
  if (Array.from(source).length <= maxChars) return [source];
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = '';
  };
  for (const paragraph of source.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (Array.from(candidate).length <= maxChars) {
      current = candidate;
      continue;
    }
    flush();
    if (Array.from(paragraph).length <= maxChars) {
      current = paragraph;
      continue;
    }
    let buffer = '';
    for (const line of paragraph.split('\n')) {
      const next = buffer ? `${buffer}\n${line}` : line;
      if (Array.from(next).length <= maxChars) {
        buffer = next;
        continue;
      }
      if (buffer) chunks.push(buffer);
      buffer = '';
      let remaining = Array.from(line);
      while (remaining.length > maxChars) {
        chunks.push(remaining.slice(0, maxChars).join(''));
        remaining = remaining.slice(maxChars);
      }
      buffer = remaining.join('');
    }
    current = buffer;
  }
  flush();
  return chunks;
}

function readCache(): Record<string, TranslationCacheEntry> {
  const saved = storage()?.getItem(CACHE_KEY);
  if (!saved) return {};
  try {
    const parsed = JSON.parse(saved) as unknown;
    if (!isRecord(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) =>
      isRecord(value) && typeof value.value === 'string' && typeof value.updatedAt === 'number')) as Record<string, TranslationCacheEntry>;
  } catch {
    return {};
  }
}

function writeCachedTranslation(key: string, value: string): void {
  const entry = { value, updatedAt: Date.now() };
  memoryCache.set(key, entry);
  const localStorage = storage();
  if (!localStorage) return;
  const cache = readCache();
  cache[key] = entry;
  const bounded = Object.entries(cache)
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_CACHE_ENTRIES);
  localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(bounded)));
}

function readCachedTranslation(key: string): string {
  const memory = memoryCache.get(key);
  if (memory) return memory.value;
  const saved = readCache()[key];
  if (!saved) return '';
  memoryCache.set(key, saved);
  return saved.value;
}

export function pluginTextNeedsChinese(text: string, locale: string): boolean {
  if (!/^zh/i.test(locale)) return false;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  return latin > 0 && (cjk === 0 || (latin >= 12 && latin > cjk));
}

export function savedPluginTranslationModel(): string {
  return storage()?.getItem(MODEL_KEY)?.trim() ?? '';
}

export function rememberPluginTranslationModel(model: string): void {
  const value = model.trim();
  if (value) storage()?.setItem(MODEL_KEY, value);
}

export async function loadPluginTranslationModels(): Promise<PluginTranslationModel[]> {
  const payload = await invoke<unknown>('get_core_models');
  if (!Array.isArray(payload)) throw new Error('Invalid core model list response');
  const models = new Map<string, PluginTranslationModel>();
  for (const item of payload) {
    if (!isRecord(item)) continue;
    const name = readString(item, 'name').trim();
    if (!name || models.has(name)) continue;
    const displayName = readString(item, 'displayName').trim();
    models.set(name, { name, ...(displayName ? { displayName } : {}) });
  }
  return [...models.values()].sort((left, right) =>
    (left.displayName || left.name).localeCompare(right.displayName || right.name, undefined, { sensitivity: 'base' }));
}

export async function translatePluginText(
  text: string,
  model: string,
  locale: string,
): Promise<string> {
  const source = text.trim();
  const selectedModel = model.trim();
  if (!source) throw new Error('Translation text is empty');
  if (!selectedModel) throw new Error('Select a translation model');
  const targetLocale = locale === 'zh-TW' ? 'zh-TW' : 'zh-CN';
  const key = cacheKey(source, selectedModel, targetLocale);
  const cached = readCachedTranslation(key);
  if (cached) return cached;
  const translatedChunks: string[] = [];
  for (const chunk of splitTranslationChunks(source)) {
    const value = await withTranslationSlot(() => invoke<unknown>('translate_plugin_text', {
      text: chunk,
      model: selectedModel,
      targetLanguage: targetLocale,
    }));
    const translation = typeof value === 'string' ? value.trim() : '';
    if (!translation) throw new Error('Invalid translation response');
    translatedChunks.push(translation);
  }
  const translation = translatedChunks.join('\n\n');
  writeCachedTranslation(key, translation);
  return translation;
}

export function clearPluginTranslationCache(): void {
  memoryCache.clear();
  storage()?.removeItem(CACHE_KEY);
}
