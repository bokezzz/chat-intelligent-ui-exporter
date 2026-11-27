const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM} = require('../scripts/i18n-env.cjs');
const ob = require('../extension/obsidian-send.js');
const AutoSync = require('../extension/auto-sync.js');

// In-memory File System Access directory mock supporting read + write.
function memFolder(name = 'vault') {
  const dirs = new Map(), files = new Map();
  return {
    name, dirs, files,
    async getDirectoryHandle(n, {create = false} = {}) {
      if (!dirs.has(n)) {
        if (!create) throw Object.assign(Error('missing'), {name: 'NotFoundError'});
        dirs.set(n, memFolder(n));
      }
      return dirs.get(n);
    },
    async getFileHandle(n, {create = false} = {}) {
      if (!files.has(n) && !create) throw Object.assign(Error('missing'), {name: 'NotFoundError'});
      return {
        async getFile() {
          const blob = files.get(n);
          if (!blob) throw Object.assign(Error('missing'), {name: 'NotFoundError'});
          return blob;
        },
        async createWritable() {
          return {
            async write(blob) {files.set(n, blob);},
            async close() {},
          };
        },
      };
    },
  };
}
const at = (root, p) => p.split('/').reduce((d, seg, i, a) => i === a.length - 1 ? d?.files.get(seg) : d?.dirs.get(seg), root);

function portPair() {
  const a = {listeners: [], gone: []}, b = {listeners: [], gone: []};
  const end = (self, other) => ({
    postMessage: m => other.listeners.forEach(f => f(structuredClone(m))),
    onMessage: {addListener: f => self.listeners.push(f)},
    onDisconnect: {addListener: f => self.gone.push(f)},
  });
  return [end(a, b), end(b, a)];
}

