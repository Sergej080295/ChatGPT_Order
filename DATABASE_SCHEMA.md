# Архитектура SQL-схемы Planner

Документ описывает текущее устройство базы данных, на которой работает сервер `server.js`. Все изменения схемы применяются миграциями из каталога `migrations/` и фиксируются в таблице `planner_schema_migrations`.【F:server.js†L200-L212】

## 1. Управление ревизиями
- Таблица `revisions` хранит каждую ревизию: числовой `rev`, опциональные `actor`/`source`/`note` и временную метку. Значения выдаёт последовательность `revisions_rev_seq`, определённая в базовых миграциях.【F:migrations/003_full_sql_schema.sql†L3-L26】
- Функция `runWithRevision()` в сервере открывает транзакцию, получает следующий `rev`, вызывает `insertRevisionRow()` и устанавливает `SET LOCAL app.rev`, чтобы history‑триггеры знали текущую ревизию.【F:server.js†L214-L265】【F:server.js†L531-L552】
- Исторические таблицы `*_hist` поддерживаются универсальным триггером, описанным в миграциях `004` и `005`, которые синхронизируют структуру истории с основными таблицами и удаляют легаси‑ограничения.【F:migrations/004_settings_admin_snapshot_retention_backfill.sql†L1-L120】【F:migrations/005_fix_history_tables.sql†L1-L120】

## 2. Нормализованные данные планировщика
- `processes` описывает технологические этапы (код, имя, позиция, флаги активности/параллельности). `applySnapshotToSql()` переcобирает справочник из снимка, нормализуя коды стадий.【F:server.js†L604-L669】
- `customers` и `orders` содержат клиентов и заказы. Заказ включает `crm_order_id`, обязательный `number`, ссылку на клиента, статусы и временные метки. Колонка `deleted_at` помечает элементы из корзины снимка, а миграции `007–009` выравнивают легаси‑схемы (идентификатор клиента, CRM‑код и номер заказа).【F:server.js†L733-L807】【F:migrations/007_orders_customer_id_fix.sql†L1-L170】【F:migrations/008_orders_crm_order_id_fix.sql†L1-L142】【F:migrations/009_orders_number_column_fix.sql†L1-L133】
- `order_process` хранит прохождение заказа по стадиям: порядковый номер, плановые/фактические даты, прогресс и признак завершения. Позиции внутри этапа восстанавливаются на основе порядка задач в снимке.【F:server.js†L756-L807】
- `capacity_by_process` фиксирует мощность по процессу на конкретный день (в минутах). Таблицы `settings_*` и `excluded_statuses` содержат пользовательские настройки интерфейса и фильтров; при нормализации они заполняются из соответствующих разделов снимка.【F:server.js†L809-L918】

## 3. Таблица снимков и кэш состояния
- Миграция `012_restore_planner_state_snapshots.sql` создаёт таблицу `planner_state_snapshots`: `rev`, JSONB‑снимок, расчётный `hash`, произвольные метаданные и `created_at`. Записи связаны внешним ключом с `revisions` и индексируются по `rev` и времени создания.【F:migrations/012_restore_planner_state_snapshots.sql†L3-L16】
- При каждом `PUT /api/state` сервер парсит тело запроса через `extractSnapshotPayload()`, проверяет конфликт по `If-Match`/мета‑хешу, затем внутри `runWithRevision()` вызывает `applySnapshotToSql()` и `insertSnapshotRow()`. После коммита обновляется кэш (`cachedSnapshot`) и рассылается событие через SSE.【F:server.js†L440-L503】【F:server.js†L518-L552】【F:server.js†L604-L918】【F:server.js†L942-L1009】
- `GET /api/state` отдаёт последний снимок из кэша/БД, выставляет ETag по SHA‑1 и поддерживает `If-None-Match`. Начальный кэш прогревается при старте сервера (`bootstrap()`).【F:server.js†L269-L309】【F:server.js†L922-L939】【F:server.js†L1247-L1254】

## 4. Серверные эндпоинты и трансляция изменений
- `app.put('/api/state')` принимает полный JSON снимка (или обёртку `{ state, meta }`), нормализует данные и возвращает `{ ok, rev, hash, etag }` после успешного коммита. Метаданные запроса очищаются функцией `sanitizeMetaForStorage()` и сохраняются вместе со снимком.【F:server.js†L326-L359】【F:server.js†L942-L1009】
- `app.get('/api/state')` возвращает сохранённый снимок, а `app.get('/api/events')` поддерживает SSE‑подписку: при подключении клиент получает текущий `{ rev, hash }`, а дальше — события о новых ревизиях.【F:server.js†L922-L1045】
- Админ‑эндоинты: `GET /api/admin/history` постранично читает `planner_state_snapshots` вместе с метаинформацией (`actor`, `source`, `summary`), `GET /api/admin/history/:hash` отдаёт развёрнутый снимок, `POST /api/admin/snapshot` создаёт ручную ревизию без изменения данных, `POST /api/admin/rollback` повторно применяет выбранный снимок под новой ревизией.【F:server.js†L1048-L1233】

## 5. Скрипт импорта
`scripts/import_legacy_snapshot.js` загружает старый `planner-state.json`, повторяет логику `applySnapshotToSql()` (процессы, клиенты, заказы, стадии, настройки, игнорируемые статусы), вычисляет хеш и записывает снимок через `planner_state_snapshots`, устанавливая `app.rev` и создавая запись в `revisions`. Скрипт учитывает корзину (`trash`) как удалённые заказы и сохраняет метаданные импорта в `snapshotMeta`.【F:scripts/import_legacy_snapshot.js†L51-L506】
