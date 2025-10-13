# Архитектура и тестирование базы данных Planner

Документ описывает актуальную схему SQL и работу сервера `server.js`, который полностью сохраняет состояние планировщика и CRM в PostgreSQL. Все изменения схемы доставляются из каталога `migrations/` и помечаются в таблице `planner_schema_migrations`.【F:server.js†L200-L213】

## 1. Ревизии и исторические данные
- Базовая миграция `003_full_sql_schema.sql` создаёт последовательность `revisions_rev_seq` и таблицу `revisions`, куда для каждой правки записываются `rev`, временная метка, а также опциональные `actor`, `source`, `note`.【F:migrations/003_full_sql_schema.sql†L1-L66】
- При любом сохранении `runWithRevision()` открывает транзакцию, получает следующий `rev`, вставляет строку в `revisions`, выставляет `SET LOCAL app.rev` и вызывает переданный обработчик. После коммита номер ревизии кэшируется в `lastRevision`.【F:server.js†L585-L605】
- Миграции `004_settings_admin_snapshot_retention_backfill.sql` и `005_fix_history_tables.sql` синхронизируют структуру всех таблиц `_hist`, удаляют устаревшие триггеры `hist_*` и обеспечивают запись ревизий для настроек, заказов и мощностей без конфликтов. Они используют `ADD COLUMN IF NOT EXISTS` и `ON CONFLICT`, поэтому миграции идемпотентны и безопасно переигрывают старые базы.【F:migrations/004_settings_admin_snapshot_retention_backfill.sql†L1-L126】【F:migrations/005_fix_history_tables.sql†L1-L138】

## 2. Нормализованные таблицы планировщика
- `processes` хранит коды стадий, отображаемые имена и флаги параллельности. Функция `applySnapshotToSql()` собирает уникальные стадии из снимка, нормализует код, создаёт записи и помнит соответствие ID стадии для последующей загрузки задач.【F:server.js†L691-L718】
- `customers` и `orders` описывают клиентов и заказы. Заказ содержит `crm_order_id`, обязательный `number`, ссылку на клиента, статусы и временные метки; `deleted_at` заполняется для элементов из корзины. Миграции `007–009` выравнивают легаси-схемы: добавляют `customer_id`, `crm_order_id`, поле `number`, индексы и ограничения уникальности. Таким образом сервер всегда может связать задачу со строкой заказа через ключи `orderIdentity/orderId/orderNumber/uid` из снимка.【F:server.js†L733-L842】【F:migrations/007_orders_customer_id_fix.sql†L1-L172】【F:migrations/008_orders_crm_order_id_fix.sql†L1-L144】【F:migrations/009_orders_number_column_fix.sql†L1-L135】
- `order_process` хранит прохождение заказов по стадиям (seq, плановые/фактические даты, прогресс, позицию). Функция `applySnapshotToSql()` пересоздаёт записи, расставляя порядковые номера и индексы в рамках каждой стадии, что гарантирует сохранение порядка задач при перезагрузке страницы.【F:server.js†L843-L895】
- `capacity_by_process` фиксирует мощность на дату, `settings_autoweight`, `settings_journal`, `settings_column_widths`, `settings_mapping`, `settings_admin` и `excluded_statuses` отражают общие настройки интерфейса. Каждая вставка выполняется через `INSERT ... ON CONFLICT`, поэтому таблицы всегда соответствуют значениям из последнего снимка и их история корректно ведётся триггерами. 【F:server.js†L896-L918】

## 3. Хранение JSON-снимков
- Миграция `012_restore_planner_state_snapshots.sql` создаёт таблицу `planner_state_snapshots (rev, snapshot JSONB, meta JSONB, hash TEXT, created_at TIMESTAMPTZ)` и индексы по ревизии и дате. Внешний ключ на `revisions` поддерживает каскадное удаление устаревших ревизий. 【F:migrations/012_restore_planner_state_snapshots.sql†L3-L16】
- Перед записью снимка `safeSerializeSnapshot()` валидирует готовую JSON-строку или пере-стрингует объект, чтобы в таблицу всегда попадало корректное значение JSONB. Метаданные проходят через `serializeMeta()`, которое удаляет недопустимые типы и сериализует в JSON. Благодаря этому PostgreSQL никогда не получает строку вида `[object Object]`, и повторное чтение из `planner_state_snapshots` возвращает исходные данные без искажений.【F:server.js†L520-L582】
- `loadLatestSnapshot()` выбирает последнюю запись, парсит JSONB в объект, пересчитывает SHA‑1 при отсутствии сохранённого хеша и возвращает структуру `{ snapshot, stateString, hash, meta }`. Эта функция используется как при старте сервера, так и после каждой записи, поэтому кэш `cachedSnapshot` всегда отражает фактическое состояние базы. 【F:server.js†L271-L305】

