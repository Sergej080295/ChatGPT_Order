# База данных PlanCore (SQLite)

Сервер планировщика полностью перешёл на хранение данных в SQLite (`data/planner.db`). Каждая сущность отражена отдельной таблицей
с версионированием строк — JSON‑снапшот больше не используется. При старте приложение создаёт схему, импортирует существующий
`planner-state.json` (если он найден) и заполняет тестовые записи для локальной разработки.【F:server.js†L1-L219】【F:server.js†L221-L336】

## 1. Общие правила

* `updated_at` хранится в формате ISO‑8601 (`nowIso()`), обновляется при каждом изменении строки.
* `row_version` — целое число, стартует с `0` и инкрементируется при каждом успешном `PATCH`. Клиент обязан передавать ожидание
  версии (`ifVersion`) и получает `409 Conflict` при рассинхронизации.【F:server.js†L422-L519】【F:server.js†L549-L662】
* Все JSON‑поля валидируются через `json_valid()`; помощник `validateJsonValue()` сериализует объекты перед записью.【F:server.js†L338-L355】
* SSE (`/api/events`) рассылает дельты: в payload включаются обновлённые строки с текущими `row_version`, чтобы клиент мог обновить
  локальный кэш без дополнительного запроса.【F:server.js†L357-L413】【F:server.js†L995-L1048】

## 2. Таблицы CRM

| Таблица | Назначение |
| --- | --- |
| `crm_boards` | CRM‑доски. Содержат название, массив «lane» (`lanes`), произвольный `payload` и позицию в списке. Используется в CRM UI и при сопоставлении заказов с досками.【F:server.js†L21-L118】【F:server.js†L707-L816】 |
| `crm_orders_meta` | Метаинформация о заказах на досках (ключ доски, позиция, CRM ID, JSON‑payload). Позволяет восстанавливать расположение карточек и связку с таблицей `orders`.【F:server.js†L21-L118】【F:server.js†L819-L926】 |

## 3. Производственные данные

| Таблица | Назначение |
| --- | --- |
| `processes` | Справочник переделов. Колонки `code`, `name`, флаги активности/параллельности и порядковый номер. Первичное заполнение выполняет `seedInitialData()`.【F:server.js†L120-L219】【F:server.js†L223-L336】 |
| `orders` | Заказы, синхронизированные с CRM. Содержат идентификаторы, номер, статус, ссылки на CRM и метки удаления. API: `GET /api/orders`, `PATCH /api/orders/:id`.【F:server.js†L21-L118】【F:server.js†L422-L519】 |
| `order_process` | Этапы (маршруты) заказов, связывают заказ с переделом. Хранят план/факт, прогресс и сортировку. API: `GET /api/order-process`, `PATCH /api/order-process/:id`.【F:server.js†L21-L118】【F:server.js†L549-L662】 |
| `capacity_by_process` | Нормативы мощностей по дням и переделам. Таблица создана для будущего планирования, пока не используется в API.【F:server.js†L21-L118】 |

## 4. Планировщик

| Таблица | Назначение |
| --- | --- |
| `planner_stage_orders` | Сохраняет порядок карточек в переделе. Колонка `order_uids` содержит массив UID (`order-<id>`). API: `GET /api/planner/stage-orders`, `PATCH /api/planner/stage-orders/:stageCode`. История изменений дублируется в `stage_order_history`.【F:server.js†L21-L118】【F:server.js†L664-L746】 |
| `planner_tasks_payload` | Резерв для расширенных данных карточек (JSON‑payload по каждой задаче). На старте не заполняется, но может использоваться клиентом для передачи дополнительных атрибутов.【F:server.js†L21-L118】 |
| `planner_misc_state` | Свободное JSON‑хранилище для точечных настроек и временных данных UI. API: `GET/ PATCH /api/settings/misc/:key`.【F:server.js†L21-L118】【F:server.js†L748-L815】 |
| `planner_settings` | Основные настройки планировщика в одном JSON (постепенно будут дробиться на атомарные таблицы). Инициализируется пустым объектом и доступна через прямые SQL‑запросы либо будущие API. Сейчас используется для сохранения совместимости с прежним UI.【F:server.js†L21-L118】【F:server.js†L305-L336】 |
| `settings_shared_preferences` | Булевые пользовательские флаги (например, автооптимизация). API: `GET/PATCH /api/settings/shared`.【F:server.js†L21-L118】【F:server.js†L664-L746】 |

## 5. Импорт наследия

При первом запуске сервер пытается распарсить `data/planner-state.json` и сохранить CRM‑доски в новые таблицы. Остальные данные
будут заполнены seed‑скриптом. Ошибки импорта не критичны и выводятся в лог.【F:server.js†L305-L336】

## 6. Примеры запросов

```
# Список активных заказов
sqlite3 data/planner.db "SELECT id, number, status, updated_at, row_version FROM orders ORDER BY updated_at DESC LIMIT 5;"

# Процессы и привязанные заказы
sqlite3 data/planner.db "SELECT o.number, p.code, op.progress, op.is_done FROM order_process op JOIN orders o ON o.id = op.order_id JOIN processes p ON p.id = op.process_id ORDER BY o.id, op.seq;"

# Порядок карточек в гибке
sqlite3 data/planner.db "SELECT order_uids, row_version FROM planner_stage_orders WHERE stage_code = 'bend';"
```

Такой подход исключает «монолитные» снапшоты, ускоряет синхронизацию и упрощает реализацию дельта‑API — каждая таблица выступает
источником истины для своей области данных.
