# Архитектура и проверка SQL-базы Planner

Документ описывает, как сервер `server.js` работает с PostgreSQL, какие таблицы создают миграции и каким образом проверить, что изменения из интерфейса попадают в базу и возвращаются всем пользователям.

## 1. Ревизии и история изменений
- Базовая миграция `003_full_sql_schema.sql` создаёт последовательность `revisions_rev_seq`, таблицу `revisions` и журнал применённых миграций. Все идентификаторы заказов, стадий и настроек используют единые типы и внешние ключи.【F:migrations/003_full_sql_schema.sql†L1-L109】
- Миграции `004_settings_admin_snapshot_retention_backfill.sql` и `005_fix_history_tables.sql` приводят все таблицы `_hist` к актуальной структуре, пересоздают универсальные триггеры истории и удаляют легаси-функции. Благодаря `ADD COLUMN IF NOT EXISTS` и `ON CONFLICT` эти файлы можно безопасно применять на старых базах.【F:migrations/004_settings_admin_snapshot_retention_backfill.sql†L1-L158】【F:migrations/005_fix_history_tables.sql†L1-L184】
- Обновление `013_settings_admin_limits.sql` добавляет в `settings_admin` и `settings_admin_hist` явные поля `history_limit` и `history_daily_limit`, чтобы административные лимиты журнала фиксировались в SQL и попадали в историю изменений.【F:migrations/013_settings_admin_limits.sql†L1-L47】
- Каждое сохранение вызывает `runWithRevision()`: функция открывает транзакцию, получает следующий `rev` из `revisions_rev_seq`, вставляет строку в `revisions`, устанавливает `SET LOCAL app.rev` и запускает переданный обработчик. После коммита номер ревизии сохраняется в кэше для SSE-оповещений.【F:server.js†L585-L608】

## 2. Хранение снимков и нормализованных таблиц
- Основное состояние планировщика хранится в `planner_state_snapshots (rev, snapshot JSONB, meta JSONB, hash TEXT, created_at)`, которую создаёт миграция `012_restore_planner_state_snapshots.sql`. Для быстрых выборок добавлены индексы по ревизии и дате, а внешний ключ `rev` гарантирует связь с таблицей `revisions`.【F:migrations/012_restore_planner_state_snapshots.sql†L3-L16】
- Перед записью `insertSnapshotRow()` использует `safeSerializeSnapshot()` и `serializeMeta()`, чтобы гарантировать валидный JSONB и очищенные метаданные. В таблицу никогда не попадут строки вида `[object Object]`, и при повторном чтении возвращается исходный снимок с тем же SHA‑1-хешем.【F:server.js†L520-L573】
- Функция `applySnapshotToSql()` пересобирает нормализованные таблицы: стадии (`processes`), клиентов (`customers`), заказы (`orders`), прохождение стадий (`order_process`), мощности (`capacity_by_process`) и все настройки (`settings_*`, `excluded_statuses`). Все вставки выполняются через `INSERT ... ON CONFLICT`, поэтому данные в SQL всегда соответствуют последнему снимку, а триггеры `_hist` фиксируют историю.【F:server.js†L762-L1078】

## 3. Поток обработки `/api/state`
1. Клиент отправляет `PUT /api/state` c телом `{ state, meta }`. Сервер парсит полезную нагрузку, вычисляет SHA‑1 и извлекает ETag из заголовка `If-Match` или из `meta` (поля `baseHash/baseEtag`).【F:server.js†L360-L436】【F:server.js†L1100-L1166】
2. Если хеши не совпадают и не запрошен `forceOverwrite`, сервер отвечает `412 Precondition Failed` с телом `{ error: 'Conflict', currentHash, expectedHash }`. Это позволяет фронтенду запустить повторную загрузку и аккуратно спросить пользователя о перезаписи.【F:server.js†L1119-L1124】
3. При отсутствии конфликта `runWithRevision()` в одной транзакции вызывает `applySnapshotToSql()`, пишет JSONB-снимок через `insertSnapshotRow()` и возвращает фактическое состояние из базы (`loadLatestSnapshot()`). После коммита сервер обновляет кэш и рассылает SSE-событие `{ type: 'revision', rev, hash, etag }`, чтобы другие клиенты сразу увидели изменения.【F:server.js†L1108-L1164】【F:server.js†L1176-L1209】

## 4. Автоматическая гидратация нормализованных таблиц
- При старте `bootstrap()` запускает миграции, поднимает последнюю ревизию и кэш, а затем вызывает `ensureSqlHydrated()`. Если таблица `orders` пуста, сервер загружает последний снимок из `planner_state_snapshots`, внутри новой ревизии пересобирает все связанные таблицы и сохраняет служебную запись с пометкой `startup-hydrate`. Это предотвращает ситуацию, когда в SQL нет данных, хотя снимки существуют (например, после восстановления из бэкапа).【F:server.js†L1422-L1429】【F:server.js†L692-L745】

## 5. Проверка работы базы данных
1. **Миграции.** Выполните `npm run migrate`. В `planner_schema_migrations` должны появиться строки с номерами всех SQL-файлов.
2. **Автогидратация.** После первого старта сервера (`npm start`) проверьте, что консоль содержит сообщение `Hydrating normalized tables from snapshot rev ...`. Затем убедитесь, что таблица `orders` не пуста: `SELECT COUNT(*) FROM orders;`.
3. **Проверка настроек.** Измените значения в разделах «Общие» и «Администрирование», нажмите «Применить» и убедитесь, что кнопка возвращается в нормальное состояние. В базе должны обновиться таблицы: 
   ```sql
   SELECT allow_force_overwrite, snapshot_retention, history_limit, history_daily_limit FROM settings_admin;
   SELECT column_key, width_px FROM settings_column_widths ORDER BY column_key;
   SELECT crm_stage, planner_process_id, is_ignored FROM settings_mapping ORDER BY crm_stage;
   SELECT status_key FROM excluded_statuses ORDER BY status_key;
   SELECT max_rows FROM settings_journal;
   ```
   Параллельно в `planner_state_snapshots` должна появиться новая ревизия с обновлённым `snapshot->'meta'->'settings'`.
4. **Изменение заказов.** Добавьте или отредактируйте заказ (через CRM или «Общий список заказов»). Проверьте строки в таблицах `orders` и `order_process`, а также соответствующие записи в `orders_hist` и `order_process_hist`.
5. **История.** Запросите `/api/admin/history` или выполните в SQL: `SELECT rev, meta FROM planner_state_snapshots ORDER BY created_at DESC LIMIT 5;` — новые ревизии должны появляться после каждого сохранения.
6. **Синхронизация клиентов.** Откройте приложение в двух браузерах. При изменении настроек на первом клиенте второй должен сразу получить обновление благодаря SSE (`/api/events`).

Следуя этим шагам, можно убедиться, что данные надёжно попадают в PostgreSQL, история фиксируется в таблицах `_hist`, а интерфейс корректно читает изменения как для планировщика, так и для CRM.
