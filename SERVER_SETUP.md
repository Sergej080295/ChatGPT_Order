# Развёртывание Planner Codex v3 с PostgreSQL

Документ описывает полный цикл подготовки сервера для работы с Planner Codex v3 (актуальная веб-версия: `public/Planner_Codex_v3.html`).
Серверное приложение сохраняет состояние планировщика и журнал активности в базе PostgreSQL, обеспечивает live-синхронизацию через SSE и устойчиво работает при одновременной работе нескольких пользователей.

## 1. Требования

| Компонент | Рекомендации |
|-----------|---------------|
| ОС | Linux (Ubuntu 22.04+), macOS 13+, Windows Server 2019+ |
| Node.js | LTS (>= 18.x) |
| npm | Устанавливается вместе с Node.js |
| PostgreSQL | 14 или новее |
| Память | ≥ 1 ГБ ОЗУ |
| CPU | ≥ 1 vCPU |

Дополнительно рекомендуется настроить резервное копирование (pg_dump) и мониторинг доступности сервера.

## 2. Структура проекта

```
├── package.json
├── package-lock.json
├── public/
│   └── Planner_Codex_v3.html
├── server.js
└── SERVER_SETUP.md (этот файл)
```

> ⚠️ Файл `planner-state.json` больше не используется. Если он присутствует, сервер автоматически импортирует его содержимое в PostgreSQL только при первом запуске (чтобы сохранить исторические данные) и далее опирается исключительно на СУБД.

## 3. Установка Node.js и зависимостей

