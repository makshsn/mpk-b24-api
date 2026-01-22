# Bitrix24 outbound webhooks: формат payload для событий задач

Ниже — реальный формат, в котором Bitrix24 шлёт **исходящий вебхук** (Outgoing webhook) на наш сервер.  
Важно: Bitrix чаще всего отправляет `Content-Type: application/x-www-form-urlencoded`, то есть тело — **urlencoded**, а в Express оно превращается в вложенный объект через `express.urlencoded({ extended: true })`.

## Куда слать для отладки

Для проверки «что реально прилетает» используется инспектор:

- Endpoint: `POST /b24/_inspect/in`
- Получить последнее: `GET /b24/_inspect/last`
- Список: `GET /b24/_inspect/list?n=10`
- По id: `GET /b24/_inspect/get/<ID>`

Пример:

```bash
curl -sS "https://mpk-b24-webhooks.online/b24/_inspect/last"   | jq '.item.method, .item.path, .item.body, .item.rawBody'
```

## Пример реального payload (ONTASKCOMMENTADD)

Это пример события **добавления комментария** в задачу. Обрати внимание:  
- `data.FIELDS_AFTER.ID` может быть **0** (это не taskId)  
- реальный ID задачи находится в `data.FIELDS_AFTER.TASK_ID`

### То, как это выглядит после парсинга Express (body)

```json
{
  "event": "ONTASKCOMMENTADD",
  "event_handler_id": "404",
  "data": {
    "FIELDS_BEFORE": "undefined",
    "FIELDS_AFTER": {
      "ID": "0",
      "MESSAGE_ID": "48760",
      "TASK_ID": "2536"
    },
    "IS_ACCESSIBLE_BEFORE": "N",
    "IS_ACCESSIBLE_AFTER": "undefined"
  },
  "ts": "1769071218",
  "auth": {
    "domain": "b24-mg3u3i.bitrix24.ru",
    "client_endpoint": "https://b24-mg3u3i.bitrix24.ru/rest/",
    "server_endpoint": "https://oauth.bitrix24.tech/rest/",
    "member_id": "c7848c26da9f20fa0d54043bf464b60c",
    "application_token": "yp5j69lbdodv8vx138ok4kjay8kp19aj"
  }
}
```

### То, как это приходит «сырым» (rawBody, urlencoded)

```text
event=ONTASKCOMMENTADD&
event_handler_id=404&
data[FIELDS_BEFORE]=undefined&
data[FIELDS_AFTER][ID]=0&
data[FIELDS_AFTER][MESSAGE_ID]=48760&
data[FIELDS_AFTER][TASK_ID]=2536&
data[IS_ACCESSIBLE_BEFORE]=N&
data[IS_ACCESSIBLE_AFTER]=undefined&
ts=1769071218&
auth[domain]=b24-mg3u3i.bitrix24.ru&
auth[client_endpoint]=https%3A%2F%2Fb24-mg3u3i.bitrix24.ru%2Frest%2F&
auth[server_endpoint]=https%3A%2F%2Foauth.bitrix24.tech%2Frest%2F&
auth[member_id]=c7848c26da9f20fa0d54043bf464b60c&
auth[application_token]=yp5j69lbdodv8vx138ok4kjay8kp19aj
```

## Что важно для логики «слежения за задачами»

### 1) Где искать ID задачи (taskId)

В зависимости от `event` taskId может быть в разных местах. Для `ONTASKCOMMENTADD` — это:

- `body.data.FIELDS_AFTER.TASK_ID` ✅ (самое важное)
- иногда `body.data.FIELDS_AFTER.ID` — **НЕ taskId** (может быть `0`)

Поэтому извлечение taskId должно проверять **оба пути**, начиная с `TASK_ID`.

Рекомендуемый порядок поиска:

1. `data.FIELDS_AFTER.TASK_ID`
2. `data.FIELDS_BEFORE.TASK_ID`
3. `data.FIELDS_AFTER.ID` (только если похоже на taskId и > 0)
4. `data.FIELDS_BEFORE.ID` (только если > 0)
5. fallback: глубокий поиск по ключам `TASK_ID`, `task_id`, `ID`, `id`

### 2) Где искать статус (completed / STATUS=5)

Для событий типа `ONTASKUPDATE` Bitrix обычно шлёт изменения в `data[FIELDS_AFTER][STATUS]`.  
Поэтому логика должна уметь извлекать:

- `data.FIELDS_AFTER.STATUS`
- `data.FIELDS_BEFORE.STATUS` (если нужно сравнение)

И только при `STATUS=5` выполнять перенос SPA в `DT1048_14:SUCCESS`.

### 3) Токен (application_token)

Bitrix передаёт `auth.application_token` (см. пример выше).  
Проверка токена — опциональна: можно включать/выключать через переменную окружения, чтобы не блокировать отладку.

## Подсказка для Codex: рефактор «слежения за задачами»

Задача рефактора:

- сделать единый модуль `extractTaskContext(req)` который возвращает:
  - `event`
  - `taskId`
  - `statusAfter` / `statusBefore`
  - `raw` (кусок payload для логов)
- учесть, что:
  - payload может быть `application/x-www-form-urlencoded`
  - `TASK_ID` может лежать в `FIELDS_AFTER`, а `ID` там может быть `0`
- покрыть unit-тестами 2–3 реальных примера payload:
  - `ONTASKCOMMENTADD` (TASK_ID)
  - `ONTASKUPDATE` (ID + STATUS)
  - пустой GET (если где-то остался)
