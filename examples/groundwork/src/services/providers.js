// Provider registry (spec 3.4, 3.10). Injected providers (tests) win; when none are
// injected the real ones are built from config. Fake providers exist only with GW_ENABLE_FAKE=1.
import { assertProvider, PROVIDER_IDS } from '../ai/provider.js';
import { createAnthropicProvider } from '../ai/anthropic.js';
import { createCliProvider } from '../ai/cli.js';
import { createFallbackProvider } from '../ai/fallback.js';
import { createFakeProvider } from '../ai/fake.js';

const OFF_HOST = new Set(['anthropic', 'cli']);

export function createProviderRegistry({ config, providers, log }) {
  const map = new Map();
  const injected = providers && Object.keys(providers).length > 0;
  if (injected) {
    for (const p of Object.values(providers)) map.set(assertProvider(p).id, p);
  } else {
    map.set('anthropic', createAnthropicProvider({ config, log }));
    map.set('cli', createCliProvider({ config, log }));
    map.set('fallback', createFallbackProvider());
    if (config.enableFake) {
      map.set('fake', createFakeProvider({ clean: false }));
      map.set('fake-clean', createFakeProvider({ clean: true }));
    }
  }
  const ordered = () => PROVIDER_IDS.filter((id) => map.has(id)).map((id) => map.get(id));

  async function safeAvailable(p) {
    try { return (await p.available()) === true; } catch { return false; }
  }

  function label(p) {
    if (p.id === 'anthropic') return 'Anthropic API';
    if (p.id === 'cli') return 'Claude Code CLI (haiku)';
    if (p.id === 'fallback') return 'Deterministic fallback (no AI)';
    return p.id === 'fake' ? 'Fake provider (test, contains ungrounded statements)' : 'Fake provider (test, clean)';
  }

  return {
    get(id) { return map.get(id) ?? null; },
    async list() {
      const out = [];
      let def = null;
      for (const p of ordered()) {
        const available = await safeAvailable(p);
        const info = {
          id: p.id, label: label(p), available, isFallback: p.isFallback === true,
          sendsNotesOffHost: OFF_HOST.has(p.id),
        };
        if (p.id === 'cli' && typeof p.version === 'function') {
          let v = null;
          try { v = await p.version(); } catch { v = null; }
          if (typeof v === 'string' && v) info.version = v;
        }
        out.push(info);
        if (def === null && available && (p.id === 'anthropic' || p.id === 'cli')) def = p.id;
      }
      return { providers: out, default: def };
    },
    /** Resolve a requested id ('auto' allowed) to an available provider, or null. */
    async resolve(choice) {
      if (choice === 'auto') {
        for (const id of ['anthropic', 'cli']) {
          const p = map.get(id);
          if (p && await safeAvailable(p)) return p;
        }
        return null;
      }
      const p = map.get(choice);
      return p && await safeAvailable(p) ? p : null;
    },
  };
}
