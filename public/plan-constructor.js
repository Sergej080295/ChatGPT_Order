(() => {
  const STORAGE_KEY = 'plannerConstructorTemplates';
  const ROLE_KEY = 'plannerConstructorRoles';
  const VISIBILITY_KEY = 'plannerConstructorEnabled';

  const defaultColumns = [
    { id: 'name', label: 'Заказ' },
    { id: 'stage', label: 'Передел' },
    { id: 'status', label: 'Статус' },
    { id: 'progress', label: 'Готовность' },
    { id: 'services', label: 'Сумма услуг' },
    { id: 'due', label: 'Срок' },
    { id: 'overdue', label: 'Просрочка' },
    { id: 'comments', label: 'Комментарии' },
    { id: 'assignee', label: 'Ответственный' },
  ];

  const sampleOrders = [
    {
      id: 'A-1024',
      name: 'Лазерный раскрой — партия 1',
      stage: 'Лазер',
      status: 'В работе',
      progress: 55,
      services: 120000,
      due: '2024-09-06',
      overdue: false,
      comments: 3,
      assignee: 'Иванов',
    },
    {
      id: 'B-5812',
      name: 'Гибка корпуса',
      stage: 'Гибка',
      status: 'Ожидает запуск',
      progress: 10,
      services: 58000,
      due: '2024-09-02',
      overdue: true,
      comments: 1,
      assignee: 'Сергеев',
    },
    {
      id: 'C-9921',
      name: 'Порошковая покраска',
      stage: 'Покраска',
      status: 'Запланировано',
      progress: 0,
      services: 36500,
      due: '2024-09-08',
      overdue: false,
      comments: 0,
      assignee: 'Команда смены 2',
    },
  ];

  const roleOptions = [
    { id: 'admin', title: 'Администратор', description: 'Полный доступ: создание, редактирование, публикация страниц.' },
    { id: 'planner', title: 'Планировщик', description: 'Изменение шаблонов данных, настройка фильтров и источников.' },
    { id: 'viewer', title: 'Наблюдатель', description: 'Просмотр доступных отчётов и фильтров.' },
  ];

  const filterOptions = [
    { id: 'with-overdue', label: 'Только с просрочкой' },
    { id: 'with-comments', label: 'Есть комментарии' },
    { id: 'ready', label: 'Готовность ≥ 80%' },
    { id: 'has-remake', label: 'Есть передел' },
  ];

  let templates = loadTemplates();
  let selectedTemplateId = templates.find((t) => t.visible)?.id || templates[0]?.id || null;
  let sorting = { column: null, direction: 'asc' };

  document.addEventListener('DOMContentLoaded', () => {
    bindControls();
    renderRoles();
    renderTemplates();
    populateColumns();
    populateFilterOptions();
    updateVisibilityToggle();
    renderPreview();
  });

  function bindControls() {
    document.querySelector('[data-action="add-template"]').addEventListener('click', () => openEditor());

    document.getElementById('constructor-visibility').addEventListener('change', (event) => {
      try {
        localStorage.setItem(VISIBILITY_KEY, event.target.checked ? '1' : '0');
      } catch (_err) {
        /* ignore */
      }
      toggleAccessByVisibility();
    });

    document.getElementById('active-template').addEventListener('change', (event) => {
      selectedTemplateId = event.target.value || null;
      renderPreview();
    });

    document.getElementById('preview-mode').addEventListener('change', renderPreview);

    document.body.addEventListener('click', (event) => {
      const action = event.target.dataset.action;
      if (action === 'close-editor') closeEditor();
      if (action === 'save-template') saveTemplate();
      if (action === 'close-order') closeOrderEditor();
      if (action === 'save-order') saveOrder();
    });
  }

  function loadTemplates() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_err) {
      /* ignore */
    }
    return [
      {
        id: 'laser-gantt',
        name: 'Гант по лазеру',
        type: 'gantt',
        columns: defaultColumns.map((c) => c.id),
        filters: ['with-overdue'],
        visible: true,
      },
      {
        id: 'orders-table',
        name: 'Заказы и переделы',
        type: 'table',
        columns: defaultColumns.map((c) => c.id),
        filters: ['with-comments'],
        visible: true,
      },
    ];
  }

  function persistTemplates() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
    } catch (_err) {
      /* ignore */
    }
  }

  function renderRoles() {
    const container = document.getElementById('role-grid');
    const saved = loadRoles();
    container.innerHTML = '';
    roleOptions.forEach((role) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'role-card';
      const label = document.createElement('label');
      label.className = 'toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = saved.includes(role.id);
      checkbox.addEventListener('change', () => saveRoles(role.id, checkbox.checked));
      const text = document.createElement('div');
      text.innerHTML = `<strong>${role.title}</strong><br/><small>${role.description}</small>`;
      label.appendChild(checkbox);
      label.appendChild(text);
      wrapper.appendChild(label);
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'Доступ разрешён';
      badge.hidden = !checkbox.checked;
      checkbox.addEventListener('change', () => {
        badge.hidden = !checkbox.checked;
      });
      wrapper.appendChild(badge);
      container.appendChild(wrapper);
    });
  }

  function loadRoles() {
    try {
      const raw = localStorage.getItem(ROLE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_err) {
      /* ignore */
    }
    return ['admin'];
  }

  function saveRoles(roleId, enabled) {
    const roles = new Set(loadRoles());
    if (enabled) roles.add(roleId);
    else roles.delete(roleId);
    try {
      localStorage.setItem(ROLE_KEY, JSON.stringify([...roles]));
    } catch (_err) {
      /* ignore */
    }
  }

  function updateVisibilityToggle() {
    const checkbox = document.getElementById('constructor-visibility');
    const enabled = isConstructorEnabled();
    checkbox.checked = enabled;
    toggleAccessByVisibility();
  }

  function isConstructorEnabled() {
    try {
      return localStorage.getItem(VISIBILITY_KEY) === '1';
    } catch (_err) {
      return false;
    }
  }

  function toggleAccessByVisibility() {
    document.body.classList.toggle('constructor-disabled', !isConstructorEnabled());
  }

  function renderTemplates() {
    const list = document.getElementById('template-list');
    const select = document.getElementById('active-template');
    select.innerHTML = '';
    list.innerHTML = '';

    templates.forEach((tpl) => {
      const card = document.createElement('article');
      card.className = 'template-card';
      const header = document.createElement('header');
      const title = document.createElement('div');
      title.innerHTML = `<strong>${tpl.name}</strong><br><small>${describeTemplate(tpl)}</small>`;
      header.appendChild(title);
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = tpl.visible ? 'Активен' : 'Скрыт';
      header.appendChild(badge);
      card.appendChild(header);

      const filters = document.createElement('div');
      filters.className = 'chips';
      tpl.filters?.forEach((f) => {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = filterOptions.find((opt) => opt.id === f)?.label || f;
        filters.appendChild(chip);
      });
      card.appendChild(filters);

      const actions = document.createElement('div');
      actions.className = 'template-actions';
      const editBtn = document.createElement('button');
      editBtn.textContent = 'Редактировать';
      editBtn.addEventListener('click', () => openEditor(tpl));
      const toggleBtn = document.createElement('button');
      toggleBtn.textContent = tpl.visible ? 'Скрыть' : 'Показать';
      toggleBtn.addEventListener('click', () => toggleTemplateVisibility(tpl.id));
      actions.appendChild(editBtn);
      actions.appendChild(toggleBtn);
      card.appendChild(actions);

      list.appendChild(card);

      const option = document.createElement('option');
      option.value = tpl.id;
      option.textContent = tpl.name;
      option.selected = tpl.id === selectedTemplateId;
      select.appendChild(option);
    });
  }

  function describeTemplate(tpl) {
    if (tpl.type === 'table') return 'Таблица заказов с сортировкой и итогами';
    if (tpl.type === 'gantt') return 'Диаграмма Ганта по переделам';
    if (tpl.type === 'chart') return 'График ключевых показателей';
    if (tpl.type === 'tiles') return 'Плитки для дашборда';
    if (tpl.type === 'dashboard') return 'Комбинированный дашборд';
    return 'Пользовательский шаблон';
  }

  function openEditor(template = null) {
    const editor = document.getElementById('template-editor');
    editor.hidden = false;
    document.getElementById('editor-title').textContent = template ? 'Редактировать шаблон' : 'Новый шаблон';
    document.getElementById('template-name').value = template?.name || '';
    document.getElementById('template-type').value = template?.type || 'table';
    document.getElementById('template-visible').checked = Boolean(template?.visible);
    document.getElementById('template-columns').value = null;
    [...document.getElementById('template-columns').options].forEach((opt) => {
      opt.selected = template?.columns?.includes(opt.value);
    });
    document.getElementById('template-filters-editor').querySelectorAll('label input').forEach((checkbox) => {
      checkbox.checked = template?.filters?.includes(checkbox.value) || false;
    });
    editor.dataset.editing = template?.id || '';
  }

  function closeEditor() {
    const editor = document.getElementById('template-editor');
    editor.hidden = true;
    delete editor.dataset.editing;
  }

  function populateColumns() {
    const select = document.getElementById('template-columns');
    select.innerHTML = '';
    defaultColumns.forEach((col) => {
      const option = document.createElement('option');
      option.value = col.id;
      option.textContent = col.label;
      select.appendChild(option);
    });
  }

  function populateFilterOptions() {
    const container = document.getElementById('template-filters-editor');
    container.innerHTML = '';
    filterOptions.forEach((filter) => {
      const label = document.createElement('label');
      label.className = 'toggle';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = filter.id;
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(filter.label));
      container.appendChild(label);
    });
  }

  function saveTemplate() {
    const name = document.getElementById('template-name').value.trim();
    const type = document.getElementById('template-type').value;
    const visible = document.getElementById('template-visible').checked;
    const columns = [...document.getElementById('template-columns').selectedOptions].map((opt) => opt.value);
    const filters = [...document.getElementById('template-filters-editor').querySelectorAll('input:checked')].map((el) => el.value);
    const editingId = document.getElementById('template-editor').dataset.editing;

    if (!name) {
      alert('Введите название шаблона');
      return;
    }

    if (editingId) {
      templates = templates.map((tpl) => (tpl.id === editingId ? { ...tpl, name, type, visible, columns, filters } : tpl));
      selectedTemplateId = editingId;
    } else {
      const id = `${type}-${Date.now()}`;
      templates.push({ id, name, type, visible, columns, filters });
      selectedTemplateId = id;
    }

    persistTemplates();
    renderTemplates();
    renderPreview();
    closeEditor();
  }

  function toggleTemplateVisibility(id) {
    templates = templates.map((tpl) => (tpl.id === id ? { ...tpl, visible: !tpl.visible } : tpl));
    persistTemplates();
    renderTemplates();
    renderPreview();
  }

  function renderPreview() {
    const preview = document.getElementById('preview-area');
    preview.innerHTML = '';
    if (!isConstructorEnabled()) {
      preview.classList.add('empty');
      preview.textContent = 'Конструктор отключён в настройках профиля.';
      return;
    }
    const tpl = templates.find((t) => t.id === selectedTemplateId);
    if (!tpl) {
      preview.classList.add('empty');
      preview.textContent = 'Нет выбранного шаблона';
      return;
    }
    preview.classList.remove('empty');

    if (tpl.type === 'table') {
      preview.appendChild(renderTableWidget(tpl));
    } else if (tpl.type === 'gantt') {
      preview.appendChild(renderGanttWidget(tpl));
    } else {
      const grid = document.createElement('div');
      grid.className = 'grid-preview';
      grid.appendChild(renderTilesWidget('Карточки статусов', [
        ['В работе', '12'],
        ['Готово', '7'],
        ['С просрочкой', '3'],
      ]));
      grid.appendChild(renderChartPlaceholder('График загрузки', 'Линия производства за неделю'));
      preview.appendChild(grid);
    }
  }

  function applyFilters(rows, tpl) {
    return rows.filter((order) => {
      const checks = tpl.filters || [];
      if (checks.includes('with-overdue') && !order.overdue) return false;
      if (checks.includes('with-comments') && order.comments === 0) return false;
      if (checks.includes('ready') && order.progress < 80) return false;
      if (checks.includes('has-remake') && !order.stage) return false;
      return true;
    });
  }

  function renderTableWidget(tpl) {
    const widget = document.createElement('div');
    widget.className = 'widget-card table-widget';

    const info = document.createElement('div');
    info.className = 'chip';
    info.textContent = 'Двойной клик по заказу открывает редактирование';
    widget.appendChild(info);

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    tpl.columns?.forEach((col) => {
      const columnInfo = defaultColumns.find((c) => c.id === col);
      if (!columnInfo) return;
      const th = document.createElement('th');
      th.textContent = columnInfo.label;
      th.addEventListener('click', () => sortBy(col));
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const filtered = applyFilters([...sampleOrders], tpl);
    filtered.sort(compareRows);
    filtered.forEach((row) => {
      const tr = document.createElement('tr');
      tpl.columns?.forEach((col) => {
        const td = document.createElement('td');
        td.appendChild(renderCell(col, row));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    widget.appendChild(table);
    const footer = document.createElement('div');
    footer.className = 'subtle';
    footer.textContent = `Итого заказов: ${filtered.length}`;
    widget.appendChild(footer);
    return widget;
  }

  function renderCell(col, row) {
    if (col === 'name') {
      const span = document.createElement('span');
      span.className = 'order-link';
      span.textContent = row.name;
      span.addEventListener('dblclick', () => openOrderEditor(row));
      return span;
    }
    if (col === 'progress') return document.createTextNode(`${row.progress}%`);
    if (col === 'services') return document.createTextNode(`${row.services.toLocaleString('ru-RU')} ₽`);
    if (col === 'overdue') return document.createTextNode(row.overdue ? 'Да' : 'Нет');
    return document.createTextNode(row[col] ?? '');
  }

  function sortBy(column) {
    if (sorting.column === column) {
      sorting.direction = sorting.direction === 'asc' ? 'desc' : 'asc';
    } else {
      sorting = { column, direction: 'asc' };
    }
    renderPreview();
  }

  function compareRows(a, b) {
    const { column, direction } = sorting;
    if (!column) return 0;
    const av = a[column];
    const bv = b[column];
    if (av === bv) return 0;
    const result = av > bv ? 1 : -1;
    return direction === 'asc' ? result : -result;
  }

  function renderGanttWidget(tpl) {
    const widget = document.createElement('div');
    widget.className = 'widget-card';
    const title = document.createElement('h4');
    title.textContent = tpl.name;
    widget.appendChild(title);
    const list = document.createElement('div');
    applyFilters(sampleOrders, tpl).forEach((order) => {
      const row = document.createElement('div');
      row.className = 'gantt-row';
      const label = document.createElement('div');
      label.textContent = `${order.stage}: ${order.name}`;
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.width = `${20 + order.progress * 0.8}%`;
      row.appendChild(label);
      row.appendChild(bar);
      list.appendChild(row);
    });
    widget.appendChild(list);
    return widget;
  }

  function renderTilesWidget(title, pairs) {
    const widget = document.createElement('div');
    widget.className = 'widget-card';
    const h = document.createElement('h4');
    h.textContent = title;
    widget.appendChild(h);
    const tiles = document.createElement('div');
    tiles.className = 'grid-preview';
    pairs.forEach(([label, value]) => {
      const tile = document.createElement('div');
      tile.className = 'widget-card';
      tile.innerHTML = `<strong>${label}</strong><div class="eyebrow" style="color:${value > 10 ? '#b91c1c' : '#0ea5e9'}">${value}</div>`;
      tiles.appendChild(tile);
    });
    widget.appendChild(tiles);
    return widget;
  }

  function renderChartPlaceholder(title, subtitle) {
    const widget = document.createElement('div');
    widget.className = 'widget-card';
    const h = document.createElement('h4');
    h.textContent = title;
    widget.appendChild(h);
    const p = document.createElement('p');
    p.className = 'subtle';
    p.textContent = subtitle;
    widget.appendChild(p);
    const placeholder = document.createElement('div');
    placeholder.style.height = '180px';
    placeholder.style.border = '1px dashed var(--border)';
    placeholder.style.borderRadius = '8px';
    placeholder.style.display = 'grid';
    placeholder.style.placeItems = 'center';
    placeholder.textContent = 'Тут может быть график (линейный/столбчатый/круговой)';
    widget.appendChild(placeholder);
    return widget;
  }

  function openOrderEditor(order) {
    const modal = document.getElementById('order-editor');
    const form = document.getElementById('order-form');
    modal.dataset.orderId = order.id;
    form.innerHTML = '';
    ['name', 'stage', 'status', 'progress', 'services', 'due', 'assignee'].forEach((field) => {
      const label = document.createElement('label');
      label.className = 'stack';
      label.innerHTML = `<span>${field}</span>`;
      const input = document.createElement('input');
      input.value = order[field];
      input.dataset.field = field;
      label.appendChild(input);
      form.appendChild(label);
    });
    modal.hidden = false;
  }

  function closeOrderEditor() {
    const modal = document.getElementById('order-editor');
    modal.hidden = true;
    delete modal.dataset.orderId;
  }

  function saveOrder() {
    const modal = document.getElementById('order-editor');
    const id = modal.dataset.orderId;
    const form = document.getElementById('order-form');
    const order = sampleOrders.find((o) => o.id === id);
    if (!order) return closeOrderEditor();
    form.querySelectorAll('input').forEach((input) => {
      const field = input.dataset.field;
      if (field === 'progress') {
        order[field] = Number(input.value) || 0;
      } else if (field === 'services') {
        order[field] = Number(input.value) || 0;
      } else {
        order[field] = input.value;
      }
    });
    closeOrderEditor();
    renderPreview();
  }
})();
