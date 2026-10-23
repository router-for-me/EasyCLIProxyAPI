import { themeTokenKinds, themeTokenSchema } from './tokenContract';
import { themeAssetPathPattern } from './resources';

const themeLabel = {
  oneOf: [
    { type: 'string', minLength: 1, maxLength: 80 },
    {
      type: 'object',
      minProperties: 1,
      propertyNames: { enum: ['zh-CN', 'zh-TW', 'ja', 'en'] },
      additionalProperties: { type: 'string', minLength: 1, maxLength: 80 },
    },
  ],
};

export function buildThemeSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'EasyCLIProxyAPI theme',
    description: 'A theme loaded from <app data>/themes/<folder>/theme.json.',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'id', 'name', 'appearance', 'windowBackground', 'tokens'],
    properties: {
      $schema: { type: 'string' },
      schemaVersion: { const: 1 },
      id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$' },
      name: themeLabel,
      description: themeLabel,
      appearance: { enum: ['light', 'dark'] },
      windowBackground: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
      windowMaterial: { enum: ['solid', 'translucent'] },
      icon: {
        type: 'string',
        description: 'Relative path inside the theme folder to a png, jpg, jpeg, webp, svg or avif icon.',
        pattern: themeAssetPathPattern,
      },
      assets: {
        type: 'object',
        description: 'Named relative paths inside the theme folder. backdropImage displays a PNG, JPEG, WebP or AVIF background (up to 8 MiB); other entries are reserved.',
        propertyNames: { pattern: '^[a-zA-Z][a-zA-Z0-9-]{0,31}$' },
        additionalProperties: { type: 'string', pattern: themeAssetPathPattern },
      },
      backdrop: {
        type: 'object',
        additionalProperties: false,
        required: ['layers', 'sidebar', 'panel'],
        properties: {
          layers: {
            type: 'array',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              required: ['kind', 'stops'],
              properties: {
                kind: { enum: ['linear', 'radial'] },
                angle: { type: 'number', minimum: 0, maximum: 360 },
                center: { type: 'array', items: { type: 'number', minimum: 0, maximum: 100 }, minItems: 2, maxItems: 2 },
                size: { type: 'array', items: { type: 'number', minimum: 1, maximum: 200 }, minItems: 2, maxItems: 2 },
                stops: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 8,
                  items: {
                    type: 'object',
                    required: ['color', 'at'],
                    properties: {
                      color: { type: 'string', pattern: themeTokenKinds.color.schema.pattern },
                      at: { type: 'number', minimum: 0, maximum: 100 },
                    },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
          },
          sidebar: { type: 'string', pattern: themeTokenKinds.color.schema.pattern },
          panel: { type: 'string', pattern: themeTokenKinds.color.schema.pattern },
          inset: { type: 'string', pattern: themeTokenKinds.color.schema.pattern },
          hover: { type: 'string', pattern: themeTokenKinds.color.schema.pattern },
          imagePosition: { type: 'array', items: { type: 'number', minimum: 0, maximum: 100 }, minItems: 2, maxItems: 2 },
        },
      },
      tokens: {
        type: 'object',
        additionalProperties: false,
        description: 'Appearance tokens. Sizes, spacing, layout and typography are not themeable.',
        properties: themeTokenSchema(),
      },
    },
  };
}

export function themeSchemaJson(): string {
  return `${JSON.stringify(buildThemeSchema(), null, 2)}\n`;
}
