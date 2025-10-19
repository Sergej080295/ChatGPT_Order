# Структура базы данных PlanCore

PlanCore хранит единые данные для CRM и Планировщика в нормализованном виде. При любом действии интерфейса изменения записываются прямо в SQL-таблицы, поэтому состояния на всех страницах синхронизируются мгновенно и без промежуточных «снимков».

## 1. Таблицы

### 1.1 `pc_orders`
Хранит каждую карточку заказа вне зависимости от режима отображения.

| Колонка | Тип | Описание |
| --- | --- | --- |
| `id` | `text` | Уникальный идентификатор заказа (используется в CRM и Планировщике). |
| `board_code` | `text` | Код доски/раздела (например, `crm`). |
| `lane_code` | `text` | Колонка доски; может быть `NULL`. |
| `position` | `integer` | Позиция карточки внутри колонки. |
| `number`, `title`, `customer`, `status`, `priority`, `manager` | `text` | Основные атрибуты заказа. |
| `ready_percent`, `expected_percent` | `numeric` | Фактическая и ожидаемая готовность. |
| `planned_start`, `planned_finish`, `actual_start`, `actual_finish`, `due_date` | `timestamptz` | Контрольные даты маршрута. |
| `notes` | `text` | Произвольные заметки. |
| `meta` | `jsonb` | Дополнительные данные, которые не требуется индексировать. |
| `created_at`, `updated_at` | `timestamptz` | Моменты создания и последнего изменения. |

### 1.2 `pc_order_tasks`
Переделы/этапы конкретного заказа. Карточка в Планировщике соответствует строке в этой таблице.

| Колонка | Тип | Описание |
| --- | --- | --- |
| `id` | `text` | Уникальный идентификатор этапа. |
| `order_id` | `text` | Ссылка на `pc_orders.id`. При удалении заказа этапы удаляются автоматически. |
| `stage_code`, `stage_name` | `text` | Нормализованный код передела и его человекочитаемое название. |
| `position` | `integer` | Порядок карточки внутри колонки. |
| `status`, `executor` | `text` | Статус и исполнитель этапа. |
| `ready_percent`, `expected_percent` | `numeric` | Фактический и плановый прогресс. |
| `planned_start`, `planned_finish`, `actual_start`, `actual_finish`, `due_date` | `timestamptz` | Плановые и фактические сроки. |
| `notes` | `text` | Комментарии к этапу. |
| `meta` | `jsonb` | Дополнительные атрибуты. |
| `created_at`, `updated_at` | `timestamptz` | Время создания и последнего обновления. |

Индексы `pc_order_tasks_order_idx` и `pc_order_tasks_stage_idx` ускоряют выборку этапов по заказу и по коду передела.

### 1.3 `pc_settings`
Глобальные настройки интерфейса (например, параметры уведомлений или значения, сохранённые в панели настроек).

| Колонка | Тип | Описание |
| --- | --- | --- |
| `key` | `text` | Имя настройки. |
| `payload` | `jsonb` | Произвольное содержимое. |
| `updated_at` | `timestamptz` | Дата изменения. |

Запись создаётся/обновляется при вызове `PUT /api/settings`.

### 1.4 `pc_journal`
Журнал служебных событий (создание, обновление, удаление заказов и переделов, изменение настроек).

| Колонка | Тип | Описание |
| --- | --- | --- |
| `id` | `bigserial` | Последовательный идентификатор записи. |
| `kind` | `text` | Тип события (`order.created`, `stage.updated` и т.д.). |
| `payload` | `jsonb` | Полезные данные события. |
| `created_at` | `timestamptz` | Время фиксации события. |

## 2. Поток данных

1. **Чтение.**
   * `GET /api/orders` возвращает массив заказов с вложенными этапами (если передан `includeStages=1`).
   * `GET /api/stages` собирает по каждой стадии список задач и агрегаты для доски Планировщика.
2. **Изменение заказов.**
   * `POST /api/orders` создаёт новую карточку заказа и, при необходимости, стартовый набор этапов.
   * `PATCH /api/orders/:id` обновляет основные поля и автоматически проставляет `updated_at`.
   * `DELETE /api/orders/:id` удаляет заказ и связанные переделы.
3. **Изменение переделов.**
   * `POST /api/orders/:id/stages` добавляет этап к заказу.
   * `PATCH /api/stages/:stageId` обновляет прогресс, сроки и статус передела.
   * `DELETE /api/stages/:stageId` полностью удаляет карточку передела.
4. **Настройки.**
   * `PUT /api/settings` принимает объект `{ key: value }` и обновляет значения в `pc_settings`.
5. **Журнал.**
   * После каждой операции добавляется запись в `pc_journal`, поэтому историю изменений можно восстановить простым `SELECT`.

## 3. Проверка

1. **Структура.** После запуска сервера выполните:
   ```sql
   SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name LIKE 'pc_%'
   ORDER BY table_name;
   ```
   Ожидаемые таблицы: `pc_journal`, `pc_order_tasks`, `pc_orders`, `pc_settings`.
2. **Создание тестовых данных.** Вставьте заказ и этап:
   ```sql
   INSERT INTO pc_orders (id, board_code, title) VALUES ('demo-order', 'crm', 'Тестовый заказ');
   INSERT INTO pc_order_tasks (id, order_id, stage_code, stage_name, position)
     VALUES ('demo-stage', 'demo-order', 'laser', 'Лазер', 0);
   ```
   Запрос `GET /api/stages/laser` должен вернуть созданную карточку.
3. **Сохранение из UI.** Добавьте заказ из CRM-интерфейса и обновите прогресс передела. Команда
   ```sql
   SELECT title, ready_percent FROM pc_orders ORDER BY updated_at DESC LIMIT 5;
   ```
   отразит новое значение `ready_percent`. Аналогично, `SELECT * FROM pc_journal ORDER BY id DESC LIMIT 5;` покажет событие `order.updated` или `stage.updated`.

## 4. Отличия от старой схемы

* Нет промежуточных «снимков» (`planner_state_snapshots`, `pc_stage_sequences` и т.п.) — данные читаются напрямую из рабочих таблиц.
* CRM и Планировщик используют одни и те же строки `pc_orders`/`pc_order_tasks`, поэтому при обновлении этапа в Планировщике прогресс тут же виден в CRM.
* Настройки вынесены в `pc_settings`, а журнал действий хранится в `pc_journal` и не зависит от хеша снимка.
