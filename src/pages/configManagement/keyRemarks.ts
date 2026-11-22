import { createContext } from 'react';

export const KeyRemarksContext = createContext<{
  get: (key: string) => string | undefined;
  set: (key: string, remark: string) => void;
} | null>(null);
