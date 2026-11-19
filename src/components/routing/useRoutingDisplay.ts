import { useCallback, useState } from 'react';
import { usagePreferences } from '../../services/usagePreferences';
import { parseRoutingDisplay, type RoutingDisplay } from '../../services/usageRoutingView';

const KEY = 'cpa-gui.usage-routing-display.v1';
export function useRoutingDisplay(): [RoutingDisplay, (display: RoutingDisplay) => void] {
  const [display, setDisplay] = useState(() => parseRoutingDisplay(usagePreferences.getItem(KEY)));
  const update = useCallback((next: RoutingDisplay) => {
    setDisplay(next);
    usagePreferences.setItem(KEY, JSON.stringify(next));
  }, []);
  return [display, update];
}