## 4. Поток сохранения состояния
1. Клиент отправляет `PUT /api/state` с обёрткой `{ state, meta }`. `extractSnapshotPayload()` принимает как строку, так и объект, и выдаёт готовый JSON-объект и строковое представление состояния.【F:server.js†L360-L504】
2. `normalizeRequestMeta()` очищает метаданные запроса, `computeSnapshotHash()` считает SHA‑1 по строке состояния, а `parseIfMatchHeader()` проверяет конфликт по ETag. Если база содержит более свежий хеш и не запрошен `forceOverwrite`, сервер отвечает `412 Precondition Failed` без изменений в БД.【F:server.js†L308-L359】【F:server.js†L942-L980】
3. Внутри `runWithRevision()` вызывается `applySnapshotToSql()`, которая в транзакции очищает связанные таблицы, пересобирает справочники, заказы, стадии, настройки и список исключённых статусов. Затем `insertSnapshotRow()` записывает JSONB-снимок в `planner_state_snapshots` и закрепляет хеш в той же ревизии. 【F:server.js†L585-L918】
4. После коммита `loadLatestSnapshot()` повторно считывает сохранённую строку, чтобы гарантированно вернуть клиенту то же состояние, что оказалось в PostgreSQL. Сервер обновляет ETag, хранит снимок в кэше и рассылает событие SSE `{ type: 'revision', rev, hash }` всем подключённым слушателям. Благодаря этому новые настройки или заказы становятся видны остальным пользователям сразу после сохранения. 【F:server.js†L1002-L1045】

## 5. Импорт и администрирование
- Скрипт `scripts/import_legacy_snapshot.js` читает `planner-state.json`, нормализует данные теми же шагами, что и сервер, вычисляет хеш и через `safeSerializeSnapshot()`/`serializeMeta()` вставляет снимок в `planner_state_snapshots`. Перед записью он создаёт новую ревизию и ставит `SET LOCAL app.rev`, чтобы истории настроек и заказов сохранились. Скрипт предназначен для первичного перехода с файлового формата на SQL.【F:scripts/import_legacy_snapshot.js†L1-L520】
- Эндпоинты `/api/admin/history`, `/api/admin/history/:hash`, `/api/admin/snapshot`, `/api/admin/rollback` позволяют просматривать историю, фиксировать ручные снимки и откатывать состояние, переиспользуя общий механизм ревизий и сериализации. 【F:server.js†L1048-L1233】

## 6. Как проверить работу базы данных
1. **Миграции.** Выполните `npm run migrate` — скрипт `scripts/run_migrations.js` применит все файлы из `migrations/` и зафиксирует их в `planner_schema_migrations`. Убедитесь, что команда завершается без ошибок.
2. **Проверка снимков.** После запуска сервера (`npm start`) измените настройки в разделе «Общие» или «Администрирование». На стороне БД проверьте:
   ```sql
   SELECT rev, hash, snapshot->'meta'->'settings' AS settings
     FROM planner_state_snapshots
    ORDER BY rev DESC
    LIMIT 1;
   ```
   – запись должна содержать новые значения.
3. **Настройки в нормализованных таблицах.** Убедитесь, что таблицы `settings_admin`, `settings_autoweight`, `settings_mapping`, `capacity_by_process` обновились в той же ревизии:
   ```sql
   SELECT * FROM settings_admin;
   SELECT * FROM settings_mapping ORDER BY crm_stage;
   SELECT * FROM capacity_by_process;
   ```
4. **Заказы и этапы.** Измените заказ через интерфейс (например, отметьте «Готово» или скорректируйте дату). Проверьте таблицы `orders` и `order_process`, а также историю:
   ```sql
   SELECT * FROM orders ORDER BY id DESC LIMIT 5;
   SELECT * FROM order_process ORDER BY id DESC LIMIT 5;
   SELECT * FROM orders_hist ORDER BY changed_at DESC LIMIT 5;
   ```
5. **Синхронность клиентов.** Подключите второй браузер, измените настройки в первом окне и убедитесь, что второй клиент получает событие SSE и видит правку без перезагрузки (сервер транслирует ревизию через `/api/events`). 【F:server.js†L1002-L1045】
6. **Импорт.** Для миграции старых данных положите `planner-state.json` в корень проекта и запустите `node scripts/import_legacy_snapshot.js`. После завершения проверьте, что в `planner_state_snapshots` появилась новая ревизия, а таблицы `orders`, `order_process`, `settings_*` и `excluded_statuses` содержат данные из файла.【F:scripts/import_legacy_snapshot.js†L46-L520】

Следуя этим шагам, вы убедитесь, что любые изменения из веб‑приложения сохраняются в PostgreSQL и немедленно доступны всем пользователям.
