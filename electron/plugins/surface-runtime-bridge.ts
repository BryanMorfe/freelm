/** The JSON-only methods available to isolated API v2 surface activations. */
export const SURFACE_HOST_METHODS = new Set([
	'events.subscribe', 'events.remove',
	'composer.getState', 'composer.readDraft', 'composer.getSelection',
	'composer.applyEdit', 'composer.setText', 'composer.insertText',
	'composer.setPlaceholder', 'composer.placeholder.update', 'composer.placeholder.remove',
	'composer.drawer.addItem', 'composer.drawer.addView', 'composer.drawer.update', 'composer.drawer.remove',
	'composer.attachments.add', 'composer.attachments.remove', 'composer.attachments.read',
	'assets.create', 'commands.register', 'commands.remove',
	'keybindings.register', 'keybindings.remove', 'settings.get',
	'conversation.getTurns', 'inference.generateText', 'diagnostics.report',
]);

/** Runs only inside QuickJS. No host objects, function references, or Node globals are exposed. */
export const surfaceRuntimeBootstrap = String.raw`(() => {
  'use strict';
  const bridge = globalThis.__host;
  delete globalThis.__host;
  for (const name of ['console', 'Atomics', 'SharedArrayBuffer', 'WebAssembly']) delete globalThis[name];
  const encode = value => {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError('Expected a JSON value.');
    return json;
  };
  let disposed = false, next = 0, callbacksRunning = 0;
  const callbacks = new Map(), listeners = new Map(), registrations = new Set(), chains = new Map(), owners = new Map();
  const errorText = error => String(error && error.message || error);
  const report = error => { if (!disposed) bridge('__error', errorText(error)); };
  const abortError = () => { const error = new Error('Plugin operation was cancelled.'); error.name = 'AbortError'; return error; };
  class GuestAbortSignal {
    constructor() { this.aborted = false; this.reason = undefined; this.onabort = null; this.listeners = new Set(); }
    addEventListener(name, callback, options) {
      if (name === 'abort' && typeof callback === 'function') this.listeners.add({callback, once: !!(options && options.once)});
    }
    removeEventListener(name, callback) {
      if (name === 'abort') for (const item of this.listeners) if (item.callback === callback) this.listeners.delete(item);
    }
    throwIfAborted() { if (this.aborted) throw this.reason || abortError(); }
    _abort(reason) {
      if (this.aborted) return;
      this.aborted = true; this.reason = reason || abortError();
      const event = {type: 'abort', target: this};
      if (typeof this.onabort === 'function') { try { this.onabort(event); } catch (error) { report(error); } }
      for (const item of [...this.listeners]) {
        if (item.once) this.listeners.delete(item);
        try { item.callback(event); } catch (error) { report(error); }
      }
    }
  }
  class GuestAbortController {
    constructor() { this.signal = new GuestAbortSignal(); }
    abort(reason) { this.signal._abort(reason); }
  }
  globalThis.AbortController = GuestAbortController;
  globalThis.AbortSignal = GuestAbortSignal;
  const controller = new GuestAbortController();
  const host = (method, args, signal) => {
    if (disposed) return Promise.reject(abortError());
    if (signal && signal.aborted) return Promise.reject(signal.reason || abortError());
    const operationId = 'operation-' + (++next);
    const cancel = () => bridge('__cancel', operationId);
    if (signal) signal.addEventListener('abort', cancel, {once: true});
    try {
      return Promise.resolve(bridge(method, encode(args), operationId)).finally(() => {
        if (signal) signal.removeEventListener('abort', cancel);
      });
    } catch (error) {
      if (signal) signal.removeEventListener('abort', cancel);
      return Promise.reject(error);
    }
  };
  function owned(method, args, removeMethod, updateMethod, cleanup) {
    if (registrations.size >= 128) throw new Error('Plugin registration limit exceeded.');
    const id = args.id || ('contribution-' + (++next));
    const key = removeMethod + ':' + id, owner = ++next;
    owners.set(key, owner);
    const enqueue = operation => {
      const previous = chains.get(key) || Promise.resolve();
      const operationPromise = previous.catch(() => {}).then(operation);
      chains.set(key, operationPromise);
      operationPromise.finally(() => { if (chains.get(key) === operationPromise) chains.delete(key); }).catch(() => {});
      return operationPromise;
    };
    let removed = false;
    const ready = enqueue(() => host(method, {...args, id})).then(() => undefined);
    const handle = {
      id, ready,
      dispose() {
        if (removed) return;
        removed = true; registrations.delete(handle);
        if (cleanup) cleanup();
        if (!disposed && owners.get(key) === owner) {
          owners.delete(key);
          enqueue(() => ready.then(() => host(removeMethod, {id}))).catch(() => {});
        }
      },
    };
    if (updateMethod) handle.update = patch => {
      if (removed) return Promise.reject(new Error('Plugin contribution was disposed.'));
      if (owners.get(key) !== owner) return Promise.reject(new Error('Plugin contribution was replaced.'));
      return enqueue(() => ready.then(() => host(updateMethod, {...patch, id}))).then(() => undefined);
    };
    // A revision conflict may be expected after typing. The caller owns the
    // rejection; activation's initial registrations are still awaited below.
    ready.catch(() => {});
    registrations.add(handle);
    return Object.freeze(handle);
  }
  function subscribe(name, callback) {
    if (typeof callback !== 'function') throw new TypeError('Event callback must be a function.');
    const id = 'subscription-' + (++next);
    listeners.set(id, {name, callback});
    return owned('events.subscribe', {id, name}, 'events.remove', null, () => listeners.delete(id));
  }
  function invokeCallback(callback, payload) {
    if (++callbacksRunning > 32) { callbacksRunning--; throw new Error('Too many pending plugin callbacks.'); }
    Promise.resolve().then(() => callback(payload)).catch(report).finally(() => callbacksRunning--);
  }
  let cleanup;
  globalThis.__surface = {
    start(binding) {
      const context = Object.freeze({
        ...binding, signal: controller.signal,
        reportError: message => host('diagnostics.report', {message}),
        events: Object.freeze({on: subscribe}),
        conversation: Object.freeze({
          getTurns: options => host('conversation.getTurns', options || {}),
          onDidCompleteTurn: callback => subscribe('conversation.completed', callback),
          onDidChange: callback => subscribe('conversation.changed', callback),
        }),
        settings: Object.freeze({get: () => host('settings.get', {})}),
        inference: Object.freeze({generateText: request => {
          const {signal, ...args} = request;
          return host('inference.generateText', args, signal || controller.signal);
        }}),
        composer: Object.freeze({
          getState: () => host('composer.getState', {}),
          readDraft: () => host('composer.readDraft', {}),
          getSelection: () => host('composer.getSelection', {}),
          onDidChange: callback => subscribe('composer.changed', callback),
          applyEdit: edit => host('composer.applyEdit', edit),
          setText: (text, options) => host('composer.setText', {...options, text}),
          insertText: (text, options) => host('composer.insertText', {...options, text}),
          setPlaceholder: (text, options) => owned('composer.setPlaceholder', {...options, text}, 'composer.placeholder.remove', 'composer.placeholder.update'),
          drawer: Object.freeze({
            addItem: item => owned('composer.drawer.addItem', item, 'composer.drawer.remove', 'composer.drawer.update'),
            addView: view => owned('composer.drawer.addView', view, 'composer.drawer.remove', 'composer.drawer.update'),
          }),
          attachments: Object.freeze({
            add: (asset, options) => host('composer.attachments.add', {...options, asset}),
            remove: (id, options) => host('composer.attachments.remove', {...options, id}),
            read: id => host('composer.attachments.read', {id}),
          }),
        }),
        assets: Object.freeze({create: input => host('assets.create', input)}),
        commands: Object.freeze({register: command => {
          const {run, ...descriptor} = command;
          if (run !== undefined && typeof run !== 'function') throw new TypeError('Command run must be a function.');
          if (run) callbacks.set(command.id, run);
          return owned('commands.register', descriptor, 'commands.remove', null, () => { if (callbacks.get(command.id) === run) callbacks.delete(command.id); });
        }}),
        keybindings: Object.freeze({register: binding => owned('keybindings.register', binding, 'keybindings.remove')}),
      });
      Promise.resolve().then(() => {
        const plugin = globalThis.__freelmPlugin && globalThis.__freelmPlugin.default;
        if (!plugin || typeof plugin.activate !== 'function') throw new Error('Plugin does not implement activate(context).');
        const activation = plugin.activate(context);
        Promise.resolve(activation).then(result => {
          if (typeof result === 'function') { if (disposed) result(); else cleanup = result; }
          else if (result !== undefined) throw new Error('Plugin activate must return a cleanup function or undefined.');
        }).catch(report);
        // Start accepting lifecycle events while an asynchronous activation waits
        // on inference. Otherwise typing could never cancel its first request.
        Promise.all([...registrations].map(handle => handle.ready)).then(() => {
          if (!disposed) bridge('__ready', 'null');
        }).catch(report);
      }).catch(report);
    },
    event(name, payload) {
      if (disposed) return;
      for (const entry of [...listeners.values()]) if (entry.name === name) invokeCallback(entry.callback, payload);
    },
    command(id, payload) {
      if (disposed) return;
      const callback = callbacks.get(id);
      if (callback) invokeCallback(callback, payload);
    },
    dispose() {
      if (disposed) return;
      controller.abort(); disposed = true;
      if (cleanup) { try { cleanup(); } catch (_) {} }
      listeners.clear(); callbacks.clear(); registrations.clear(); chains.clear(); owners.clear();
    },
  };
})();`;
