# mpk-b24-api

Сервис интеграции с Bitrix24 для обработки веб‑хуков, синхронизации сущностей и фоновых задач.  
Основной фокус — автоматизация работы с лидами и смарт‑процессом SPA‑1048: создание контактов, обновление полей лида, синхронизация задач и дедлайнов, обработка входящих событий и периодические фоновые проверки.

## Назначение проекта

- **Обработка веб‑хуков Bitrix24** (`/b24/*`) с защитой по токену, логированием и диагностикой.
- **API для внутренних задач** (`/api/v1/bitrix/*`) — вспомогательные операции по лидам и синхронизации.
- **SPA‑1048**: синхронизация задач и дедлайнов, перенос в “Срочно к оплате”, автоматические действия по чек‑листам.
- **Фоновые задачи**: периодический пересмотр срочных оплат и статусов задач.

## Структура директорий (после рефакторинга)

```
src/
  app.js                     # Точка входа приложения (Express)
  server.js                  # Запуск HTTP‑сервера
  routes/                    # Маршруты API и публичных веб‑хуков
  controllers/               # Контроллеры (тонкий слой над сервисами)
  services/bitrix/           # Клиент Bitrix24 + бизнес‑сервисы для лидов/заказов
  modules/spa1048/           # Модули SPA‑1048 (синхронизация, задачи, файлы)
  config/                    # Конфигурация и env‑настройки
  jobs/                      # Фоновые периодические задачи (PM2/cron)
  workers/                   # Долгоживущие воркеры
  middlewares/               # Middleware
  utils/                     # Утилиты
```

## Основные эндпоинты

### Публичные веб‑хуки

Базовый путь: **`/b24`**

- `POST /b24/spa-event` — входящие события SPA‑1048.
- `POST /b24/task-event` — события задач для SPA‑1048.
- `POST /b24/task-update` — обновления задач (webhook).

### Внутреннее API

Базовый путь: **`/api/v1/bitrix`**

- `GET|POST /api/v1/bitrix/leads/:leadId/create-contact-by-phone`  
  Создаёт контакт из лида по телефону.
- `GET|POST /api/v1/bitrix/leads/:leadId/set-current-order-no`  
  Обновляет номер текущего заказа.
- `GET|POST /api/v1/bitrix/leads/:leadId/move-current-to-closed`  
  Переносит из “Текущие” в “Закрытые”.
- `GET|POST /api/v1/bitrix/leads/pause-sync`  
  Пакетная синхронизация “Пауза” (только localhost).
- `GET|POST /api/v1/bitrix/leads/:leadId/pause-sync`  
  Точечная синхронизация “Пауза” (только localhost).
- `GET|POST /api/v1/bitrix/events/task-update`  
  Входящие события по задачам (fallback).

## Переменные окружения

Минимально необходимые:

- `PORT` — порт сервера (по умолчанию 3000).
- `BITRIX_WEBHOOK_BASE` — базовый URL Bitrix REST, например `https://example.bitrix24.ru/rest/<user>/<token>`.
- `WEBHOOK_TOKEN` — токен для внутренних веб‑хуков.

Дополнительные (SPA‑1048):

- `SPA1048_ENTITY_TYPE_ID`
- `SPA1048_ACCOUNTANT_ID`
- `SPA1048_STAGE_ACTIVE`
- `SPA1048_STAGE_FINAL`
- `SPA1048_STAGE_PAID`
- `SPA1048_TASK_ID_FIELD_ORIG`
- `SPA1048_URGENT_STAGE_NAME`
- `SPA1048_URGENT_STAGE_ID`
- `SPA1048_URGENT_DAYS`
- `SPA1048_URGENT_INTERVAL_HOURS`
- `B24_TASK_OUT_TOKEN`
- `B24_OUTBOUND_SPA_TOKEN`

> Полный список переменных уточняйте в `src/config` и модулях `src/modules/spa1048`.

## Запуск проекта

```bash
npm install
npm run dev
```

### Продакшен‑запуск

```bash
npm run start
```

## Удалённые устаревшие файлы

В рамках безопасного рефакторинга удалены неиспользуемые и дублирующие модули:

- `src/services/bitrix/spa1048Sync.js`
- `src/services/bitrix/spa1048TaskDeadlineSync.js`
- `src/services/bitrix/spa1048TaskOutbound.v1.js`
- `src/services/bitrix/task1048Sync.v2.js`
- `src/services/bitrix/crmFileField.js`
- `src/controllers/task.controller.js`
- `src/controllers/spa1048Task.controller.js`
- `src/controllers/spa1048TaskEvent.controller.js`
- `src/modules/spa1048/config.js`
- `src/modules/spa1048/service.js`

## Архитектура и расширяемость

- Логика SPA‑1048 сосредоточена в `src/modules/spa1048`, что упрощает добавление новых сценариев без изменений в API‑слое.
- Контроллеры остаются тонкими — принимают запрос, валидируют и проксируют в сервисы.
- Внутренние сервисы Bitrix вынесены в `src/services/bitrix` и могут переиспользоваться между задачами.
