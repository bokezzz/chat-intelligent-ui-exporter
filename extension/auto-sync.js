// Real-time auto-sync engine for ChatGPT -> Obsidian.
// Reuses the extension's existing extraction, Markdown conversion, Intelligent UI rendering
// and File System Access relay without introducing any server or extra credentials.
(function(root) {
  'use strict';

  const STORAGE_KEYS = {
    state: 'chatExportSyncState',
    tracked: 'chatExportSyncTracked',
    queue: 'chatExportSyncQueue',
  };

  // Deterministic 64-bit hex hash (two independent 32-bit FNV-1a passes) so content
  // deduplication works synchronously in both Chrome and Node tests.
  function fnv1a(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
  function hashString(str) {
    const s = String(str ?? '');
    return fnv1a(s, 0x811c9dc5) + fnv1a(`${s.length}:${s}`, 0x811c9dc5 ^ 0x9e3779b9);
  }

  // Computes a stable content hash using conversation_id, title, message_ids, message content,
  // and asset paths so edits, regenerations, or new turns always produce a new hash.
  function computeHash({conversationId = '', title = '', messages = [], assets = [], md = ''} = {}) {
    const normalized = {
      id: String(conversationId || ''),
      title: String(title || ''),
      messages: (messages || []).map(m => ({
        id: String(m.id || ''),
        role: String(m.role || ''),
        md: String(m.md ?? m.staticMd ?? ''),
        model: String(m.model || ''),
      })),
      assets: (assets || []).map(a => `${a.path || ''}:${a.blob?.size ?? a.size ?? 0}`).sort(),
      mdLen: String(md || '').length,
    };
    return hashString(JSON.stringify(normalized));
  }

  function shouldSyncConversation(cfg, conversationId, tracked = {}) {
    if (!conversationId || !cfg?.autoSyncEnabled) return false;
    if (cfg.autoSyncScope === 'selected') return !!tracked?.[conversationId];
    return true;
  }

  function toMillis(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
    if (typeof v === 'string' && v) {
      const parsed = Date.parse(v);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  // Prevents a stale background tab from overwriting a newer archive written by another tab.
  function isStaleUpdate(existing, incomingUpdatedAt) {
    const oldMs = toMillis(existing?.updatedAt || existing?.updated_at);
    const newMs = toMillis(incomingUpdatedAt);
    return !!(oldMs && newMs && oldMs > newMs);
  }

  // Shared state store backed by chrome.storage.local (falls back to memory in isolated tests).
  function createSyncStore(area = null, events = null) {
    let state = {}, tracked = {}, queue = {};
    const listeners = new Set();
    const emit = () => {for (const fn of listeners) {try {fn({state, tracked, queue});} catch (e) {console.error(e);}}};
    const readArea = async () => {
      if (!area) return {state, tracked, queue};
      try {
        const res = await area.get([STORAGE_KEYS.state, STORAGE_KEYS.tracked, STORAGE_KEYS.queue]) || {};
        state = res[STORAGE_KEYS.state] || {};
        tracked = res[STORAGE_KEYS.tracked] || {};
        queue = res[STORAGE_KEYS.queue] || {};
      } catch {}
      return {state, tracked, queue};
    };
    const ready = readArea().then(v => {emit();return v;});
    if (events?.addListener) {
      events.addListener((changes, name) => {
        if (name !== 'local') return;
        let hit = false;
        if (STORAGE_KEYS.state in changes) {state = changes[STORAGE_KEYS.state].newValue || {};hit = true;}
        if (STORAGE_KEYS.tracked in changes) {tracked = changes[STORAGE_KEYS.tracked].newValue || {};hit = true;}
        if (STORAGE_KEYS.queue in changes) {queue = changes[STORAGE_KEYS.queue].newValue || {};hit = true;}
        if (hit) emit();
      });
    }
    async function writeKey(key, updater) {
      if (area) {
        try {
          const cur = (await area.get(key))?.[key] || {};
          const next = updater({...cur});
          await area.set({[key]: next});
          if (key === STORAGE_KEYS.state) state = next;
          else if (key === STORAGE_KEYS.tracked) tracked = next;
          else if (key === STORAGE_KEYS.queue) queue = next;
          emit();
          return next;
        } catch {}
      }
      if (key === STORAGE_KEYS.state) {state = updater({...state});emit();return state;}
      if (key === STORAGE_KEYS.tracked) {tracked = updater({...tracked});emit();return tracked;}
      queue = updater({...queue});emit();return queue;
    }
    return {
      ready,
      get snapshot() {return {state, tracked, queue};},
      getRecord: id => state[id] || null,
      isTracked: id => !!tracked[id],
      getQueue: () => ({...queue}),
      setTracked: (id, on) => writeKey(STORAGE_KEYS.tracked, m => {if (on) m[id] = true; else delete m[id];return m;}),
      updateRecord: (id, patch) => writeKey(STORAGE_KEYS.state, m => {
        const prev = m[id] || {};
        // Never let a stale write clobber a newer synced record unless forced.
        if (!patch.force && patch.updatedAt && isStaleUpdate(prev, patch.updatedAt) && patch.status === 'synced') return m;
        const clean = {...patch};delete clean.force;
        m[id] = {...prev, ...clean, conversationId: id};
        return m;
      }),
      enqueuePersistent: (id, reason = 'pending') => writeKey(STORAGE_KEYS.queue, m => {
        m[id] = {conversationId: id, reason, queuedAt: new Date().toISOString()};
        return m;
      }),
      dequeuePersistent: id => writeKey(STORAGE_KEYS.queue, m => {delete m[id];return m;}),
      onChange: fn => {listeners.add(fn);return () => listeners.delete(fn);},
    };
  }

  // Per-conversation serialized queue with coalescing and exponential backoff retry.
  function createSyncQueue({run, delays = [3000, 8000, 20000], onStatus = () => {}, schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id)} = {}) {
    const running = new Set();
    const pending = new Map();
    const retries = new Map();
    const timers = new Map();

    function clearTimer(id) {
      if (timers.has(id)) {cancel(timers.get(id));timers.delete(id);}
    }

    async function process(id) {
      if (running.has(id)) return;
      const task = pending.get(id);
      if (!task) return;
      pending.delete(id);
      clearTimer(id);
      running.add(id);
      onStatus(id, {status: 'syncing', attempt: (retries.get(id) || 0) + 1});
      try {
        const result = await run(task);
        retries.delete(id);
        onStatus(id, {status: result?.skipped === 'stale' ? 'stale' : 'synced', result});
      } catch (err) {
        if (err?.code === 'NEED_PERMISSION') {
          retries.delete(id);
          onStatus(id, {status: 'need_permission', error: err.message || 'Permission required', reason: err.reason || 'grant'});
        } else if (err?.code === 'SKIPPED') {
          retries.delete(id);
        } else {
          const count = (retries.get(id) || 0) + 1;
          if (count <= delays.length) {
            retries.set(id, count);
            const waitMs = delays[count - 1];
            onStatus(id, {status: 'retrying', error: err?.message || String(err), attempt: count, maxAttempts: delays.length, waitMs});
            timers.set(id, schedule(() => {
              timers.delete(id);
              if (!pending.has(id)) pending.set(id, {...task, reason: 'retry'});
              process(id);
            }, waitMs));
          } else {
            retries.delete(id);
            onStatus(id, {status: 'error', error: err?.message || String(err), attempt: count});
          }
        }
      } finally {
        running.delete(id);
        if (pending.has(id) && !timers.has(id)) process(id);
      }
    }

    function enqueue(id, task = {}) {
      if (!id) return;
      const prev = pending.get(id);
      pending.set(id, {conversationId: id, ...prev, ...task, force: !!(prev?.force || task.force)});
      if (task.force) {clearTimer(id);retries.delete(id);}
      if (!running.has(id)) process(id);
    }

    function destroy() {
      for (const timer of timers.values()) cancel(timer);
      timers.clear();pending.clear();retries.clear();
    }

    return {
      enqueue,
      isBusy: id => running.has(id) || pending.has(id),
      destroy,
    };
  }

  // Observes DOM mutations (new turns, streaming end, edits, regenerations) and SPA route changes.
  function createWatcher({
    doc,
    win,
    getConversationId,
    isStreaming,
    getDomSignature,
    onTrigger,
    debounceMs = 1500,
    pollMs = 1500,
  }) {
    let lastId = getConversationId() || '';
    let wasStreaming = !!isStreaming();
    let lastSig = getDomSignature() || '';
    let timer = null;
    let destroyed = false;

    const scheduleTrigger = (id, reason, delay = debounceMs) => {
      if (destroyed || !id) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (destroyed) return;
        const currentId = getConversationId();
        if (!currentId || currentId !== id || isStreaming()) return;
        onTrigger(currentId, reason);
      }, delay);
    };

    const inspect = (source = 'mutation') => {
      if (destroyed || !doc?.defaultView) return;
      let id = '', streamingNow = false, sig = '';
      try {
        id = getConversationId() || '';
        streamingNow = !!isStreaming();
        sig = getDomSignature() || '';
      } catch {return;}

      if (id !== lastId) {
        clearTimeout(timer);
        timer = null;
        lastId = id;
        wasStreaming = streamingNow;
        lastSig = sig;
        if (id && !streamingNow) scheduleTrigger(id, 'route', Math.min(debounceMs, 800));
        return;
      }

      if (!id) {
        wasStreaming = streamingNow;
        lastSig = sig;
        return;
      }

      if (wasStreaming && !streamingNow) {
        wasStreaming = false;
        lastSig = sig;
        scheduleTrigger(id, 'stream_end', debounceMs);
        return;
      }

      wasStreaming = streamingNow;

      if (!streamingNow && sig && sig !== lastSig) {
        lastSig = sig;
        scheduleTrigger(id, source === 'poll' ? 'dom_poll' : 'dom_change', debounceMs);
      }
    };

    const MutationObs = win?.MutationObserver || root.MutationObserver;
    let observer = null;
    if (MutationObs && doc?.body) {
      observer = new MutationObs(() => inspect('mutation'));
      observer.observe(doc.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['data-message-id', 'data-chatgpt-search-message-ids', 'data-talvt-turn-state', 'aria-label'],
      });
    }

    const onRoute = () => inspect('route');
    win?.addEventListener?.('popstate', onRoute);
    const origPush = win?.history?.pushState;
    const origReplace = win?.history?.replaceState;
    if (win?.history && typeof origPush === 'function') {
      win.history.pushState = function(...args) {
        const ret = origPush.apply(this, args);
        setTimeout(onRoute, 0);
        return ret;
      };
    }
    if (win?.history && typeof origReplace === 'function') {
      win.history.replaceState = function(...args) {
        const ret = origReplace.apply(this, args);
        setTimeout(onRoute, 0);
        return ret;
      };
    }

    const poller = pollMs > 0 ? setInterval(() => inspect('poll'), pollMs) : null;

    return {
      checkNow: (reason = 'manual') => {
        const id = getConversationId();
        if (id && !isStreaming()) onTrigger(id, reason);
      },
      destroy: () => {
        destroyed = true;
        clearTimeout(timer);
        if (poller) clearInterval(poller);
        observer?.disconnect();
        win?.removeEventListener?.('popstate', onRoute);
        if (win?.history && origPush) win.history.pushState = origPush;
        if (win?.history && origReplace) win.history.replaceState = origReplace;
      },
    };
  }

  const api = {
    STORAGE_KEYS,
    hashString,
    computeHash,
    shouldSyncConversation,
    isStaleUpdate,
    createSyncStore,
    createSyncQueue,
    createWatcher,
  };

  root.ChatExportAutoSync = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
