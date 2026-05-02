'use client';
import { useState, useEffect, useCallback } from 'react';

export interface BannerSettings {
  enabled:          boolean;
  minScore:         number;   // 62 = BUY+, 78 = STRONG_BUY only
  dismissAfterSec:  number;   // 0 = manual dismiss only
  positionSizeUsd:  number;   // default buy size in USD
  autoBuy:          boolean;  // execute buy automatically on signal (default OFF)
  autoSell:         boolean;  // execute sell at T1 automatically (default OFF)
  sound:            boolean;  // play beep on signal
}

const DEFAULTS: BannerSettings = {
  enabled:         true,
  minScore:        78,
  dismissAfterSec: 45,
  positionSizeUsd: 10,
  autoBuy:         false,
  autoSell:        false,
  sound:           true,
};

const KEY = 'qwai:banner_settings';

function load(): BannerSettings {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

function save(s: BannerSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
}

export function useBannerSettings() {
  const [settings, setSettingsState] = useState<BannerSettings>(DEFAULTS);

  // Hydrate from localStorage after mount (SSR safe)
  useEffect(() => { setSettingsState(load()); }, []);

  const setSettings = useCallback((patch: Partial<BannerSettings>) => {
    setSettingsState((prev) => {
      const next = { ...prev, ...patch };
      save(next);
      return next;
    });
  }, []);

  return { settings, setSettings };
}
