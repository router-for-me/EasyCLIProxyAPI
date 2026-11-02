import { Boxes } from 'lucide-react';
import openai from '../assets/icons/openai-light.svg';
import codex from '../assets/icons/codex.svg';
import claude from '../assets/icons/claude.svg';
import gemini from '../assets/icons/gemini.svg';
import deepseek from '../assets/icons/deepseek.svg';
import kimi from '../assets/icons/kimi-light.svg';
import antigravity from '../assets/icons/antigravity.svg';
import copilot from '../assets/icons/copilot.svg';
import zcode from '../assets/icons/zcode.png';
import opencode from '../assets/icons/opencode.svg';
import pi from '../assets/icons/pi-logo-on-light.svg';
import vertex from '../assets/icons/vertex.svg';
import devin from '../assets/icons/devin.svg';
import meta from '../assets/icons/meta.svg';

const brands: [RegExp, string][] = [
  [/codex|mcode/i, codex], [/claude|anthropic/i, claude], [/gemini/i, gemini],
  [/deepseek/i, deepseek], [/kimi/i, kimi], [/antigravity/i, antigravity],
  [/copilot/i, copilot], [/zcode/i, zcode], [/opencode/i, opencode],
  [/\b(pi|omp)\b/i, pi], [/vertex/i, vertex], [/devin/i, devin],
  [/meta|llama/i, meta], [/openai|gpt|\bo[134]\b/i, openai],
];

export function BrandIcon({ name, size = 18 }: { name: string; size?: number }) {
  const icon = brands.find(([pattern]) => pattern.test(name))?.[1];
  return icon ? <img src={icon} width={size} height={size} alt="" aria-hidden="true" /> : <Boxes size={size} aria-hidden="true" />;
}
