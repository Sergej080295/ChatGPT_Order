(() => {
  const board = document.getElementById('stage-board');
  const counter = document.getElementById('stage-counter');
  const filterSelect = document.getElementById('stage-filter');

  if (!board || !counter || !filterSelect) {
    return;
  }

  const state = {
    catalog: [],
    stages: {},
    filter: 'all'
  };

  function formatPercent(value) {
    if (value === null || value === undefined) return '—';
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return `${Math.round(num)}%`;
  }

  function formatDate(value) {
    if (!value) return '—';
    try {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '—';
      return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    } catch (_err) {
      return '—';
    }
  }

  function updateCounter() {
    let total = 0;
    if (state.filter === 'all') {
      total = Object.values(state.stages).reduce((sum, list) => sum + list.length, 0);
    } else {
      total = (state.stages[state.filter] || []).length;
    }
    counter.textContent = `${total} карточек`;
  }

  function populateFilter() {
    const current = state.filter;
    filterSelect.innerHTML = '';
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'Все переделы';
    filterSelect.appendChild(allOption);
    state.catalog.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.code;
      option.textContent = entry.name;
      filterSelect.appendChild(option);
    });
    filterSelect.value = state.catalog.some((entry) => entry.code === current) ? current : 'all';
    state.filter = filterSelect.value;
  }

  async function markStageComplete(task) {
    await PlanCoreApi.updateStage(task.id, {
      readyPercent: 100,
      actualFinish: new Date().toISOString(),
      status: task.status || 'Готово'
    });
    await loadStages();
  }

  async function openOrderFromTask(task) {
    const order = await PlanCoreApi.getOrder(task.orderId, { includeStages: true });
    if (!order) return;
    PlanCoreOrderDialog.open(order, {
      stageCatalog: state.catalog,
      async onSave(payload) {
        if (payload.orderId) {
          await PlanCoreApi.updateOrder(payload.orderId, payload.orderPatch);
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
        await loadStages();
      },
      async onDelete(info) {
        if (info.orderId) {
          await PlanCoreApi.deleteOrder(info.orderId);
          await loadStages();
        }
      }
    });
  }

  function renderTask(task) {
    const card = document.createElement('article');
    card.className = 'pc-stage-card';

    const head = document.createElement('header');
    head.className = 'pc-stage-card__head';
    const title = document.createElement('h3');
    title.textContent = task.order?.title || task.stageName || 'Заказ';
    const subtitle = document.createElement('span');
    subtitle.textContent = task.order?.number ? `№ ${task.order.number}` : '';
    head.append(title, subtitle);

    const body = document.createElement('div');
    body.className = 'pc-stage-card__body';
    body.innerHTML = `
      <div class="pc-stage-card__row"><span>Готовность</span><strong>${formatPercent(task.readyPercent)}</strong></div>
      <div class="pc-stage-card__row"><span>Ожидание</span><strong>${formatPercent(task.expectedPercent)}</strong></div>
      <div class="pc-stage-card__row"><span>Срок</span><strong>${formatDate(task.dueDate || task.order?.dueDate)}</strong></div>
    `;

    const footer = document.createElement('footer');
    footer.className = 'pc-stage-card__footer';

    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'pc-btn pc-btn--ghost';
    doneBtn.textContent = 'Готово';
    doneBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await markStageComplete(task);
    });

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'pc-btn pc-btn--secondary';
    openBtn.textContent = 'Открыть заказ';
    openBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openOrderFromTask(task);
    });

    footer.append(doneBtn, openBtn);

    card.append(head, body, footer);
    card.addEventListener('click', () => openOrderFromTask(task));

    return card;
  }

  function renderColumns() {
    board.innerHTML = '';
    const codes = state.filter === 'all'
      ? state.catalog.map((entry) => entry.code)
      : [state.filter];

    codes.forEach((code) => {
      const stageInfo = state.catalog.find((entry) => entry.code === code) || { code, name: code };
      const column = document.createElement('section');
      column.className = 'pc-stage-column';

      const head = document.createElement('header');
      head.className = 'pc-stage-column__head';
      const title = document.createElement('h2');
      title.textContent = stageInfo.name;
      const count = document.createElement('span');
      const tasks = state.stages[code] || [];
      count.textContent = `${tasks.length}`;
      head.append(title, count);

      const list = document.createElement('div');
      list.className = 'pc-stage-column__list';
      if (!tasks.length) {
        const empty = document.createElement('div');
        empty.className = 'pc-empty pc-empty--compact';
        empty.textContent = 'Нет заказов';
        list.appendChild(empty);
      } else {
        tasks.forEach((task) => {
          list.appendChild(renderTask(task));
        });
      }

      column.append(head, list);
      board.appendChild(column);
    });

    updateCounter();
  }

  async function loadStages() {
    const overview = await PlanCoreApi.listStageOverview();
    if (Array.isArray(overview.catalog) && overview.catalog.length) {
      state.catalog = overview.catalog;
    } else if (!state.catalog.length) {
      state.catalog = await PlanCoreApi.getStageCatalog();
    }
    state.stages = overview.stages || {};
    populateFilter();
    renderColumns();
  }

  filterSelect.addEventListener('change', () => {
    state.filter = filterSelect.value;
    renderColumns();
  });

  document.addEventListener('DOMContentLoaded', loadStages, { once: true });
  loadStages();
})();
