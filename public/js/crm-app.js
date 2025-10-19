(() => {
  const board = document.getElementById('crm-board');
  const counter = document.getElementById('crm-counter');
  const searchInput = document.getElementById('crm-search');
  const createBtn = document.getElementById('crm-create');

  if (!board || !counter || !searchInput || !createBtn) {
    return;
  }

  const state = {
    orders: [],
    filter: '',
    catalog: []
  };

  function formatDate(value) {
    if (!value) return '';
    try {
      const date = new Date(value);
      return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    } catch (_err) {
      return value;
    }
  }

  function formatProgress(order) {
    const ready = Number.isFinite(order.readyPercent) ? Math.round(order.readyPercent) : null;
    if (ready === null) return '—';
    return `${ready}%`;
  }

  function filterOrders() {
    const term = state.filter.trim().toLowerCase();
    if (!term) return state.orders;
    return state.orders.filter((order) => {
      const haystack = [order.title, order.number, order.customer, order.status, order.priority]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(term);
    });
  }

  function renderEmpty() {
    const empty = document.createElement('div');
    empty.className = 'pc-empty';
    empty.textContent = 'Заказы не найдены';
    board.replaceChildren(empty);
  }

  function createStagePills(order) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pc-pill-list';
    (order.stages || []).forEach((stage) => {
      const pill = document.createElement('span');
      pill.className = 'pc-pill';
      pill.textContent = `${stage.stageName || stage.stageCode} · ${stage.readyPercent ?? 0}%`;
      wrapper.appendChild(pill);
    });
    if (!wrapper.children.length) {
      const pill = document.createElement('span');
      pill.className = 'pc-pill pc-pill--muted';
      pill.textContent = 'Нет переделов';
      wrapper.appendChild(pill);
    }
    return wrapper;
  }

  function renderCard(order) {
    const card = document.createElement('article');
    card.className = 'pc-card';

    const header = document.createElement('header');
    header.className = 'pc-card__head';

    const title = document.createElement('h2');
    title.className = 'pc-card__title';
    title.textContent = order.title || 'Без названия';

    const number = document.createElement('span');
    number.className = 'pc-card__subtitle';
    number.textContent = order.number ? `№ ${order.number}` : 'Без номера';

    header.appendChild(title);
    header.appendChild(number);

    const body = document.createElement('div');
    body.className = 'pc-card__body';

    const info = document.createElement('div');
    info.className = 'pc-card__info';

    const row1 = document.createElement('div');
    row1.className = 'pc-card__row';
    row1.innerHTML = `Клиент: <strong>${order.customer || '—'}</strong>`;

    const row2 = document.createElement('div');
    row2.className = 'pc-card__row';
    row2.innerHTML = `Статус: <strong>${order.status || '—'}</strong>`;

    const row3 = document.createElement('div');
    row3.className = 'pc-card__row';
    row3.innerHTML = `Срок: <strong>${formatDate(order.dueDate) || '—'}</strong>`;

    info.append(row1, row2, row3);

    const progress = document.createElement('div');
    progress.className = 'pc-card__progress';
    progress.innerHTML = `<span>Готовность</span><strong>${formatProgress(order)}</strong>`;

    body.append(info, progress, createStagePills(order));

    const footer = document.createElement('footer');
    footer.className = 'pc-card__footer';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'pc-btn pc-btn--secondary';
    openBtn.textContent = 'Открыть';
    openBtn.addEventListener('click', () => openOrder(order.id));

    footer.append(openBtn);

    card.append(header, body, footer);
    return card;
  }

  function render() {
    const filtered = filterOrders();
    counter.textContent = `${filtered.length} заказов`;
    if (!filtered.length) {
      renderEmpty();
      return;
    }
    board.innerHTML = '';
    filtered.forEach((order) => {
      board.appendChild(renderCard(order));
    });
  }

  async function refreshOrders() {
    const orders = await PlanCoreApi.listOrders({ board: 'crm', includeStages: true });
    state.orders = orders;
    render();
  }

  async function ensureCatalog() {
    if (!state.catalog.length) {
      state.catalog = await PlanCoreApi.getStageCatalog();
    }
  }

  async function openOrder(orderId) {
    await ensureCatalog();
    let order = null;
    if (orderId) {
      order = await PlanCoreApi.getOrder(orderId, { includeStages: true });
      if (!order) return;
    } else {
      order = {
        id: null,
        title: '',
        number: '',
        customer: '',
        status: '',
        priority: '',
        manager: '',
        readyPercent: null,
        plannedStart: null,
        plannedFinish: null,
        dueDate: null,
        notes: '',
        stages: []
      };
    }

    PlanCoreOrderDialog.open(order, {
      stageCatalog: state.catalog,
      async onSave(payload) {
        if (payload.orderId) {
          await PlanCoreApi.updateOrder(payload.orderId, payload.orderPatch);
        } else {
          const created = await PlanCoreApi.createOrder({ ...payload.orderPatch, stages: [] });
          payload.orderId = created?.id;
        }

        if (payload.orderId) {
          for (const update of payload.stages.updates) {
            await PlanCoreApi.updateStage(update.id, update.payload);
          }
          for (const create of payload.stages.creates) {
            await PlanCoreApi.createStage(payload.orderId, create);
          }
          for (const removeId of payload.stages.deletes) {
            await PlanCoreApi.deleteStage(removeId);
          }
        }
        await refreshOrders();
      },
      async onDelete(info) {
        if (info.orderId) {
          await PlanCoreApi.deleteOrder(info.orderId);
          await refreshOrders();
        }
      }
    });
  }

  createBtn.addEventListener('click', () => openOrder(null));

  searchInput.addEventListener('input', () => {
    state.filter = searchInput.value || '';
    render();
  });

  document.addEventListener('DOMContentLoaded', refreshOrders, { once: true });
  refreshOrders();
})();
