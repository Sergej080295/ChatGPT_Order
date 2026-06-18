# Developer handover: как продолжать разработку

## Первый день новой команды

1. Склонировать репозиторий.
2. Установить зависимости: `npm install`.
3. Сделать backup текущего `data/`.
4. Запустить `node server.js`.
5. Войти под тестовым админом или учетной записью из `data/credentials.json`.
6. Пройти smoke-test из `QA_TROUBLESHOOTING.md`.
7. Открыть последние коммиты `git log --oneline -20` и сопоставить с `VERSION_HISTORY.md`.

## Как искать нужный код

Так как фронтенд монолитный, используйте `rg`:

```bash
rg -n "function renderCrmStageGantt|buildCrmStageSchedule|normalizeCapacityMap" public/CRM.html
rg -n "app.put\('/api/state'|requireAuth|ROLE_PERMISSION_KEYS" server.js
```

Примеры точек входа:

| Задача | Где искать |
| --- | --- |
| Сохранение данных | `save()` в `public/CRM.html`, `PUT /api/state` в `server.js`. |
| Нормализация состояния | `ensureCrmStateShape()`, `sanitizeCrmSettings()`. |
| Переделы | `CRM_BASE_STAGE_PRESETS`, `ensureCrmDynamicStageCatalog()`. |
| Вместимость | `normalizeCapacityMap()`, `getCrmCapacityStageKeysForSettings()`. |
| Параллельность | `normalizeParallelMap()`, `getCrmParallelStageKeysForSettings()`. |
| Расписание | `buildCrmStageSchedule()`. |
| Гант | `renderCrmStageGantt()`, CSS `.crm-stage-gantt-*`. |
| Конфликты данных | `collectCrmSettingsConflicts()`. |
| Права | `ROLE_PERMISSION_KEYS`, `DEFAULT_ROLE_PERMISSIONS`, UI админки. |

## Правила внесения изменений

- Документировать все изменения, которые влияют на данные или пользовательский сценарий.
- Не добавлять новые поля состояния без sanitizer и миграции старых данных.
- Не менять дефолты вместимости/параллельности без проверки sparse-сохранения.
- При изменении переделов проверять старые заказы и окно конфликтов.
- При изменении API сохранять совместимость фронтенда и документацию.
- При изменении авторизации проверять гостя, мастера, админа и супер-админа.

## Рекомендации по будущему рефакторингу

1. Разделить `public/CRM.html` на модули: state, api, settings, gantt, admin, orders.
2. Добавить автоматические UI-тесты Playwright.
3. Добавить unit-тесты для sanitizer-функций и расписания.
4. Добавить миграции состояния CRM с явным номером версии.
5. Добавить dev seed данных для воспроизведения багов.
6. Добавить отдельный API для настроек вместо сохранения всего snapshot.
7. Добавить server-side validation CRM snapshot перед записью.

## Definition of Done для багфикса

Баг считается исправленным, если:

- есть понятное описание причины;
- исправление минимально и не ломает смежные сценарии;
- пройдены синтаксические проверки;
- пройден ручной сценарий воспроизведения;
- проверены смежные функции из документации;
- обновлена документация, если изменилось поведение;
- commit и PR содержат понятное описание.
