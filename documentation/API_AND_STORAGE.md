# API, хранение данных и конфигурация

## HTTP API

### Авторизация

| Метод | Путь | Право | Назначение |
| --- | --- | --- | --- |
| `POST` | `/auth/login` | нет | Вход по логину/паролю. |
| `POST` | `/auth/guest` | гостевой режим | Создание гостевой сессии. |
| `POST` | `/auth/logout` | сессия | Выход и удаление сессии. |
| `GET` | `/me` | нет | Текущий пользователь, режим auth и гостевой доступ. |

### Администрирование

| Метод | Путь | Право | Назначение |
| --- | --- | --- | --- |
| `GET` | `/admin/users` | `manageUsers` | Список пользователей. |
| `POST` | `/admin/users` | `manageUsers` | Создать/обновить пользователя. |
| `DELETE` | `/admin/users/:id` | `manageUsers` | Удалить пользователя. |
| `GET` | `/admin/roles/description` | `manageUsers` | Получить описания ролей. |
| `POST` | `/admin/roles` | `manageUsers` | Создать/обновить роль. |
| `PUT` | `/admin/roles/description` | `manageUsers` | Изменить описание ролей. |
| `GET` | `/admin/audit` | `viewAudit` | Получить аудит. |

### Состояние приложения

| Метод | Путь | Право | Назначение |
| --- | --- | --- | --- |
| `GET` | `/api/state` | `view` | Получить текущий snapshot состояния. |
| `PUT` | `/api/state` | `write` | Сохранить snapshot состояния. |
| `GET` | `/api/events` | `view` | SSE-поток ревизий. |

### Исторические admin endpoints

Эти endpoints оставлены для совместимости, но история/rollback отключены:

| Метод | Путь | Ответ |
| --- | --- | --- |
| `GET` | `/api/admin/history` | `{ items: [] }` |
| `GET` | `/api/admin/history/:hash` | `404 History disabled` |
| `DELETE` | `/api/admin/history` | `410 History storage disabled` |
| `POST` | `/api/admin/snapshot` | `410 Snapshot storage disabled` |
| `POST` | `/api/admin/rollback` | `410 Rollback disabled` |

## Коды ошибок, важные для UI

| Код | Когда возникает | Что делать |
| --- | --- | --- |
| `401` | Нет сессии или неверный логин/пароль. | Перелогиниться. |
| `403` | Нет права или канал записи запрещен. | Проверить роли/режим записи. |
| `412` | Hash snapshot не совпал. | Загрузить свежие данные и повторить действие. |
| `423` | Учетная запись временно заблокирована. | Дождаться `lockedUntil` или разблокировать админом. |
| `507` | Нет прав записи в `data/`/SQLite. | Проверить владельца и права каталога данных. |
| `500` | Необработанная ошибка сервера. | Смотреть лог сервера. |

## SQLite-схема

Основная база — `data/planner.db`.

| Таблица | Назначение |
| --- | --- |
| `snapshots` | Версионные снимки состояния приложения: `rev`, `hash`, `state_json`, meta, actor/source/channel. |
| `kv_store` | Универсальное key-value хранилище. |
| `planner_settings` | Нормализованное зеркало настроек планировщика. |
| `stage_allocations` | Зеркало распределений по переделам. |
| `roles` | Роли и JSON прав. |
| `users` | Пользователи, пароль, статус, блокировки. |
| `user_roles` | Связь пользователей и ролей. |
| `sessions` | Активные сессии. |
| `audit_log` | Аудит входов, действий админки и важных изменений. |

## Файлы данных

| Путь | Назначение |
| --- | --- |
| `data/planner.db` | Основная SQLite база. |
| `data/credentials.json` | Seed/синхронизация учетных записей. |
| `data/users.json` | Экспорт/служебный файл пользователей, если используется. |
| `data/planner-state.json` | Legacy/local state file; основной runtime сейчас через SQLite snapshot. |

## Переменные окружения

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `PORT` | `3000` | HTTP порт. |
| `DATA_DIR` | `./data` | Каталог данных. |
| `SESSION_TTL_HOURS` | `72` | Срок жизни сессии в часах. |
| `SESSION_COOKIE_NAME` | `pc_session` с авто-суффиксами | Имя cookie сессии. |
| `SESSION_COOKIE_SUFFIX` | пусто | Явный суффикс cookie. |
| `INSTANCE_ID` / `PLANNER_INSTANCE` / `APP_INSTANCE` | пусто | Суффикс cookie для нескольких инстансов. |
| `COOKIE_SECURE` | auto | Принудительный secure-cookie режим. |
| `COOKIE_SECURE_DEFAULT` | `false` | Secure-cookie по умолчанию. |
| `REQUEST_BODY_LIMIT` / `BODY_SIZE_LIMIT` | `10 MiB` | Лимит JSON/body. |
| `AUTH_MODE` | `local` | Режим авторизации. |
| `ALLOW_GUEST` | `true` | Разрешить гостевой вход. |
| `DEFAULT_ADMIN_LOGIN` | `admin` | Логин seed-админа. |
| `DEFAULT_ADMIN_PASSWORD` | `admin123` | Пароль seed-админа. |
| `AUTH_MAX_FAILED_ATTEMPTS` | `5` | Количество неудачных попыток до блокировки. |
| `AUTH_LOCKOUT_MINUTES` | `15` | Длительность блокировки. |

## Права ролей

Ключи прав:

- `view`, `write`;
- `viewOrderDetails`;
- `createOrders`, `editOrders`, `deleteOrders`;
- `updateStageProgress`, `editStageDetails`, `editStageDates`;
- `manageUsers`, `manageSettings`, `manageStages`;
- `completeOrders`;
- `viewAudit`;
- `useJournal`;
- `editComments`, `deleteComments`;
- `addStages`;
- `stageAccess` по переделам.

При добавлении нового действия нужно:

1. Добавить ключ в серверный список прав.
2. Добавить дефолты ролей.
3. Отобразить право в UI ролей.
4. Проверить `requireAuth()` или серверный guard.
5. Проверить скрытие/disabled кнопок во фронтенде.

## Snapshot и конкурентная запись

Клиент должен сохранять hash текущего snapshot. При `PUT /api/state` сервер сравнивает expected hash с текущим. Если hash не совпал и нет `forceOverwrite`, запись отклоняется.

Это защищает от потери данных при нескольких вкладках, но требует аккуратной обработки на клиенте: нельзя молча перезаписывать новый snapshot старым локальным состоянием.

## Backup

Перед релизом или массовой миграцией:

```bash
cp data/planner.db data/planner.db.backup-$(date +%Y%m%d-%H%M%S)
cp data/credentials.json data/credentials.json.backup-$(date +%Y%m%d-%H%M%S)
```

Для проверки SQLite:

```bash
sqlite3 data/planner.db 'PRAGMA integrity_check;'
sqlite3 data/planner.db 'SELECT rev, hash, saved_at FROM snapshots ORDER BY rev DESC LIMIT 5;'
```
