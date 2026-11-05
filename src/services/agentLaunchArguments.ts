export const hasDeepSeekArgumentConflict = (arguments_: string[]) => arguments_.some((argument) =>
  ['--profile', '--patch', '--host', '--port', '--trusted-host', '--no-open', '--open'].includes(argument.split('=')[0]));

export function parseAgentLaunchArguments(source: string): string[] | null {
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(source)) return null;
  const result: string[] = [];
  let value = '';
  let started = false;
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\0') return null;
    if (quote === "'") {
      if (character === "'") quote = '';
      else value += character;
    } else if (character === '\\') {
      started = true;
      const next = source[index + 1];
      if (next === undefined) return null;
      if (quote === '"' && !['$', '`', '"', '\\', '\n'].includes(next)) value += character;
      else {
        index += 1;
        if (next !== '\n') { value += next; started = true; }
      }
    } else if (quote === '"') {
      if (character === '"') quote = '';
      else value += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (' \t\n'.includes(character)) {
      if (started) result.push(value);
      value = '';
      started = false;
    } else if (character === '#' && !started) {
      while (index < source.length && source[index] !== '\n') index += 1;
    } else {
      value += character;
      started = true;
    }
  }
  if (quote) return null;
  if (started) result.push(value);
  return result;
}

