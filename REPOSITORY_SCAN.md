# Обзор репозитория mpk-b24-api

## Назначение
Сервис интеграции с Bitrix24, обрабатывающий веб‑хуки, внутреннее API для операций с лидами и фоновые задачи для SPA‑1048. Проект построен на Express и использует отдельные модули для бизнес‑логики (Bitrix‑клиент, SPA‑1048 и вспомогательные утилиты).

## Структура проекта

```
src/
  app.js                     # Настройка Express, маршрутизация и middleware
  server.js                  # Запуск HTTP‑сервера
  routes/                    # Роуты публичных веб‑хуков и внутреннего API
  controllers/               # Контроллеры (тонкий слой, делегирует в сервисы)
  services/                  # Взаимодействие с Bitrix и внешними сервисами
  modules/                   # Бизнес‑модули SPA‑1048
  config/                    # Конфигурация и env‑настройки
  jobs/                      # Периодические фоновые задачи (PM2/cron)
  workers/                   # Долгоживущие воркеры
  middlewares/               # Middleware (логирование, ошибки, доступ)
  utils/                     # Утилиты
```

## Точки входа
- `src/server.js` поднимает HTTP‑сервер и слушает порт из `src/config/env.js`.
- `src/app.js` регистрирует middleware, JSON‑парсеры, маршруты `/b24` и `/api/v1/bitrix`, а также health‑endpoint `/health`.

## Основные маршруты

### Публичные веб‑хуки (`/b24`)
- `POST|GET /b24/spa-event` — входящие события SPA‑1048.
- `POST|GET /b24/task-event` — события задач для SPA‑1048.
- `POST|GET /b24/task-update` — обновления задач (webhook).

### Внутреннее API (`/api/v1/bitrix`)
- `GET|POST /leads/:leadId/create-contact-by-phone` — создание контакта из лида по телефону.
- `GET|POST /leads/:leadId/set-current-order-no` — установка номера текущего заказа.
- `GET|POST /leads/:leadId/move-current-to-closed` — перенос в «Закрытые».
- `GET|POST /leads/pause-sync` — пакетная синхронизация «Пауза» (локальный доступ).
- `GET|POST /leads/:leadId/pause-sync` — точечная синхронизация «Пауза» (локальный доступ).
- `GET|POST /events/task-update` — fallback для событий задач.

## Фоновые задачи и воркеры
- `src/jobs/spa1048UrgentWatcher.js` — периодически переводит счета в статус «Срочно к оплате».
- `src/workers/spa1048TaskStatusWatcher.worker.js` — воркер, проверяющий завершение задач и обновляющий стадии SPA‑1048.

## Конфигурация
- `src/config/env.js` — базовые переменные окружения: `PORT`, `BITRIX_WEBHOOK_BASE`, `WEBHOOK_TOKEN`.
- Дополнительные параметры SPA‑1048 подключаются через `src/config/spa1048` и `src/modules/spa1048`.

## Скрипты
В `package.json` определены базовые команды:
- `npm run start` — запуск сервера.
- `npm run dev` — dev‑запуск.
- `npm test` — запуск Jest (без тестов допустим).

Дополнительно в корне есть вспомогательные shell‑скрипты для запуска ручных синхронизаций.