test('writeSyncJob writes conversation.md, metadata.json and assets/ui/files; updates in place without duplicates', async () => {
  const vault = memFolder('MyVault');
  const convId = 'conv-12345678-aaaa';
  const hash1 = AutoSync.computeHash({conversationId: convId, title: 'Physics Notes', messages: [{id: 'm1', role: 'user', md: 'Q1'}, {id: 'm2', role: 'assistant', md: 'A1'}]});
  const r1 = await ob.writeSyncJob(vault, 'ChatGPT-Raw', {
    meta: {
      mode: 'sync', conversationId: convId, title: 'Physics Notes', rawTitle: 'Physics Notes',
      source: `https://chatgpt.com/c/${convId}`, version: '1.1.0',
      createdAt: '2026-11-27T08:00:00.000Z', updatedAt: '2026-11-27T08:05:00.000Z',
      contentHash: hash1, messageCount: 2, messageIds: ['m1', 'm2'],
    },
    md: '# Physics Notes\n\nQ1\n\nA1\n',
    files: [
      {path: 'assets/card-m2-1.png', blob: new Blob(['png-bytes'], {type: 'image/png'})},
      {path: 'ui/msg-m2.json', blob: new Blob(['{"ok":true}'], {type: 'application/json'})},
      {path: 'files/data.csv', blob: new Blob(['a,b\n1,2'], {type: 'text/csv'})},
    ],
  });
  assert.equal(r1.skipped, null);
  assert.equal(r1.metadata.sync_version, 1);
  assert.equal(r1.metadata.conversation_id, convId);
  assert.equal(r1.metadata.assets_count, 1);
  assert.equal(r1.metadata.ui_count, 1);
  assert.equal(r1.metadata.files_count, 1);
  assert.equal(await at(vault, `ChatGPT-Raw/${r1.name}/conversation.md`).text(), '# Physics Notes\n\nQ1\n\nA1\n');
  assert.equal(await at(vault, `ChatGPT-Raw/${r1.name}/assets/card-m2-1.png`).text(), 'png-bytes');
  assert.equal(await at(vault, `ChatGPT-Raw/${r1.name}/ui/msg-m2.json`).text(), '{"ok":true}');
  assert.equal(await at(vault, `ChatGPT-Raw/${r1.name}/files/data.csv`).text(), 'a,b\n1,2');

  // Unchanged content hash is skipped.
  const rSame = await ob.writeSyncJob(vault, 'ChatGPT-Raw', {
    meta: {
      mode: 'sync', conversationId: convId, title: 'Physics Notes', folderName: r1.name,
      updatedAt: '2026-11-27T08:05:00.000Z', contentHash: hash1,
    },
    md: '# Physics Notes\n\nQ1\n\nA1\n',
    files: [],
  });
  assert.equal(rSame.skipped, 'unchanged');
  assert.equal(vault.dirs.get('ChatGPT-Raw').dirs.size, 1, 'no duplicate folder');

  // Second turn / regenerated answer updates the exact same folder even if title changed.
  const hash2 = AutoSync.computeHash({conversationId: convId, title: 'Physics Notes Renamed', messages: [{id: 'm1', role: 'user', md: 'Q1'}, {id: 'm2', role: 'assistant', md: 'A1 regenerated'}]});
  const r2 = await ob.writeSyncJob(vault, 'ChatGPT-Raw', {
    meta: {
      mode: 'sync', conversationId: convId, title: 'Physics Notes Renamed', rawTitle: 'Physics Notes Renamed',
      folderName: r1.name, source: `https://chatgpt.com/c/${convId}`, version: '1.1.0',
      updatedAt: '2026-11-27T08:10:00.000Z', contentHash: hash2, messageCount: 2, messageIds: ['m1', 'm2'],
    },
    md: '# Physics Notes Renamed\n\nQ1\n\nA1 regenerated\n',
    files: [],
  });
  assert.equal(r2.skipped, null);
  assert.equal(r2.name, r1.name);
  assert.equal(r2.metadata.sync_version, 2);
  assert.equal(vault.dirs.get('ChatGPT-Raw').dirs.size, 1, 'still only one folder');
  assert.equal(await at(vault, `ChatGPT-Raw/${r1.name}/conversation.md`).text(), '# Physics Notes Renamed\n\nQ1\n\nA1 regenerated\n');

  // Multi-tab stale write cannot overwrite newer archive.
  const rStale = await ob.writeSyncJob(vault, 'ChatGPT-Raw', {
    meta: {
      mode: 'sync', conversationId: convId, title: 'Old Tab', folderName: r1.name,
      updatedAt: '2026-11-27T08:06:00.000Z', contentHash: hash1,
    },
    md: '# Stale content\n',
    files: [],
  });
  assert.equal(rStale.skipped, 'stale');
  assert.equal(await at(vault, `ChatGPT-Raw/${r1.name}/conversation.md`).text(), '# Physics Notes Renamed\n\nQ1\n\nA1 regenerated\n');
});

test('sync scope, hash stability, and stale update detection work as expected', () => {
  assert.equal(AutoSync.shouldSyncConversation({autoSyncEnabled: false, autoSyncScope: 'all'}, 'c1', {}), false);
  assert.equal(AutoSync.shouldSyncConversation({autoSyncEnabled: true, autoSyncScope: 'all'}, 'c1', {}), true);
  assert.equal(AutoSync.shouldSyncConversation({autoSyncEnabled: true, autoSyncScope: 'selected'}, 'c1', {}), false);
  assert.equal(AutoSync.shouldSyncConversation({autoSyncEnabled: true, autoSyncScope: 'selected'}, 'c1', {c1: true}), true);

  const h1 = AutoSync.computeHash({conversationId: 'c1', title: 'T', messages: [{id: 'a', role: 'user', md: 'hi'}]});
  const h2 = AutoSync.computeHash({conversationId: 'c1', title: 'T', messages: [{id: 'a', role: 'user', md: 'hi'}]});
  const h3 = AutoSync.computeHash({conversationId: 'c1', title: 'T', messages: [{id: 'a', role: 'user', md: 'edited'}]});
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);

  assert.equal(AutoSync.isStaleUpdate({updatedAt: '2026-11-27T10:00:00.000Z'}, '2026-11-27T09:59:00.000Z'), true);
  assert.equal(AutoSync.isStaleUpdate({updatedAt: '2026-11-27T10:00:00.000Z'}, '2026-11-27T10:01:00.000Z'), false);
});

