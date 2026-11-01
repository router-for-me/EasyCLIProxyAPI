import { useEffect, useRef, useState } from 'react';

export function usePresence<Item extends { id: string }>(items: Item[]) {
  const [rows, setRows] = useState<{ item: Item; exiting: boolean }[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const wanted = new Set(items.map(item => item.id));
    for (const item of items) {
      const timer = timers.current.get(item.id);
      if (timer) { clearTimeout(timer); timers.current.delete(item.id); }
    }
    setRows(previous => [...items.map(item => ({ item, exiting: false })), ...previous.filter(row => !wanted.has(row.item.id)).map(row => ({ ...row, exiting: true }))]);
  }, [items]);
  useEffect(() => {
    for (const row of rows) {
      if (!row.exiting || timers.current.has(row.item.id)) continue;
      const id = row.item.id;
      timers.current.set(id, setTimeout(() => {
        timers.current.delete(id);
        setRows(previous => previous.filter(row => row.item.id !== id || !row.exiting));
      }, 250));
    }
  }, [rows]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); }, []);
  return rows;
}
