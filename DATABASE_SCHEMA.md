# Схема SQL после миграции 017

## Версия и ключевые отличия
* **Текущая версия:** миграция `017_rebuild_sql_schema.sql` полностью пересобирает структуру БД. Удалены все прежние таблицы истории, JSONB-колонки и специализированные настройки — теперь используются только обычные типы и компактные таблицы. 【F:migrations/017_rebuild_sql_schema.sql†L1-L88】
* **Снимки состояния** хранятся в `state_snapshots` в текстовом виде вместе с актором/источником, что упрощает фильтрацию истории. 【F:migrations/017_rebuild_sql_schema.sql†L20-L38】【F:server.js†L320-L362】
* **Настройки** сведены в единую таблицу `settings_values`, куда сервер записывает автодовес, лимиты журнала и админские параметры через upsert. 【F:migrations/017_rebuild_sql_schema.sql†L62-L74】【F:server.js†L604-L656】

## Карта таблиц
### Служебные
* `planner_schema_migrations` — реестр применённых SQL-скриптов (создаётся автоматически утилитой миграций). 【F:scripts/run_migrations.js†L29-L63】
* `revisions` + последовательность `revisions_rev_seq` — счётчик ревизий, куда `runWithRevision()` записывает акторов, источник и заметку. 【F:migrations/017_rebuild_sql_schema.sql†L10-L27】【F:server.js†L698-L715】
* `activity_log` — протокол операций администрирования; связан с ревизиями и индексирован по `rev`. 【F:migrations/017_rebuild_sql_schema.sql†L52-L61】

### Снимки и история состояния
* `state_snapshots` — на каждую ревизию хранит сериализованный снимок (`state_text`), метаданные (`meta_text`), SHA-1 хеш и денормализованные поля `actor/source/note`. Сервер читает последнюю запись при ответе `GET /api/state` и может фильтровать историю без JSON-операторов. 【F:migrations/017_rebuild_sql_schema.sql†L20-L38】【F:server.js†L320-L362】【F:server.js†L1887-L2006】
* SSE-рассылка (`/api/events`) получает хеш и ревизию непосредственно из кэша `state_snapshots`. 【F:server.js†L360-L404】【F:server.js†L1847-L1877】

### Производственные данные
* `processes` — справочник переделов (код, имя, позиция, флаги). Полностью пересоздаётся из снимка, что гарантирует синхронизацию с CRM. 【F:migrations/017_rebuild_sql_schema.sql†L40-L49】【F:server.js†L1312-L1370】
* `customers` — уникальные клиенты, собираемые из задач перед сохранением. 【F:migrations/017_rebuild_sql_schema.sql†L51-L55】【F:server.js†L1372-L1396】
* `orders` — агрегированная карточка заказа: номер, CRM-ID, клиент, статусы, приоритеты, сроки и флаги удаления. Дополнительные поля (`order_no`, `client`, `is_deleted`) позволяют импортировать неполные карточки без ошибок. 【F:migrations/017_rebuild_sql_schema.sql†L57-L73】【F:server.js†L1411-L1516】
* `order_process` — маршрут по переделам (SEQ, план/факт дат, прогресс, позиция). Обновляется на основе колонок «в работе/готово/корзина». 【F:migrations/017_rebuild_sql_schema.sql†L75-L88】【F:server.js†L1518-L1586】
* `capacity_by_process` — суточная мощность по переделам (в минутах). 【F:migrations/017_rebuild_sql_schema.sql†L90-L95】【F:server.js†L1588-L1615】

### Глобальные настройки
* `settings_values` — универсальный key-value (text/number/boolean) для автодовеса, лимитов журнала и админских параметров. Обновляется через `upsertSettingValue()`; чтение автодовеса выполняется функцией `loadAutoweightSettings()`. 【F:migrations/017_rebuild_sql_schema.sql†L62-L74】【F:server.js†L572-L604】【F:server.js†L959-L994】
* `settings_column_widths` — сохранённые ширины колонок таблицы заказов. 【F:migrations/017_rebuild_sql_schema.sql†L76-L80】【F:server.js†L1634-L1663】
* `settings_stage_mapping` — сопоставление стадий CRM и переделов; флаг `is_ignored` позволяет исключать статусы. 【F:migrations/017_rebuild_sql_schema.sql†L82-L87】【F:server.js†L1665-L1691】
* `excluded_statuses` — список CRM-статусов, которые не нужно показывать. 【F:migrations/017_rebuild_sql_schema.sql†L89-L93】【F:server.js†L1693-L1727】
* `settings_shared_preferences` — общие переключатели UI (автосохранение, автосдвиг и т.д.), синхронизируются при каждом сохранении снимка. 【F:migrations/017_rebuild_sql_schema.sql†L95-L99】【F:server.js†L908-L948】

## Поток `PUT /api/state`
1. Клиент отправляет новый снимок. Сервер нормализует метаданные и вычисляет хеш. 【F:server.js†L1735-L1796】
2. `persistSnapshotWithSql()` внутри транзакции вызывает `applySnapshotToSql()` — таблицы очищаются и заполняются данными из снимка (процессы, клиенты, заказы, маршруты, мощности, настройки). 【F:server.js†L744-L818】【F:server.js†L1312-L1727】
3. После успешной записи `insertSnapshotRow()` сохраняет сериализованное состояние в `state_snapshots`, а `runWithRevision()` фиксирует ревизию и публикует событие SSE. 【F:server.js†L681-L715】【F:server.js†L698-L715】【F:server.js†L1810-L1845】
4. `GET /api/state` читает последний снимок, добавляет общие настройки (shared preferences) и возвращает JSON без дополнительного форматирования. 【F:server.js†L320-L362】【F:server.js†L1735-L1771】

## Проверка после деплоя
1. **Миграции:** выполните `npm run migrate` и убедитесь, что в `planner_schema_migrations` появилась запись для `017_rebuild_sql_schema.sql`. 【F:scripts/run_migrations.js†L29-L63】
2. **Пробный снимок:** отправьте сохранение из UI или `curl -X PUT /api/state ...` — таблицы `orders`, `order_process`, `settings_values` должны заполниться данными, а в `state_snapshots` появится новая строка с хешем. 【F:server.js†L1312-L1727】【F:server.js†L681-L715】
3. **История:** запрос `GET /api/admin/history?limit=5` должен возвращать последнюю активность с фильтрами по `actor`/`source` (теперь используются простые сравнения строк). 【F:server.js†L1887-L1973】
4. **Откат:** `POST /api/admin/rollback` загружает снимок по хешу и повторно применяет его через те же функции — все таблицы пересобираются, а в `state_snapshots` фиксируется новая ревизия с источником `rollback`. 【F:server.js†L2079-L2138】

## Быстрый запуск Планировщика на новой базе
1. Создайте пустую БД PostgreSQL и задайте переменную окружения `DATABASE_URL`, либо используйте дефолт `postgresql://planner:planner@localhost:5432/planner`. 【F:server.js†L12-L23】
2. Установите зависимости: `npm install`.
3. Примените миграции: `npm run migrate`. Убедитесь, что таблица `state_snapshots` создана. 【F:migrations/017_rebuild_sql_schema.sql†L1-L88】
4. Запустите сервер: `npm start`. При первом запуске `ensureSqlHydrated()` проверит наличие данных и при необходимости подтянет последний снимок. 【F:server.js†L1100-L1150】
5. Откройте `http://localhost:3000` — Planner UI будет работать с новой схемой, сохраняя данные в реляционные таблицы без JSONB.
