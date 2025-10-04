(() => {
  const state = {
    user: null,
    userPromise: null,
    sse: null,
    offline: false
  };

  const toastDurations = {
    info: 4000,
    success: 3800,
    warning: 5200,
    error: 5600
  };

  function ensureToastContainer() {
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  function showToast(message, tone = 'info') {
    const container = ensureToastContainer();
    const toast = document.createElement('div');
    toast.className = `toast ${tone}`;
    toast.innerHTML = `<span>${message}</span><button aria-label="close">×</button>`;
    const closer = toast.querySelector('button');
    const remove = () => {
      toast.classList.add('hidden');
      setTimeout(() => toast.remove(), 180);
    };
    closer.addEventListener('click', remove);
    container.appendChild(toast);
    setTimeout(remove, toastDurations[tone] || toastDurations.info);
  }

  function normalizeSyncSpeed(value) {
    const allowed = ['fast', 'standard', 'calm'];
    if (!value) return 'standard';
    const normalized = String(value).toLowerCase();
    return allowed.includes(normalized) ? normalized : 'standard';
  }

  function normalizeDataSource(value) {
    const allowed = ['csv', 'crm'];
    if (!value) return 'csv';
    const normalized = String(value).toLowerCase();
    return allowed.includes(normalized) ? normalized : 'csv';
  }

  async function apiFetch(url, options = {}) {
    const fetchOptions = {
      credentials: 'include',
      method: options.method || 'GET',
      headers: options.headers ? { ...options.headers } : undefined
    };

    let body = options.body;
    if (body != null && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof Blob)) {
      fetchOptions.headers = fetchOptions.headers || {};
      fetchOptions.headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }

    if (body != null) {
      fetchOptions.body = body;
    }

    const response = await fetch(url, fetchOptions);

    if (response.status === 401) {
      state.user = null;
      if (!options.silent) {
        window.location.href = '/';
      }
      throw new Error('unauthorized');
    }

    if (options.raw) {
      return response;
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (err) {
        payload = text;
      }
    }

    if (!response.ok) {
      const err = new Error(payload?.error || response.statusText || 'request_failed');
      err.status = response.status;
      err.payload = payload;
      throw err;
    }

    return payload;
  }

  async function fetchCurrentUser(force = false) {
    if (state.user && !force) {
      return state.user;
    }
    if (state.userPromise && !force) {
      return state.userPromise;
    }
    state.userPromise = apiFetch('/api/auth/me', { silent: true })
      .then((data) => {
        state.userPromise = null;
        state.user = data?.user || null;
        return state.user;
      })
      .catch((err) => {
        state.userPromise = null;
        state.user = null;
        if (err.status !== 401) {
          throw err;
        }
        return null;
      });
    return state.userPromise;
  }

  function getCurrentUserSync() {
    return state.user;
  }

  function logout() {
    return apiFetch('/api/auth/logout', { method: 'POST', silent: true })
      .catch(() => {})
      .finally(() => {
        state.user = null;
        window.location.href = '/';
      });
  }

  function connectSse(onMessage, onStatus) {
    if (state.sse) {
      state.sse.close();
      state.sse = null;
    }
    const source = new EventSource('/api/events');
    let statusTimer = null;

    const notifyStatus = (status) => {
      if (typeof onStatus === 'function') {
        onStatus(status);
      }
    };

    source.onopen = () => {
      state.offline = false;
      notifyStatus('online');
    };

    source.onerror = () => {
      state.offline = true;
      notifyStatus('offline');
      if (statusTimer) {
        clearTimeout(statusTimer);
      }
      statusTimer = setTimeout(() => {
        notifyStatus('retrying');
      }, 4000);
    };

    source.onmessage = (event) => {
      if (!event.data) {
        return;
      }
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type === 'heartbeat') {
          state.offline = false;
          notifyStatus('online');
          return;
        }
        onMessage?.(parsed);
      } catch (err) {
        console.warn('Failed to parse SSE payload', err);
      }
    };

    state.sse = source;
    return {
      close() {
        source.close();
        state.sse = null;
      }
    };
  }

  function formatCurrency(value) {
    if (value == null || value === '') return '—';
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value);
    return number.toLocaleString('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('ru-RU');
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function storePreference(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn('Failed to store preference', err);
    }
  }

  function readPreference(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  function markNavActive(id) {
    document.querySelectorAll('[data-nav]').forEach((link) => {
      if (link.dataset.nav === id) {
        link.classList.add('active');
      } else {
        link.classList.remove('active');
      }
    });
  }

  function createSlug(value) {
    if (!value) return '';
    return String(value)
      .toLowerCase()
      .replace(/[^a-z0-9а-яё\s-]/gi, '')
      .trim()
      .replace(/\s+/g, '-');
  }

  document.addEventListener('DOMContentLoaded', ensureToastContainer, { once: true });

  window.App = {
    showToast,
    apiFetch,
    fetchCurrentUser,
    getCurrentUserSync,
    logout,
    connectSse,
    formatCurrency,
    formatDate,
    formatDateTime,
    storePreference,
    readPreference,
    markNavActive,
    createSlug,
    normalizeSyncSpeed,
    normalizeDataSource
  };
})();
