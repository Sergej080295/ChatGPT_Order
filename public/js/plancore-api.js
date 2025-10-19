(() => {
  const API_ROOT = '/api';

  const defaultHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  const errorFromResponse = async (res) => {
    let detail = null;
    try {
      detail = await res.json();
    } catch (_err) {
      detail = await res.text().catch(() => null);
    }
    const error = new Error(detail?.error || res.statusText || 'Request failed');
    error.status = res.status;
    error.detail = detail;
    return error;
  };

  const request = async (path, options = {}) => {
    const res = await fetch(`${API_ROOT}${path}`, options);
    if (!res.ok) {
      throw await errorFromResponse(res);
    }
    if (res.status === 204) {
      return null;
    }
    return res.json();
  };

  const buildQuery = (params = {}) => {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      search.set(key, value);
    });
    const query = search.toString();
    return query ? `?${query}` : '';
  };

  const PlanCoreApi = {
    async listOrders({ board, search, includeStages = true } = {}) {
      const query = buildQuery({ board, search, includeStages: includeStages ? '1' : '0' });
      const data = await request(`/orders${query}`);
      return Array.isArray(data?.orders) ? data.orders : [];
    },

    async getOrder(orderId, { includeStages = true } = {}) {
      const query = buildQuery({ includeStages: includeStages ? '1' : '0' });
      const data = await request(`/orders/${encodeURIComponent(orderId)}${query}`);
      return data?.order || null;
    },

    async createOrder(payload = {}) {
      const data = await request('/orders', {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify(payload)
      });
      return data?.order || null;
    },

    async updateOrder(orderId, payload = {}) {
      const data = await request(`/orders/${encodeURIComponent(orderId)}`, {
        method: 'PATCH',
        headers: defaultHeaders,
        body: JSON.stringify(payload)
      });
      return data?.order || null;
    },

    async deleteOrder(orderId) {
      await request(`/orders/${encodeURIComponent(orderId)}`, {
        method: 'DELETE'
      });
      return true;
    },

    async createStage(orderId, payload = {}) {
      const data = await request(`/orders/${encodeURIComponent(orderId)}/stages`, {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify(payload)
      });
      return data?.stage || null;
    },

    async updateStage(stageId, payload = {}) {
      const data = await request(`/stages/${encodeURIComponent(stageId)}`, {
        method: 'PATCH',
        headers: defaultHeaders,
        body: JSON.stringify(payload)
      });
      return data?.stage || null;
    },

    async deleteStage(stageId) {
      await request(`/stages/${encodeURIComponent(stageId)}`, { method: 'DELETE' });
      return true;
    },


    async listStageOverview() {
      const data = await request('/stages');
      return data || { stages: {}, catalog: [] };
    },
    async listStageTasks(stageCode) {
      const data = await request(`/stages/${encodeURIComponent(stageCode)}`);
      return Array.isArray(data?.tasks) ? data.tasks : [];
    },

    async getStageCatalog() {
      const data = await request('/stages/catalog');
      return Array.isArray(data?.stages) ? data.stages : [];
    },

    async listSettings() {
      const data = await request('/settings');
      return data?.settings || {};
    },

    async updateSettings(payload = {}) {
      const data = await request('/settings', {
        method: 'PUT',
        headers: defaultHeaders,
        body: JSON.stringify(payload)
      });
      return data?.settings || {};
    },

    async listJournal(limit = 50) {
      const query = buildQuery({ limit });
      const data = await request(`/journal${query}`);
      return Array.isArray(data?.entries) ? data.entries : [];
    }
  };

  window.PlanCoreApi = PlanCoreApi;
})();
