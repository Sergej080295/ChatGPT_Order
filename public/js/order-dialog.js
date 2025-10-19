(() => {
  const dialog = document.getElementById('order-dialog');
  if (!dialog) return;

  const form = dialog.querySelector('form');
  const stageList = dialog.querySelector('[data-stage-list]');
  const addStageBtn = dialog.querySelector('[data-add-stage]');
  const deleteBtn = dialog.querySelector('[data-delete]');
  const closeButtons = dialog.querySelectorAll('[data-close]');
  const template = document.getElementById('stage-item-template');

  const state = {
    order: null,
    stageCatalog: [],
    removedStageIds: new Set(),
    onSave: null,
    onDelete: null
  };

  function normalizeCatalog(catalog) {
    if (!Array.isArray(catalog) || !catalog.length) {
      return [];
    }
    return catalog.map((entry) => ({
      code: String(entry.code).trim(),
      name: entry.name || entry.title || entry.label || entry.code
    }));
  }

  function fillStageSelect(select, value) {
    const catalog = state.stageCatalog.length ? state.stageCatalog : [{ code: 'laser', name: 'Лазер' }];
    select.innerHTML = '';
    catalog.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.code;
      option.textContent = entry.name;
      if (value && value === entry.code) {
        option.selected = true;
      }
      select.appendChild(option);
    });
  }

  function createStageRow(stage = {}) {
    const node = template.content.firstElementChild.cloneNode(true);
    const select = node.querySelector('select[name="stageCode"]');
    fillStageSelect(select, stage.stageCode);
    node.dataset.id = stage.id || '';
    node.querySelector('input[name="readyPercent"]').value = stage.readyPercent ?? '';
    node.querySelector('input[name="expectedPercent"]').value = stage.expectedPercent ?? '';
    node.querySelector('input[name="status"]').value = stage.status ?? '';
    node.querySelector('input[name="executor"]').value = stage.executor ?? '';
    node.querySelector('input[name="plannedFinish"]').value = stage.plannedFinish ? stage.plannedFinish.slice(0, 16) : '';
    node.querySelector('[data-remove]').addEventListener('click', () => {
      if (stage.id) {
        state.removedStageIds.add(stage.id);
      }
      node.remove();
    });
    return node;
  }

  function clearDialog() {
    state.order = null;
    state.removedStageIds.clear();
    stageList.innerHTML = '';
    form.reset();
  }

  function populateOrder(order) {
    form.elements.title.value = order.title || '';
    form.elements.number.value = order.number || '';
    form.elements.customer.value = order.customer || '';
    form.elements.status.value = order.status || '';
    form.elements.priority.value = order.priority || '';
    form.elements.manager.value = order.manager || '';
    form.elements.readyPercent.value = order.readyPercent ?? '';
    form.elements.plannedStart.value = order.plannedStart ? order.plannedStart.slice(0, 16) : '';
    form.elements.plannedFinish.value = order.plannedFinish ? order.plannedFinish.slice(0, 16) : '';
    form.elements.dueDate.value = order.dueDate ? order.dueDate.slice(0, 16) : '';
    form.elements.notes.value = order.notes || '';
    (order.stages || []).forEach((stage) => {
      stageList.appendChild(createStageRow(stage));
    });
  }

  function gatherOrderData() {
    const result = {
      title: form.elements.title.value.trim(),
      number: form.elements.number.value.trim() || null,
      customer: form.elements.customer.value.trim() || null,
      status: form.elements.status.value.trim() || null,
      priority: form.elements.priority.value.trim() || null,
      manager: form.elements.manager.value.trim() || null,
      readyPercent: form.elements.readyPercent.value ? Number(form.elements.readyPercent.value) : null,
      plannedStart: form.elements.plannedStart.value || null,
      plannedFinish: form.elements.plannedFinish.value || null,
      dueDate: form.elements.dueDate.value || null,
      notes: form.elements.notes.value || null
    };
    return result;
  }

  function gatherStageData() {
    const rows = Array.from(stageList.querySelectorAll('[data-stage-row]'));
    const catalog = state.stageCatalog.length ? state.stageCatalog : [{ code: 'laser', name: 'Лазер' }];
    const validCodes = new Set(catalog.map((item) => item.code));
    const updates = [];
    const creates = [];
    rows.forEach((row, index) => {
      const select = row.querySelector('select[name="stageCode"]');
      const code = validCodes.has(select.value) ? select.value : catalog[0]?.code || 'laser';
      const payload = {
        stageCode: code,
        readyPercent: row.querySelector('input[name="readyPercent"]').value ? Number(row.querySelector('input[name="readyPercent"]').value) : null,
        expectedPercent: row.querySelector('input[name="expectedPercent"]').value ? Number(row.querySelector('input[name="expectedPercent"]').value) : null,
        status: row.querySelector('input[name="status"]').value.trim() || null,
        executor: row.querySelector('input[name="executor"]').value.trim() || null,
        plannedFinish: row.querySelector('input[name="plannedFinish"]').value || null,
        position: index
      };
      const id = row.dataset.id;
      if (id) {
        updates.push({ id, payload });
      } else {
        creates.push(payload);
      }
    });
    const deletes = Array.from(state.removedStageIds);
    return { creates, updates, deletes };
  }

  function closeDialog() {
    dialog.close();
    clearDialog();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.order || typeof state.onSave !== 'function') {
      closeDialog();
      return;
    }
    const orderPatch = gatherOrderData();
    const stages = gatherStageData();
    const payload = {
      orderId: state.order.id,
      orderPatch,
      stages
    };
    await state.onSave(payload);
    closeDialog();
  });

  addStageBtn.addEventListener('click', () => {
    stageList.appendChild(createStageRow());
  });

  deleteBtn.addEventListener('click', async () => {
    if (!state.order || typeof state.onDelete !== 'function') {
      closeDialog();
      return;
    }
    await state.onDelete({ orderId: state.order.id });
    closeDialog();
  });

  closeButtons.forEach((btn) => {
    btn.addEventListener('click', closeDialog);
  });

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeDialog();
  });

  const api = {
    open(order, options = {}) {
      clearDialog();
      state.order = order;
      state.stageCatalog = normalizeCatalog(options.stageCatalog);
      state.onSave = typeof options.onSave === 'function' ? options.onSave : null;
      state.onDelete = typeof options.onDelete === 'function' ? options.onDelete : null;
      populateOrder(order);
      dialog.showModal();
    },
    close: closeDialog
  };

  window.PlanCoreOrderDialog = api;
})();
