(() => {
  const state = {
    user: null,
    settings: { enabled: false },
    presets: [],
    selectedId: null,
    loading: false
  };

  const els = {
    notice: document.getElementById('reportsNotice'),
    presetList: document.getElementById('reportPresetList'),
    reloadBtn: document.getElementById('reportsReloadBtn'),
    presetForm: document.getElementById('reportPresetForm'),
    presetTitle: document.getElementById('reportEditorTitle'),
    nameInput: document.getElementById('reportName'),
    descriptionInput: document.getElementById('reportDescription'),
    activeInput: document.getElementById('reportActive'),
    publicInput: document.getElementById('reportPublic'),
    rolesInput: document.getElementById('reportRoles'),
    layoutTypeInput: document.getElementById('reportLayoutType'),
    filterStatusInput: document.getElementById('reportFilterStatus'),
    filterFromInput: document.getElementById('reportFilterFrom'),
    filterToInput: document.getElementById('reportFilterTo'),
    filterOverdueInput: document.getElementById('reportFilterOverdue'),
    widgetList: document.getElementById('reportWidgets'),
    addWidgetBtn: document.getElementById('reportAddWidget'),
    previewBtn: document.getElementById('reportPreviewBtn'),
    saveBtn: document.getElementById('reportSave'),
    deleteBtn: document.getElementById('reportDelete'),
    visibilityBtn: document.getElementById('reportToggleVisibility'),
    settingsToggle: document.getElementById('reportsEnabled'),
    settingsLabel: document.getElementById('reportsEnabledLabel'),
    preview: document.getElementById('reportPreview'),
    templateStages: document.getElementById('reportPresetTemplateStages'),
    templateTable: document.getElementById('reportPresetTemplateTable')
  };

  const widgetTypes = [
    { value: 'table', label: 'Таблица' },
    { value: 'gantt', label: 'Гант' },
    { value: 'chart', label: 'График' },
    { value: 'route', label: 'Маршрут заказа' },
    { value: 'kpi', label: 'KPI' },
    { value: 'dashboard', label: 'Дашборд' }
  ];

  const dataSources = [
    { value: 'orders', label: 'Заказы' },
    { value: 'stages', label: 'Переделы' },
    { value: 'route', label: 'Маршруты' }
  ];

  const sourceDetails = {
    stages: [
      { value: 'laser', label: 'Лазер' },
      { value: 'bend', label: 'Гибка' },
      { value: 'paint', label: 'Покраска' },
      { value: 'other', label: 'Другой передел' }
    ],
    orders: [
      { value: 'summary', label: 'Сводка заказа' },
      { value: 'finance', label: 'Финансы' }
    ],
    route: [
      { value: 'timeline', label: 'Таймлайн' },
      { value: 'checks', label: 'Контрольные точки' }
    ]
  };

  const columnOptions = {
    orders: [
      { value: 'number', label: 'Номер' },
      { value: 'status', label: 'Статус' },
      { value: 'customer', label: 'Клиент' },
      { value: 'total', label: 'Сумма' },
      { value: 'ready', label: 'Готовность' },
      { value: 'overdue', label: 'Просрочка' }
    ],
    stages: [
      { value: 'stage', label: 'Передел' },
      { value: 'workcenter', label: 'Участок' },
      { value: 'start', label: 'Старт' },
      { value: 'finish', label: 'Финиш' },
      { value: 'duration', label: 'Длительность' },
      { value: 'overdue', label: 'Просрочка' }
    ],
    route: [
      { value: 'step', label: 'Шаг' },
      { value: 'status', label: 'Статус' },
      { value: 'responsible', label: 'Ответственный' },
      { value: 'deadline', label: 'Дедлайн' }
    ]
  };

  function renderNotice(message, tone = 'info') {
    if (!els.notice) return;
    if (!message) {
      els.notice.hidden = true;
      els.notice.textContent = '';
      els.notice.dataset.tone = '';
      return;
    }
    els.notice.hidden = false;
    els.notice.textContent = message;
    els.notice.dataset.tone = tone;
  }

  async function fetchJson(url, options = {}) {
    const merged = {
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      credentials: 'same-origin',
      ...options
    };
    if (merged.body && typeof merged.body === 'object' && !(merged.body instanceof FormData)) {
      merged.headers['Content-Type'] = 'application/json';
      merged.body = JSON.stringify(merged.body);
    }
    const res = await fetch(url, merged);
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await res.json().catch(() => null) : null;
    if (!res.ok) {
      const error = new Error((data && data.error) || `Ошибка ${res.status}`);
      error.status = res.status;
      error.payload = data;
      throw error;
    }
    return data;
  }

  function hasPermission(key) {
    return !!state.user?.permissions?.[key];
  }

  function parseRolesInput(value) {
    if (typeof value !== 'string') return [];
    return value
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .filter((item, idx, arr) => arr.indexOf(item) === idx);
  }

  function serializeJsonTextarea(value) {
    if (typeof value !== 'string') return {};
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_err) {
      return {};
    }
  }

  function stringifyJson(value) {
    if (value == null) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch (_err) {
      return '';
    }
  }

  function buildWidgetRow(widget = {}, index = 0) {
    const row = document.createElement('div');
    row.className = 'reports-widget';
    row.dataset.index = String(index);

    const title = document.createElement('input');
    title.type = 'text';
    title.value = widget.title || '';
    title.placeholder = 'Название виджета';
    title.required = true;
    title.dataset.role = 'title';

    const type = document.createElement('select');
    type.dataset.role = 'type';
    widgetTypes.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      if (widget.type === entry.value) option.selected = true;
      type.appendChild(option);
    });

    const source = document.createElement('select');
    source.dataset.role = 'source';
    dataSources.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      if (widget.dataSource === entry.value) option.selected = true;
      source.appendChild(option);
    });

    const detail = document.createElement('select');
    detail.dataset.role = 'detail';
    setDetailOptions(source.value, detail, widget.detail);

    const columns = createMultiSelect(columnOptions[source.value] || [], widget.fields || []);
    columns.dataset.role = 'columns';

    const filterControls = createFilterControls(widget.filters);

    const preview = document.createElement('div');
    preview.className = 'reports-preview';
    preview.dataset.role = 'preview';

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'pc-btn pc-btn--ghost';
    remove.textContent = 'Удалить';
    remove.addEventListener('click', () => {
      row.remove();
      renumberWidgets();
      renderPreviewSkeleton();
    });

    function syncOptions() {
      setDetailOptions(source.value, detail, detail.value);
      replaceMultiSelectOptions(columns, columnOptions[source.value] || []);
      updateWidgetPreview(row);
      renderPreviewSkeleton();
    }

    [title, type, source, detail, columns, filterControls.field, filterControls.operator, filterControls.value].forEach((node) => {
      node?.addEventListener('input', syncOptions);
      node?.addEventListener('change', syncOptions);
    });

    row.append(
      createField('Название', title),
      createField('Тип', type),
      createField('Источник данных', source),
      createField('Детализация источника', detail),
      createField('Поля/показатели', columns),
      createField('Фильтр', filterControls.wrapper),
      preview,
      remove
    );

    updateWidgetPreview(row);
    return row;
  }

  function createMultiSelect(options, values = []) {
    const select = document.createElement('select');
    select.multiple = true;
    select.size = 4;
    replaceMultiSelectOptions(select, options, values);
    return select;
  }

  function replaceMultiSelectOptions(select, options, values = []) {
    if (!select) return;
    const currentValues = values.length ? values : Array.from(select.selectedOptions).map((opt) => opt.value);
    select.innerHTML = '';
    options.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      if (currentValues.includes(entry.value)) option.selected = true;
      select.appendChild(option);
    });
  }

  function setDetailOptions(sourceValue, select, current) {
    const options = sourceDetails[sourceValue] || [];
    select.innerHTML = '';
    if (!options.length) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'Не требуется';
      select.appendChild(empty);
      return;
    }
    options.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      if (current && current === entry.value) option.selected = true;
      select.appendChild(option);
    });
  }

  function createFilterControls(filters) {
    const wrapper = document.createElement('div');
    wrapper.className = 'reports-inline';
    const firstFilter = Array.isArray(filters) && filters.length ? filters[0] : filters || {};
    const field = document.createElement('select');
    field.innerHTML = '';
    ['status', 'overdue', 'stage', 'workcenter', 'kpi'].forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value === 'kpi' ? 'KPI' : value;
      if (firstFilter.field === value) option.selected = true;
      field.appendChild(option);
    });

    const operator = document.createElement('select');
    ['=', '!=', '>', '<', 'contains'].forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      if (firstFilter.operator === value) option.selected = true;
      operator.appendChild(option);
    });

    const value = document.createElement('input');
    value.type = 'text';
    value.placeholder = 'значение';
    value.value = firstFilter.value || '';

    wrapper.append(field, operator, value);
    return { wrapper, field, operator, value };
  }

  function updateWidgetPreview(row) {
    const preview = row.querySelector('[data-role="preview"]');
    if (!preview) return;
    const title = row.querySelector('input[data-role="title"]')?.value || 'Без названия';
    const type = row.querySelector('select[data-role="type"]')?.selectedOptions?.[0]?.textContent || '';
    const source = row.querySelector('select[data-role="source"]')?.selectedOptions?.[0]?.textContent || '';
    const detail = row.querySelector('select[data-role="detail"]')?.selectedOptions?.[0]?.textContent || '';
    const columns = Array.from(row.querySelector('select[data-role="columns"]')?.selectedOptions || []).map((opt) => opt.textContent);
    preview.innerHTML = `<strong>${title}</strong>: ${type} · ${source}${detail ? ` (${detail})` : ''}`;
    if (columns.length) {
      const chips = document.createElement('div');
      chips.className = 'reports-chip-list';
      columns.forEach((col) => {
        const chip = document.createElement('span');
        chip.className = 'reports-chip';
        chip.textContent = col;
        chips.appendChild(chip);
      });
      preview.appendChild(chips);
    }
  }

  function renderPreviewSkeleton(message = 'Добавьте виджеты, чтобы увидеть предпросмотр страницы.') {
    if (!els.preview) return;
    els.preview.innerHTML = '<strong>Предпросмотр страницы</strong>';
    const empty = document.createElement('div');
    empty.className = 'reports-mini-list';
    empty.textContent = message;
    els.preview.appendChild(empty);
  }

  function renderPreviewLoading() {
    if (!els.preview) return;
    els.preview.innerHTML = '<strong>Предпросмотр страницы</strong><div class="reports-mini-list">Загрузка данных…</div>';
  }

  function renderPreviewContent(widgets, previews) {
    if (!els.preview) return;
    els.preview.innerHTML = '<strong>Предпросмотр страницы</strong>';
    const list = document.createElement('div');
    list.className = 'reports-mini-list';
    widgets.forEach((widget, idx) => {
      const item = document.createElement('div');
      const columns = Array.isArray(widget.fields) && widget.fields.length ? ` · поля: ${widget.fields.join(', ')}` : '';
      const detail = widget.detail ? ` · ${widget.detail}` : '';
      item.innerHTML = `<div><strong>${idx + 1}. ${widget.title || 'Виджет'}</strong> (${widget.type}, ${widget.dataSource}${detail})${columns}</div>`;
      const preview = previews[idx];
      if (preview && Array.isArray(preview.rows) && preview.rows.length) {
        const table = document.createElement('table');
        table.className = 'pc-table';
        const head = document.createElement('thead');
        const headRow = document.createElement('tr');
        preview.columns.forEach((col) => {
          const cell = document.createElement('th');
          cell.textContent = col;
          headRow.appendChild(cell);
        });
        head.appendChild(headRow);
        const body = document.createElement('tbody');
        preview.rows.slice(0, 5).forEach((row) => {
          const tr = document.createElement('tr');
          preview.columns.forEach((colKey) => {
            const td = document.createElement('td');
            td.textContent = row[colKey] ?? '';
            tr.appendChild(td);
          });
          body.appendChild(tr);
        });
        table.append(head, body);
        item.appendChild(table);
        const hint = document.createElement('div');
        hint.className = 'reports-chip-list';
        hint.innerHTML = `<span class="reports-chip">Показаны первые ${Math.min(5, preview.rows.length)} из ${preview.total || preview.rows.length} строк</span>`;
        item.appendChild(hint);
      } else {
        const empty = document.createElement('div');
        empty.className = 'reports-chip-list';
        empty.innerHTML = '<span class="reports-chip">Нет данных для отображения</span>';
        item.appendChild(empty);
      }
      list.appendChild(item);
    });
    els.preview.appendChild(list);
  }

  function createField(labelText, control) {
    const field = document.createElement('label');
    field.className = 'reports-field';
    const label = document.createElement('span');
    label.textContent = labelText;
    field.append(label, control);
    return field;
  }

  function renumberWidgets() {
    if (!els.widgetList) return;
    els.widgetList.querySelectorAll('.reports-widget').forEach((node, index) => {
      node.dataset.index = String(index);
    });
  }

  function setFormBusy(isBusy) {
    state.loading = isBusy;
    const disable = !!isBusy;
    [
      els.presetForm,
      els.saveBtn,
      els.deleteBtn,
      els.addWidgetBtn,
      els.reloadBtn,
      els.settingsToggle
    ].forEach((control) => {
      if (control) control.disabled = disable;
    });
  }

  function renderPresetList() {
    if (!els.presetList) return;
    els.presetList.innerHTML = '';
    if (!state.presets.length) {
      const empty = document.createElement('div');
      empty.className = 'reports-empty';
      empty.textContent = 'Пока нет сохранённых пресетов';
      els.presetList.appendChild(empty);
      return;
    }
    state.presets.forEach((preset) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'reports-preset';
      item.dataset.active = preset.isActive ? '1' : '0';
      item.dataset.visible = preset.isVisible === false ? '0' : '1';
      item.textContent = preset.name || `Пресет ${preset.id}`;
      item.addEventListener('click', () => selectPreset(preset));
      els.presetList.appendChild(item);
    });
  }

  function updateVisibilityButton(preset) {
    if (!els.visibilityBtn) return;
    if (!preset || !preset.id) {
      els.visibilityBtn.hidden = true;
      return;
    }
    els.visibilityBtn.hidden = false;
    const visible = preset.isVisible !== false;
    els.visibilityBtn.textContent = visible ? 'Скрыть в моих отчётах' : 'Показывать в моих отчётах';
    els.visibilityBtn.dataset.visible = visible ? '1' : '0';
  }

  function fillForm(preset) {
    if (!els.presetForm) return;
    const current = preset || {};
    state.selectedId = current.id || null;
    els.presetTitle.textContent = current.id ? `Редактирование: ${current.name || 'Пресет'}` : 'Новый пресет';
    if (els.nameInput) els.nameInput.value = current.name || '';
    if (els.descriptionInput) els.descriptionInput.value = current.description || '';
    if (els.activeInput) els.activeInput.checked = current.isActive !== false;
    if (els.publicInput) els.publicInput.checked = current.isPublic !== false;
    if (els.rolesInput) els.rolesInput.value = Array.isArray(current.allowedRoles) ? current.allowedRoles.join(', ') : '';
    if (els.layoutTypeInput) els.layoutTypeInput.value = current.layout?.mode || 'grid';
    if (els.filterStatusInput) els.filterStatusInput.value = current.filters?.status || '';
    if (els.filterFromInput) els.filterFromInput.value = current.filters?.dateFrom || '';
    if (els.filterToInput) els.filterToInput.value = current.filters?.dateTo || '';
    if (els.filterOverdueInput) els.filterOverdueInput.checked = current.filters?.overdueOnly || false;

    if (els.widgetList) {
      els.widgetList.innerHTML = '';
      const widgets = Array.isArray(current.widgets) && current.widgets.length ? current.widgets : [{}];
      widgets.forEach((widget, idx) => {
        els.widgetList.appendChild(buildWidgetRow(widget, idx));
      });
    }
    updateVisibilityButton(current);
    updateDeleteButton(current);
    renderPreviewSkeleton();
  }

  function updateDeleteButton(preset) {
    if (!els.deleteBtn) return;
    els.deleteBtn.hidden = !preset || !preset.id || !hasPermission('deleteReportPresets');
  }

  function collectWidgets() {
    if (!els.widgetList) return [];
    return Array.from(els.widgetList.querySelectorAll('.reports-widget')).map((node) => {
      const title = node.querySelector('input[data-role="title"]')?.value || '';
      const type = node.querySelector('select[data-role="type"]')?.value || 'table';
      const source = node.querySelector('select[data-role="source"]')?.value || 'orders';
      const detail = node.querySelector('select[data-role="detail"]')?.value || '';
      const fields = Array.from(node.querySelector('select[data-role="columns"]')?.selectedOptions || []).map((opt) => opt.value);
      const filterField = node.querySelector('div.reports-inline select')?.value;
      const filterOperator = node.querySelector('div.reports-inline select:nth-child(2)')?.value;
      const filterValue = node.querySelector('div.reports-inline input')?.value;
      const filters = filterField && filterValue ? [{ field: filterField, operator: filterOperator, value: filterValue }] : [];
      return {
        title: title.trim(),
        type,
        dataSource: source,
        detail,
        fields,
        filters
      };
    });
  }

  async function loadCurrentUser() {
    const data = await fetchJson('/me');
    if (!data?.user) {
      window.location.href = '/login';
      return;
    }
    state.user = data.user;
  }

  async function loadPresets() {
    if (!hasPermission('viewReports')) {
      renderNotice('Недостаточно прав для раздела «Отчёты».', 'error');
      return;
    }
    renderNotice('Загрузка данных отчётов…');
    try {
      const data = await fetchJson('/api/reports/presets');
      state.settings = data?.settings || { enabled: false };
      state.presets = Array.isArray(data?.presets) ? data.presets : [];
      renderNotice('');
      renderSettingsToggle();
      renderPresetList();
      const search = new URLSearchParams(window.location.search);
      const presetId = Number(search.get('preset'));
      if (Number.isFinite(presetId)) {
        const target = state.presets.find((entry) => Number(entry.id) === presetId);
        if (target) {
          selectPreset(target);
        }
      }
    } catch (err) {
      console.error('Reports load failed', err);
      renderNotice(err.message || 'Не удалось загрузить отчёты', 'error');
    }
  }

  function renderSettingsToggle() {
    if (!els.settingsToggle) return;
    const canManage = hasPermission('accessReportBuilder');
    els.settingsToggle.disabled = !canManage;
    els.settingsToggle.checked = !!state.settings.enabled;
    if (els.settingsLabel) {
      els.settingsLabel.textContent = state.settings.enabled ? 'Включено' : 'Выключено';
    }
  }

  function selectPreset(preset) {
    if (!preset) return;
    fillForm(preset);
    renderNotice('Редактирование выбранного пресета');
  }

  function resetForm() {
    fillForm({});
    renderNotice('Создаём новый пресет');
  }

  async function savePreset(event) {
    event.preventDefault();
    if (!hasPermission('editReportPresets')) {
      renderNotice('Недостаточно прав для сохранения пресетов', 'error');
      return;
    }
    const filters = {
      status: els.filterStatusInput?.value || '',
      dateFrom: els.filterFromInput?.value || '',
      dateTo: els.filterToInput?.value || '',
      overdueOnly: !!els.filterOverdueInput?.checked
    };
    const layout = { mode: els.layoutTypeInput?.value || 'grid' };
    const payload = {
      name: els.nameInput?.value || '',
      description: els.descriptionInput?.value || '',
      isActive: !!els.activeInput?.checked,
      isPublic: !!els.publicInput?.checked,
      allowedRoles: parseRolesInput(els.rolesInput?.value || ''),
      layout,
      filters,
      widgets: collectWidgets()
    };
    const isEdit = Number.isFinite(state.selectedId);
    const url = isEdit ? `/api/reports/presets/${state.selectedId}` : '/api/reports/presets';
    const method = isEdit ? 'PATCH' : 'POST';
    setFormBusy(true);
    try {
      const data = await fetchJson(url, { method, body: payload });
      const preset = data?.preset;
      if (preset) {
        if (isEdit) {
          state.presets = state.presets.map((item) => (Number(item.id) === Number(preset.id) ? preset : item));
        } else {
          state.presets = [preset, ...state.presets];
        }
        selectPreset(preset);
        renderPresetList();
        renderNotice('Пресет сохранён', 'success');
      }
    } catch (err) {
      console.error('Save preset failed', err);
      renderNotice(err.message || 'Не удалось сохранить пресет', 'error');
    } finally {
      setFormBusy(false);
    }
  }

  async function toggleVisibility() {
    if (!hasPermission('viewReports')) return;
    if (!state.selectedId) return;
    const preset = state.presets.find((p) => Number(p.id) === Number(state.selectedId));
    if (!preset) return;
    const nextVisible = preset.isVisible === false;
    try {
      await fetchJson(`/api/reports/presets/${preset.id}/visibility`, {
        method: 'POST',
        body: { isVisible: nextVisible }
      });
      preset.isVisible = nextVisible;
      updateVisibilityButton(preset);
      renderPresetList();
    } catch (err) {
      console.error('Visibility update failed', err);
      renderNotice(err.message || 'Не удалось обновить видимость', 'error');
    }
  }

  async function deletePreset() {
    if (!hasPermission('deleteReportPresets')) return;
    if (!state.selectedId) return;
    const preset = state.presets.find((p) => Number(p.id) === Number(state.selectedId));
    const name = preset?.name || 'пресет';
    const confirmed = window.confirm(`Удалить ${name}?`);
    if (!confirmed) return;
    setFormBusy(true);
    try {
      await fetchJson(`/api/reports/presets/${state.selectedId}`, { method: 'DELETE' });
      state.presets = state.presets.filter((p) => Number(p.id) !== Number(state.selectedId));
      resetForm();
      renderPresetList();
      renderNotice('Пресет удалён', 'success');
    } catch (err) {
      console.error('Delete preset failed', err);
      renderNotice(err.message || 'Не удалось удалить пресет', 'error');
    } finally {
      setFormBusy(false);
    }
  }

  async function updateSettings(event) {
    const enabled = !!event.target.checked;
    if (!hasPermission('accessReportBuilder')) {
      renderSettingsToggle();
      renderNotice('Нет прав для изменения глобальных настроек отчётов', 'error');
      return;
    }
    try {
      const data = await fetchJson('/api/reports/settings', {
        method: 'PATCH',
        body: { enabled }
      });
      state.settings = data || { enabled };
      renderSettingsToggle();
      renderNotice('Настройки обновлены', 'success');
    } catch (err) {
      console.error('Settings update failed', err);
      renderNotice(err.message || 'Не удалось сохранить настройки', 'error');
      renderSettingsToggle();
    }
  }

  function bindEvents() {
    els.reloadBtn?.addEventListener('click', () => loadPresets());
    els.presetForm?.addEventListener('submit', savePreset);
    els.addWidgetBtn?.addEventListener('click', () => {
      if (els.widgetList) {
        els.widgetList.appendChild(buildWidgetRow({}, els.widgetList.childElementCount));
      }
      renderPreviewSkeleton();
    });
    els.deleteBtn?.addEventListener('click', deletePreset);
    els.visibilityBtn?.addEventListener('click', toggleVisibility);
    els.settingsToggle?.addEventListener('change', updateSettings);
    const createBtn = document.getElementById('reportCreate');
    createBtn?.addEventListener('click', resetForm);
    els.previewBtn?.addEventListener('click', previewData);
    els.templateStages?.addEventListener('click', () => applyTemplate('stages'));
    els.templateTable?.addEventListener('click', () => applyTemplate('table'));
  }

  function applyTemplate(type) {
    if (!els.widgetList) return;
    const widgets =
      type === 'stages'
        ? [
            {
              title: 'Переделы: таблица',
              type: 'table',
              dataSource: 'stages',
              detail: 'laser',
              fields: ['stage', 'workcenter', 'start', 'finish', 'duration', 'overdue']
            },
            {
              title: 'Переделы: Гант',
              type: 'gantt',
              dataSource: 'stages',
              detail: 'laser',
              fields: ['stage', 'start', 'finish', 'overdue']
            }
          ]
        : [
            {
              title: 'Сводка заказов',
              type: 'table',
              dataSource: 'orders',
              detail: 'summary',
              fields: ['number', 'status', 'customer', 'total', 'ready', 'overdue']
            }
          ];
    els.widgetList.innerHTML = '';
    widgets.forEach((widget, idx) => {
      els.widgetList.appendChild(buildWidgetRow(widget, idx));
    });
    renderPreviewSkeleton('Нажмите «Предпросмотр данных», чтобы увидеть подборку по вашим переделам.');
  }

  async function previewData() {
    const widgets = collectWidgets();
    if (!widgets.length) {
      renderPreviewSkeleton();
      return;
    }
    renderPreviewLoading();
    try {
      const previews = await Promise.all(
        widgets.map((widget) => fetchJson('/api/reports/preview', { method: 'POST', body: { widget } }).catch(() => null))
      );
      renderPreviewContent(widgets, previews.map((entry) => entry?.preview || entry));
    } catch (err) {
      console.error('Preview failed', err);
      renderNotice(err.message || 'Не удалось построить предпросмотр', 'error');
      renderPreviewSkeleton('Предпросмотр недоступен, проверьте настройки виджетов.');
    }
  }

  async function init() {
    try {
      await loadCurrentUser();
      if (!hasPermission('viewReports')) {
        renderNotice('Недостаточно прав для раздела «Отчёты».', 'error');
        return;
      }
      bindEvents();
      await loadPresets();
      renderPreviewSkeleton();
    } catch (err) {
      console.error('Reports init failed', err);
      renderNotice(err.message || 'Не удалось открыть раздел отчётов', 'error');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