test('createSyncQueue serializes per conversation, coalesces bursts, retries transient errors, and halts on NEED_PERMISSION', async () => {
  const events = [];
  let attempts = 0, active = 0, maxConcurrent = 0;
  const queue = AutoSync.createSyncQueue({
    delays: [15, 25],
    onStatus: (id, ev) => events.push(`${id}:${ev.status}`),
    run: async task => {
      active++;
      maxConcurrent = Math.max(maxConcurrent, active);
      try {
        await new Promise(r => setTimeout(r, 15));
        if (task.conversationId === 'perm') throw Object.assign(Error('no perm'), {code: 'NEED_PERMISSION', reason: 'grant'});
        attempts++;
        if (attempts === 1) throw Error('network blip');
        return {ok: true};
      } finally {active--;}
    },
  });

  // Burst enqueue for same conversation: serialized + coalesced, then retried after 1st failure.
  queue.enqueue('c1', {reason: 'a'});
  queue.enqueue('c1', {reason: 'b'});
  for (let i = 0; i < 60 && !events.includes('c1:synced'); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(maxConcurrent, 1, 'same conversation never writes concurrently');
  assert.ok(events.includes('c1:retrying'));
  assert.ok(events.includes('c1:synced'));

  // Permission error does not spin-retry.
  queue.enqueue('perm', {reason: 'auto'});
  for (let i = 0; i < 40 && !events.includes('perm:need_permission'); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(!events.includes('perm:retrying'));
  queue.destroy();
});

test('createWatcher triggers on streaming completion, DOM mutations, and SPA route transitions', async () => {
  const dom = new JSDOM('<body><div id="app"></div></body>', {url: 'https://chatgpt.com/c/chat-1'});
  const w = dom.window;
  let streaming = true, sig = '1|m1|5';
  const triggered = [];
  const watcher = AutoSync.createWatcher({
    doc: w.document,
    win: w,
    getConversationId: () => w.location.pathname.match(/\/c\/([^/]+)/)?.[1] || '',
    isStreaming: () => streaming,
    getDomSignature: () => sig,
    onTrigger: (id, reason) => triggered.push([id, reason]),
    debounceMs: 25,
    pollMs: 0,
  });

  // While streaming, mutations do not trigger.
  w.document.getElementById('app').textContent = 'typing...';
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(triggered, []);

  // Streaming ends -> triggers stream_end.
  streaming = false;
  sig = '2|m2|20';
  w.document.getElementById('app').textContent = 'done';
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(triggered, [['chat-1', 'stream_end']]);

  // SPA route change to chat-2 -> triggers route.
  w.history.pushState({}, '', '/c/chat-2');
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(triggered.at(-1), ['chat-2', 'route']);

  watcher.destroy();
  dom.window.close();
});

test('end-to-end resident page auto-syncs silently on sync:now and keeps manual export intact', async () => {
  const dom = new JSDOM('<form><div id="prompt-textarea"></div></form><div data-message-id="b">Answer 1</div>', {
    url: 'https://chatgpt.com/c/conv-e2e', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window;
  const stored = {autoSyncEnabled: true, autoSyncScope: 'all', autoSyncSubfolder: 'ChatGPT-Raw', obsidianFolder: 'Notes'};
  const storageListeners = [];
  const area = {
    get: async k => {
      if (k == null) return JSON.parse(JSON.stringify(stored));
      if (Array.isArray(k)) return Object.fromEntries(k.filter(x => x in stored).map(x => [x, JSON.parse(JSON.stringify(stored[x]))]));
      return k in stored ? {[k]: JSON.parse(JSON.stringify(stored[k]))} : {};
    },
    set: async o => {
      const c = {};
      for (const [k, v] of Object.entries(o)) {c[k] = {oldValue: stored[k], newValue: v};stored[k] = JSON.parse(JSON.stringify(v));}
      storageListeners.forEach(l => l(c, 'local'));
    },
    remove: async ks => {for (const k of [].concat(ks)) delete stored[k];},
  };
  let msgListener = null;
  const connectListeners = [], sentMessages = [];
  w.fetch = async p => {
    if (p === '/api/auth/session') return {ok: true, json: async () => ({accessToken: 'tok'})};
    return {
      ok: true,
      json: async () => ({
        title: 'Realtime Chat',
        create_time: 1790000000,
        update_time: 1790000120,
        current_node: 'b',
        mapping: {
          a: {parent: null, children: ['b'], message: {id: 'a', create_time: 1790000000, author: {role: 'user'}, content: {parts: ['Hello']}}},
          b: {parent: 'a', children: [], message: {id: 'b', create_time: 1790000120, author: {role: 'assistant'}, content: {parts: ['World']}}},
        },
      }),
    };
  };
  w.Blob.prototype.arrayBuffer ??= function() {return new Promise(ok => {const r = new w.FileReader();r.onload = () => ok(r.result);r.readAsArrayBuffer(this);});};
  if (!w.crypto.randomUUID) w.crypto.randomUUID = () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  w.URL.createObjectURL = () => 'blob:https://chatgpt.com/test';
  w.URL.revokeObjectURL = () => {};

  let receivedJob = null;
  w.chrome = {
    storage: {local: area, onChanged: {addListener: f => storageListeners.push(f)}},
    runtime: {
      id: 'ext',
      getManifest: () => ({version: require('../extension/settings.js').version}),
      getURL: p => 'chrome-extension://ext/' + p,
      sendMessage: async m => {
        sentMessages.push(m);
        if (m.type === 'obsidian:open') {
          setTimeout(() => {
            const [panelEnd, relayEnd] = portPair();
            const take = ob.receiver();
            relayEnd.onMessage.addListener(msg => {
              const done = take(msg);
              if (done) {
                receivedJob = done;
                relayEnd.postMessage({
                  type: 'written', silent: true, skipped: null,
                  path: 'Notes/ChatGPT-Raw/Realtime Chat (conv-e2e)/conversation.md',
                  url: 'obsidian://open?file=Realtime',
                  folderName: 'Realtime Chat (conv-e2e)',
                  metadata: {synced_at: '2026-11-27T09:00:00.000Z', sync_version: 1},
                });
              }
            });
            connectListeners.forEach(fn => fn({...panelEnd, name: `obsidian:${m.job}`}));
          }, 5);
          return {id: 99};
        }
        return {id: 1};
      },
      onConnect: {addListener: f => connectListeners.push(f)},
      onMessage: {addListener: f => {msgListener = f;}},
    },
  };

  for (const f of ['fast-text.js', 'obsidian-send.js', 'auto-sync.js', 'settings.js', 'ui-kit.js', 'resident.js', 'fast-content.js']) {
    w.eval(fs.readFileSync(`extension/${f}`, 'utf8'));
  }

  const ask = m => new Promise(r => {msgListener(m, {id: 'ext'}, r);});
  const res = await ask({type: 'sync:now'});
  assert.ok(receivedJob, 'relay received sync job');
  assert.equal(receivedJob.meta.mode, 'sync');
  assert.equal(receivedJob.meta.conversationId, 'conv-e2e');
  assert.equal(receivedJob.meta.subfolder, 'ChatGPT-Raw');
  assert.match(receivedJob.md, /Hello/);
  assert.match(receivedJob.md, /World/);
  assert.equal(res.record.status, 'synced');
  assert.equal(res.record.syncVersion, 1);
  assert.ok(sentMessages.some(m => m.type === 'obsidian:open' && m.sync === true));

  // Manual export still works untouched.
  const manual = await ask({type: 'panel:export', kind: 'md'});
  assert.equal(manual.error, false);
  assert.ok(sentMessages.some(m => m.type === 'archive:download'));

  dom.window.close();
});
