# qr-ws-mock

Мок [front-gateway](https://example.com) (fgw) для локальной проверки авто-реконнекта QR-входа.
Повторяет поведение `QrAuthWebSocketHandler.kt` из реального front-gateway:

- каждое новое WS-соединение получает **новый `ws_connection_id`** и **новый `qr_session_id`**;
- сразу после открытия соединения клиенту шлётся `QR_UPDATED`;
- при закрытии соединения qr-session «удаляется» (как в igw) — старый QR-код становится невалидным.

Сделано для проверки фронта [pep-app](https://example.com): хук `useAuthQRWebSocket` должен
сам переподключаться после обрыва (напр. после выката fgw/igw) и показывать новый QR без F5.

## Стек

Express + TypeScript + `ws`, менеджер пакетов — **yarn** (v1 classic, как в pep-app).
Без сборок в рантайме: `yarn build` → обычный `node dist/index.js`.

## Запуск

```bash
yarn install
yarn dev           # tsx watch src/index.ts (порт 9735 по умолчанию)
```

Или production:

```bash
yarn build
yarn start
```

Порт меняется переменной окружения `PORT` (см. `.env.example`).

По умолчанию слушает **9735** — ровно тот порт, что указан в `pep-app/.env.development.local`
(`NEXT_PUBLIC_APP_WS=ws://localhost:9735`), поэтому фронт подключается без правок.

## Подключение из Next.js (pep-app)

В `pep-app/.env.development.local` уже стоит:

```
NEXT_PUBLIC_APP_WS=ws://localhost:9735
```

Хук подключается к `${NEXT_PUBLIC_APP_WS}/identity/v3/auth/qr`, то есть
`ws://localhost:9735/identity/v3/auth/qr` — этому маршруту и отвечает мок.
Дополнительная настройка не нужна: `yarn dev` в обоих проектах — и всё работает.

## Протокол

### WS: `/identity/v3/auth/qr`

Сервер → клиент:

| type            | когда                                  | data                        |
| --------------- | -------------------------------------- | --------------------------- |
| `QR_UPDATED`    | при подключении и на `RESUME_QR`       | `{ qr_session_id, ws_connection_id }` |
| `AUTH_SUCCESS`  | по `GET /auth` (сканирование QR)       | `{ qr_session_id }`         |
| `SESSION_EXPIRED`| по `GET /pause`                        | `{ qr_session_id }`         |

Клиент → сервер:

| type       | эффект                                  |
| ---------- | --------------------------------------- |
| `RESUME_QR`| повторная отправка текущего `QR_UPDATED`|

### HTTP (для симуляции инцидентов)

| метод/путь                          | что делает                                              |
| ----------------------------------- | ------------------------------------------------------- |
| `GET /`                             | статус: активные соединения + счётчики                  |
| `GET /health`                       | healthcheck                                             |
| `GET /kill`                         | рвёт **все** WS — симуляция `kubectl rollout restart`   |
| `GET /kill/:connectionId`           | рвёт одно соединение по id                              |
| `GET /auth`                         | шлёт `AUTH_SUCCESS` всем (или одному: `?connectionId=N`)|
| `GET /pause`                        | шлёт `SESSION_EXPIRED` всем (или одному)                |

## Проверка реконнекта (ручной сценарий)

1. Запустить мок: `yarn dev`.
2. Запустить pep-app: `yarn dev` → открыть страницу входа с QR.
3. В DevTools вкладки Network → WS: видно открытое соединение
   `.../identity/v3/auth/qr`, первый фрейм `QR_UPDATED`.
4. Оборвать соединение (аналог выката на PROD):

   ```
   curl http://localhost:9735/kill
   ```

   (или просто остановить мок / `kubectl -n egov rollout restart deploy/front-gateway` на stage).
5. **Ожидание:** через 2 с хук сам открывает новое соединение, приходит новый
   `QR_UPDATED`, и на экране рисуется **новый рабочий QR без F5**.
6. Проверить, что вход работает: `curl "http://localhost:9735/auth"` → фронт уходит
   в финализацию, и после этого WS **не** переоткрывается.

Поведение фронта: backoff `2s → 4s → 8s → ... → 30s`, максимум 10 попыток;
после `AUTH_SUCCESS`, `SESSION_EXPIRED`, `QR_PAUSED`, `AUTH_FAILED` или размонтирования
реконнект не происходит.

## Смоук-тест (без браузера)

```bash
yarn dev           # в одном терминале
yarn smoke         # в другом
```

Проверяет: `QR_UPDATED` при подключении, удаление сессии после close, новые id
на повторном подключении, `RESUME_QR`, `AUTH_SUCCESS`, `/kill`.

## Безопасность

Проект не содержит секретов: только публичные зависимости и заглушки-идентификаторы
(`qr-sess-<uuid>`). Свободен к публикации в публичный GitHub.
