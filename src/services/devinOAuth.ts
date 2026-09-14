export const validateDevinCallback = (
  input: string,
  expectedState?: string,
): 'invalid' | 'state_mismatch' | undefined => {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return 'invalid';
  }
  const params = url.searchParams;
  if (!['http:', 'https:'].includes(url.protocol)
    || params.getAll('state').length !== 1
    || !params.get('state')?.trim()
    || !['code', 'error', 'error_description'].some((key) => params.get(key)?.trim())) {
    return 'invalid';
  }
  if (!expectedState || params.get('state') !== expectedState) return 'state_mismatch';
  return undefined;
};
