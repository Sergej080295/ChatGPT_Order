# DEPLOYMENT_AND_TEST_REPORT

## 1. Что сделано
- Реализована полностью SQL-бэкенд модель: таблицы `users`, `processes`, `customers`, `orders`, `order_process`, `capacity_by_process`, `settings_*`, `excluded_statuses`, `revisions`, `*_hist`, `activity_log`.
- Добавлены общие функции и триггеры (`ensure_current_revision`, `generic_history_trigger`, `touch_updated_at`) для автоматической записи истории по каждой операции с `SET LOCAL app.rev`.
- Переписан HTTP-сервер (`server.js`) на новую архитектуру: чтение состояния из нормализованных таблиц, поддержка ETag/If-Match, SSE на ревизиях, журналы и откаты.
- Добавлены административные эндпойнты `/api/admin/history`, `/api/admin/history/:rev`, `/api/admin/rollback` для просмотра и откатов ревизий.
- Обновлён импорт из монолитного снимка (`scripts/import_legacy_snapshot.js`) c автоматической фиксацией исходной ревизии.
- Подготовлено описание развёртывания и тестирования в этом отчёте.

## 2. Требования к окружению
- PostgreSQL 14+ с доступом к последовательностям и языку `plpgsql`.
- Переменные окружения сервера: `DATABASE_URL`, опционально `PGSSLMODE`/`PGSSL`, `PGPOOL_MAX`, `PGPOOL_IDLE`, `PORT`.
- Node.js >= 18 (см. `package.json`).

## 3. Основные команды
- Применение миграций: `npm run migrate` (или `node scripts/run_migrations.js`).
- Импорт старого JSON-снимка: `npm run import:legacy` (ожидает `planner-state.json` в корне).
- Запуск сервера: `npm start`.
- Проверка доступности API: `curl -i http://localhost:3000/api/state` (ожидает JSON с `rev` и ETag).

## 4. SQL-объекты
- Основные таблицы: `users`, `processes`, `customers`, `orders`, `order_process`, `capacity_by_process`, `settings_autoweight`, `settings_journal`, `settings_column_widths`, `settings_mapping`, `settings_admin`, `excluded_statuses`, `activity_log`, `revisions`.
- История: `orders_hist`, `order_process_hist`, `capacity_by_process_hist`, `settings_autoweight_hist`, `settings_journal_hist`, `settings_column_widths_hist`, `settings_mapping_hist`, `settings_admin_hist`, `excluded_statuses_hist`.
- Триггеры: `orders_history_trg`, `order_process_history_trg`, `capacity_by_process_history_trg`, `settings_autoweight_history_trg`, `settings_journal_history_trg`, `settings_column_widths_history_trg`, `settings_mapping_history_trg`, `settings_admin_history_trg`, `excluded_statuses_history_trg`, а также `orders_updated_at`, `order_process_updated_at`.
- Код, работающий с этими объектами: `migrations/003_full_sql_schema.sql`, `server.js`, `scripts/import_legacy_snapshot.js`.

## 5. Тест-план (дата 2025-02-14)
| Тест | Статус | Комментарий |
| --- | --- | --- |
| 6.1 CRM изменение | не пройдено (не выполнялось) | Требуется ручной прогон после развёртывания БД |
| 6.2 Планировщик изменение | не пройдено (не выполнялось) | Требуется ручной прогон |
| 6.3 Настройки последовательные сохранения | не пройдено (не выполнялось) | Требуется ручной прогон |
| 6.4 Конкурентность CRM+Planner | не пройдено (не выполнялось) | Требуется ручной прогон |
| 6.5 Исключённые статусы | не пройдено (не выполнялось) | Требуется ручной прогон |
| 6.6 Корзина | не пройдено (не выполнялось) | Требуется ручной прогон |
| 6.7 История/Откат | не пройдено (не выполнялось) | Требуется ручной прогон |
| 6.8 Производительность | не пройдено (не выполнялось) | Нужны данные о целевых объёмах |

## 6. Известные ограничения и «что дальше»
- Текущий фронтенд всё ещё ожидает монолитный JSON; требуется адаптация UI к новому DTO/протоколу изменений.
- Таблица `capacity_by_process` заполняется импортом с условной датой (текущий день) из агрегированных данных legacy — требуется уточнение бизнес-логики по дневным мощностям.
- Настройки сопоставлений и ширин колонок импортируются в дефолтном виде (legacy-снимок не содержит этих данных); необходимо обеспечить миграцию актуальных настроек при наличии источников.
- Производственные сценарии (конкурентные записи, загрузка больших массивов заказов) не тестировались — требуется нагрузочное тестирование после интеграции.
