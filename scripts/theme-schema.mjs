import { writeFileSync } from 'node:fs';
import { themeSchemaJson } from '../src/themes/themeSchema.ts';

writeFileSync(new URL('../theme.schema.json', import.meta.url), themeSchemaJson());