1. Установите Node.js LTS с [https://nodejs.org/](https://nodejs.org/).
2. Проверьте версии:
   ```bash
   node -v
   npm -v
   ```
3. В каталоге проекта выполните:
   ```bash
   npm install
   ```
   Будут установлены `express` и `pg`.

## 4. Установка и настройка PostgreSQL

### 4.1 Установка

Пример для Ubuntu:
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
```
Для Windows/macOS используйте официальный [инсталлятор](https://www.postgresql.org/download/).

### 4.2 Создание пользователя и базы данных

```bash
sudo -u postgres psql
CREATE USER planner WITH PASSWORD 'planner';
CREATE DATABASE planner OWNER planner;
\q
```

Рекомендуется задать более сложный пароль и ограничить сетевые подключения (см. `pg_hba.conf`).

### 4.3 Минимально необходимые права

Пользователю достаточно прав `CONNECT` к базе и `CREATE/INSERT/UPDATE/SELECT` для схемы по умолчанию. Таблицы будут созданы автоматически при первом запуске.

### 4.4 Настройка SSL (по желанию)

Если база доступна по сети и требуется шифрование, включите SSL в PostgreSQL и установите переменную окружения `PGSSLMODE=require` (или `PGSSL=true`) на стороне приложения.

## 5. Конфигурация сервера приложения

### 5.1 Переменные окружения

| Имя | Описание | Значение по умолчанию |
|-----|----------|-----------------------|
| `PORT` | HTTP-порт Express | `3000` |
| `DATABASE_URL` | Строка подключения PostgreSQL (`postgres://user:pass@host:port/db`) | `postgresql://planner:planner@localhost:5432/planner` |
| `PGSSLMODE` / `PGSSL` | Включение SSL (`require` или `true`) | `false` |
| `PGPOOL_MAX` | Размер пула соединений | `10` |
| `PGPOOL_IDLE` | Таймаут простаивающих соединений (мс) | `30000` |
| `PLANNER_SKIP_LEGACY_IMPORT` | Установите `true`, чтобы пропустить импорт из `planner-state.json` при первом запуске | `false` |
| `JWT_SECRET` | Секрет для подписи JWT-токенов | `planner-secret` |
| `JWT_TTL` | Время жизни токена (секунды) | `86400` |
| `DEFAULT_ADMIN_EMAIL` | Email учётной записи администратора, создаваемой автоматически | `admin@example.com` |
| `DEFAULT_ADMIN_PASSWORD` | Пароль администратора по умолчанию | `change-me` |
| `DEFAULT_ADMIN_NAME` | Имя в интерфейсе для администратора | `Administrator` |

Создайте файл `.env` (используя `dotenv` или аналогичный менеджер переменных) либо экспортируйте переменные перед запуском.

Пример (`.env`):
```
PORT=3000
DATABASE_URL=postgresql://planner:SUPER-SECRET@db.example.com:5432/planner
PGSSLMODE=require
PGPOOL_MAX=20
```

### 5.2 Инициализация схемы

При запуске `server.js` автоматически создаёт таблицы (если их нет):

- `planner_state` — хранит текущее состояние планировщика (режим CSV) и метаданные.
- `planner_activity_log` — журнал всех операций сохранения (пользователь, стадия, diff, IP).
- `crm_orders` — заказы CRM (статусы, суммы, исполнители, soft-delete через `deleted_at`).
- `crm_stages` — переделы заказа, прогресс, даты, трудоёмкость.
- `users` — учётные записи (роль `admin`/`worker`/`viewer`, хеш пароля `bcrypt`).
- `activity_log` — унифицированный лог действий с CRM (создание/правка/удаление).

Если база была пустой, сервер также импортирует состояние из `planner-state.json` (если файл существует) и далее опирается только на PostgreSQL. После первой инициализации данные CRM сохраняются исключительно в SQL-базе.

> ℹ️ При первом запуске создаётся администратор с учетными данными из переменных `DEFAULT_ADMIN_*`. В дев-режиме это `admin@example.com / change-me`. Измените пароль сразу после входа.

## 6. Запуск

```bash
npm start
```

По умолчанию сервер доступен на `http://localhost:3000`. Первым делом в консоли появится сообщение `Planner server running on http://localhost:3000`.

> 💡 Если при запуске появляется ошибка `Error: listen EADDRINUSE ... 3000`, значит порт уже занят другим процессом.
> Остановите старый экземпляр (`Ctrl+C`, `Stop-Process -Id <PID>` в PowerShell) либо укажите другой порт:
> ```powershell
> $env:PORT=3001
> npm start
> ```
> После проверки можно вернуть стандартное значение `3000`.

## 7. Проверка работы и тестирование

1. Откройте две разные вкладки/браузера по адресу `http://localhost:3000/` — на обеих должен загрузиться `Planner_Codex_v3.html`.
2. Внесите изменения в одной вкладке (например, добавьте заказ). 
3. При включённом AutoSave через 1–2 секунды изменения появятся во второй вкладке. Сервер подтверждает сохранение HTTP-ответом `200` и транслирует обновлённое состояние через `/api/events` (SSE).
4. Проверьте, что таблица `planner_state` содержит актуальный JSON:
   ```bash
   psql "$DATABASE_URL" -c "SELECT updated_at, left(state, 80) || '...' FROM planner_state;"
   ```
5. Убедитесь, что журнал пополняется:
   ```bash
   psql "$DATABASE_URL" -c "SELECT timestamp, stage, user_name FROM planner_activity_log ORDER BY id DESC LIMIT 5;"
   ```
6. Для проверки обработки конфликтов попробуйте выполнить два PUT-запроса одновременно со старой и новой версией состояния — второй получит `409 Conflict`, при этом сервер не перезапишет свежие данные.

## 8. Эксплуатация и надёжность

- **Резервные копии**: используйте `pg_dump`/`pg_basebackup` по расписанию (минимум ежедневно). Пример cron-задачи: `pg_dump --format=custom planner > /backups/planner-$(date +%F).dump`.
- **Мониторинг**: следите за здоровьем процесса Node.js (systemd, pm2) и PostgreSQL (pg_isready, метрики в Prometheus).
- **Обновления**: перед обновлением приложения делайте бэкап и используйте staging среду.
- **Масштабирование**: при высокой нагрузке увеличьте `PGPOOL_MAX`, разнесите Node.js и PostgreSQL по отдельным машинам и используйте балансировщик (Nginx) для HTTPS.

## 9. Остановка и перезапуск

- `Ctrl + C` — остановка ручного запуска.
- Для продакшена рекомендуются менеджеры процессов (`systemd`, `pm2`). Пример unit-файла systemd приведён ниже.

```
[Unit]
Description=Planner Codex Server
After=network.target postgresql.service

[Service]
Environment=PORT=3000
Environment=DATABASE_URL=postgresql://planner:SUPER-SECRET@localhost:5432/planner
Environment=PGPOOL_MAX=20
WorkingDirectory=/opt/planner
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=planner
Group=planner

[Install]
WantedBy=multi-user.target
```

Активируйте:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now planner.service
```

## 10. Обновление с предыдущих версий

1. Остановите старый сервер.
2. Обновите код до текущей версии.
3. Перенесите `planner-state.json` в корень проекта (рядом с `server.js`), если хотите одноразово импортировать состояние.
4. Запустите новый сервер — запись мигрируется в таблицу `planner_state`, JSON-файл больше не понадобится.
5. Проверьте журналы `planner_activity_log` и убедитесь, что новые изменения фиксируются.

Следуя этому руководству, вы получите стабильный сервер Planner Codex v3 с хранением данных в PostgreSQL и гарантированной синхронизацией между всеми пользователями в режиме реального времени.
