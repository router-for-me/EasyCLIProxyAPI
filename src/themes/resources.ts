const assetNamePattern = '^[a-zA-Z][a-zA-Z0-9-]{0,31}$';
export const themeAssetPathPattern = '^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*\\\\).+\\.(?:png|jpe?g|webp|svg|avif)$';

export function isThemeAssetPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (!new RegExp(themeAssetPathPattern, 'i').test(value)) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function isThemeImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 11_184_840
    && /^data:image\/(?:png|jpeg|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function normalizeThemeAssets(
  input: unknown,
  report: (field: string) => void,
): Readonly<Record<string, string>> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const assets: Record<string, string> = {};
  for (const [name, path] of Object.entries(input)) {
    if (!new RegExp(assetNamePattern).test(name) || !isThemeAssetPath(path)) report(name);
    else assets[name] = path;
  }
  return Object.keys(assets).length ? Object.freeze(assets) : undefined;
}
