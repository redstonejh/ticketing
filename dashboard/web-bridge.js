(() => {
  'use strict';

  if (window.tickets && window.auth) return;

  const ticketListeners = new Set();
  const connectionListeners = new Set();
  const authListeners = new Set();
  let currentUser = (() => {
    try {
      const username = localStorage.getItem('ticketing-web-current-user');
      return username ? { username } : null;
    } catch {
      return null;
    }
  })();
  let connectionState = 'live';

  async function request(path, options = {}) {
    try {
      const response = await fetch(path, {
        method: options.method || 'GET',
        credentials: 'same-origin',
        headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      const payload = await response.json().catch(() => ({}));
      connectionState = response.ok ? 'live' : 'offline';
      return response.ok && payload.ok !== false
        ? payload
        : { ok: false, error: payload.error || `HTTP ${response.status}`, status: response.status };
    } catch (error) {
      connectionState = 'offline';
      for (const listener of connectionListeners) {
        try { listener('offline'); } catch {}
      }
      return { ok: false, error: error.message || 'Request failed' };
    }
  }

  function notifyTickets(payload) {
    for (const listener of ticketListeners) {
      try { listener(payload); } catch {}
    }
  }

  const events = new EventSource('/api/events');
  events.addEventListener('open', () => {
    connectionState = 'live';
    for (const listener of connectionListeners) {
      try { listener('live'); } catch {}
    }
  });
  events.addEventListener('tickets', (event) => {
    try { notifyTickets(JSON.parse(event.data)); } catch {}
  });
  events.addEventListener('error', () => {
    connectionState = 'offline';
    for (const listener of connectionListeners) {
      try { listener('offline'); } catch {}
    }
  });

  const action = (id, name, body = {}) => request(
    `/api/tickets/${encodeURIComponent(id)}/${name}`,
    { method: 'POST', body },
  );
  window.tickets = {
    list: () => request('/api/tickets'),
    connectionState: () => Promise.resolve(connectionState),
    onChanged: (callback) => {
      if (typeof callback !== 'function') return () => {};
      ticketListeners.add(callback);
      return () => ticketListeners.delete(callback);
    },
    onConnection: (callback) => {
      if (typeof callback !== 'function') return () => {};
      connectionListeners.add(callback);
      return () => connectionListeners.delete(callback);
    },
    claim: (id) => action(id, 'claim'),
    unclaim: (id) => action(id, 'unclaim'),
    assign: (id, assignee) => action(id, 'assign', { assignee }),
    resolve: (id) => action(id, 'resolve'),
    reopen: (id) => action(id, 'reopen'),
    comment: (id, text) => action(id, 'comment', { text }),
    update: (id, fields) => action(id, 'update', { fields }),
    create: (payload) => request('/api/tickets', { method: 'POST', body: payload }),
    remove: (id) => request(`/api/tickets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };

  const authRequest = (actionName, body) => request(`/api/auth/${actionName}`, {
    method: body === undefined ? 'GET' : 'POST',
    body,
  });
  const applySession = (session) => {
    currentUser = session?.user || null;
    try {
      if (currentUser?.username) localStorage.setItem('ticketing-web-current-user', currentUser.username);
      else localStorage.removeItem('ticketing-web-current-user');
    } catch {}
    return session;
  };
  window.auth = {
    session: () => authRequest('session').then(applySession),
    login: (username, password) => authRequest('login', { username, password }).then((result) => {
      if (result.ok) applySession({ user: result.user });
      return result;
    }),
    register: (username, password) => authRequest('register', { username, password }).then((result) => {
      if (result.ok) applySession({ user: result.user });
      return result;
    }),
    setPassword: (password) => authRequest('set-password', { password }),
    logout: () => authRequest('logout', {}).then((result) => {
      applySession(null);
      return result;
    }),
    listUsers: () => authRequest('users'),
    createUser: (payload) => authRequest('users', payload),
    updateUser: (username, data) => request(`/api/auth/users/${encodeURIComponent(username)}`, {
      method: 'PATCH', body: data,
    }),
    deleteUser: (username) => request(`/api/auth/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),
    onChanged: (callback) => {
      if (typeof callback !== 'function') return () => {};
      authListeners.add(callback);
      return () => authListeners.delete(callback);
    },
  };

  const settings = { web: true, persistence: 'server-volume' };
  window.dashboard = {
    getStatus: () => Promise.resolve({ status: null, connectionState }),
    onStatus: () => () => {},
    onConnection: () => () => {},
    onCheck: () => () => {},
    onSetCompany: () => () => {},
    getHistory: () => Promise.resolve({ ok: true, history: [] }),
    getCompanies: () => Promise.resolve([]),
    getCompanyHistory: () => Promise.resolve({ results: [], rollups: [] }),
    getViewerIps: () => Promise.resolve({}),
    consumeCompanyFocus: () => Promise.resolve(null),
    getSettings: () => Promise.resolve(settings),
    saveSettings: () => Promise.resolve({ ok: false, error: 'Settings are managed in Portainer' }),
    openExternal: (url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
      return Promise.resolve({ ok: true });
    },
    closeDashboard: () => Promise.resolve({ ok: true }),
    minimize: () => Promise.resolve({ ok: true }),
  };
  window.electron = {
    platform: 'web',
    getSettings: window.dashboard.getSettings,
    saveSettings: window.dashboard.saveSettings,
    openExternal: window.dashboard.openExternal,
    openDashboard: () => Promise.resolve({ ok: true }),
  };

  const persistencePrefix = () => `ticketing-layout-store--${currentUser?.username || '_anon'}--`;
  window.dashboardPersistence = {
    getItem: (key) => localStorage.getItem(`${persistencePrefix()}${key}`),
    setItem: (key, value) => localStorage.setItem(`${persistencePrefix()}${key}`, String(value)),
    removeItem: (key) => localStorage.removeItem(`${persistencePrefix()}${key}`),
    keys: () => Object.keys(localStorage)
      .filter((key) => key.startsWith(persistencePrefix()))
      .map((key) => key.slice(persistencePrefix().length)),
    clear: () => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith(persistencePrefix())) localStorage.removeItem(key);
      }
    },
  };
  window.dashboardWindowControls = {
    reload: () => window.location.reload(),
    minimize: () => Promise.resolve({ ok: true }),
    close: () => Promise.resolve({ ok: true }),
  };
})();

