import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { createAccountLookupGeneration } = require('../electron/account-directory.cjs');
const source = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function functionSource(name) {
  const start = source.indexOf(`async function ${name}(`);
  const tail = source.slice(start + 1);
  const end = tail.search(/\n(?:async )?function /);
  assert.ok(start >= 0 && end >= 0);
  return source.slice(start, start + 1 + end);
}
function harness({ delayLoad = false } = {}) {
  const lookups = new Map(), loads = [], injections = [], saved = [], views = [];
  const context = {
    Map, URL, Error, Object, String, Date, console, __dirname: '/synthetic',
    accountLookupGeneration: createAccountLookupGeneration(),
    activeEnterpriseProfiles: new Map(), workspaceState: {}, workspaceView: null,
    MAX_PROFILE_BYTES: 1024, path: { join: (...x) => x.join('/') },
    accountDirectoryConfigPath: () => 'synthetic', readJsonFile: async () => ({}),
    connectionValidationOptions: async () => ({}),
    resolveAccountWorkspaces: id => { const d = deferred(); lookups.set(id, d); return d.promise; },
    workspaceSessionPartition: (id, account) => `${id}:${account}`,
    validateCloudLoginInput: x => x, validateUnifiedLoginInput: x => x, normalizeAccountId: x => x,
    refreshLocalState: async () => null,
    validateConnectionEnvelope: x => x, stopLocalMode: async () => {},
    saveDesktopAccount: async x => saved.push(x),
    session: { fromPartition: () => ({}) }, configureRemoteSession: () => {},
    app: { isPackaged: true }, mainWindow: { contentView: { addChildView: () => {} } },
    setWorkspaceBounds: () => {}, sendDesktopPreferences: () => {},
    cloudLoginScript: password => ({ password }), sessionStorageScript: remembered => ({ remembered }),
    cloudLoginError: x => x.ok ? null : 'login-failed', process: { env: {} },
    credentialStoreOptions: () => ({}),
    loadSavedAccounts: async () => ({ accounts: [{ accountId: 'A', mode: 'cloud', session: { token: 'A-token' } }] }),
    setActiveAccount: async () => {},
  };
  context.publishState = x => Object.assign(context.workspaceState, x);
  context.destroyWorkspaceView = () => { context.workspaceView = null; };
  context.WebContentsView = class {
    constructor() {
      this.webContents = {
        setWindowOpenHandler() {}, on() {},
        loadURL: async url => {
          this.url = url;
          if (delayLoad) { const d = deferred(); loads.push(d); await d.promise; }
        },
        executeJavaScript: async script => {
          injections.push({ url: this.url, ...script });
          return script.remembered ? true : { ok: true, session: { accountName: 'synthetic', token: script.password } };
        },
      };
      views.push(this);
    }
    setVisible() {}
  };
  vm.createContext(context);
  for (const name of ['lookupAccount', 'loginEnterprise', 'loginAccount', 'openWorkspace', 'resumeSavedAccount', 'trySavedAccountLogin', 'authenticateLocal']) {
    vm.runInContext(functionSource(name), context);
  }
  const resolve = id => lookups.get(id).resolve({
    accountId: id, status: 'resolved', workspaces: [{
      profile: { connectionId: id }, summary: {},
      envelope: { connectionId: id, profileId: id, allowedOrigins: [`https://${id}.example.invalid`], applicationUrl: `https://${id}.example.invalid` },
    }],
  });
  return { context, lookups, loads, injections, saved, views, resolve };
}
async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await Promise.resolve();
  assert.ok(predicate(), 'expected async boundary reached');
}
const input = id => ({ accountId: id, password: `${id}-password`, remember: true });

test('late account directory response cannot use another login profile or save its session', async () => {
  const h = harness();
  const a = h.context.loginEnterprise(input('A'));
  const b = h.context.loginEnterprise(input('B'));
  await until(() => h.lookups.size === 2);
  h.resolve('B'); await b;
  h.resolve('A'); await a;
  assert.deepEqual(h.injections, [{ url: 'https://B.example.invalid', password: 'B-password' }]);
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].accountId, 'B');
  assert.equal(h.saved[0].session.token, 'B-password');
});

test('a superseded page load cannot inject credentials into the new WebContentsView', async () => {
  const h = harness({ delayLoad: true });
  const a = h.context.loginEnterprise(input('A'));
  await until(() => h.lookups.has('A')); h.resolve('A');
  await until(() => h.loads.length === 1);
  const b = h.context.loginEnterprise(input('B'));
  await until(() => h.lookups.has('B')); h.resolve('B');
  await until(() => h.loads.length === 2);
  h.loads[0].resolve(); await a;
  assert.equal(h.injections.length, 0);
  h.loads[1].resolve(); await until(() => h.loads.length === 3);
  h.loads[2].resolve(); await b;
  assert.deepEqual(h.injections, [{ url: 'https://B.example.invalid', password: 'B-password' }]);
  assert.equal(h.saved.length, 1);
  assert.equal(h.context.workspaceView, h.views[1]);
});

test('remembered login finishing after manual login cannot inject its old token', async () => {
  const h = harness();
  const resume = h.context.resumeSavedAccount('A');
  await until(() => h.lookups.has('A'));
  const b = h.context.loginEnterprise(input('B'));
  await until(() => h.lookups.has('B')); h.resolve('B'); await b;
  h.resolve('A'); await resume;
  assert.deepEqual(h.injections, [{ url: 'https://B.example.invalid', password: 'B-password' }]);
});


test('an older unified login delayed by local discovery cannot replace a newer login', async () => {
  const h = harness();
  const discovery = deferred();
  let calls = 0;
  h.context.refreshLocalState = () => ++calls === 1 ? discovery.promise : Promise.resolve(null);
  const a = h.context.loginAccount(input('A'));
  const b = h.context.loginAccount(input('B'));
  await until(() => h.lookups.has('B')); h.resolve('B'); await b;
  discovery.resolve(null); await a;
  assert.equal(h.lookups.has('A'), false);
  assert.deepEqual(h.injections, [{ url: 'https://B.example.invalid', password: 'B-password' }]);
});


test('startup credential discovery cannot revive a saved login after manual login', async () => {
  const h = harness();
  const discovery = deferred();
  h.context.refreshSavedAccountState = () => discovery.promise;
  const startup = h.context.trySavedAccountLogin();
  const b = h.context.loginAccount(input('B'));
  await until(() => h.lookups.has('B')); h.resolve('B'); await b;
  discovery.resolve({ activeAccountId: 'A', accounts: [{ accountId: 'A', session: { token: 'A-token' } }] });
  await startup;
  assert.equal(h.lookups.has('A'), false);
  assert.deepEqual(h.injections, [{ url: 'https://B.example.invalid', password: 'B-password' }]);
});


test('superseded local authentication cannot save over or replace a cloud login', async () => {
  const h = harness();
  const authenticated = deferred();
  h.context.startLocalMode = async () => ({});
  h.context.loginLocalRuntime = () => authenticated.promise;
  h.context.openLocalWorkspaceView = async () => assert.fail('stale local view opened');
  const local = h.context.authenticateLocal({ username: 'A', password: 'A-password', remember: true });
  await Promise.resolve();
  const b = h.context.loginAccount(input('B'));
  await until(() => h.lookups.has('B')); h.resolve('B'); await b;
  authenticated.resolve({ rememberSession: { token: 'A-token' } }); await local;
  assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].accountId, 'B');
  assert.deepEqual(h.injections, [{ url: 'https://B.example.invalid', password: 'B-password' }]);
});
