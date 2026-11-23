/**
 * Смоук-тест мок-сервера: проверяет протокол без браузера.
 *
 * Запуск: npm run smoke  (сервер должен работать, либо поднимите его отдельно)
 *
 * Сценарий:
 *  1. открываем WS /identity/v3/auth/qr -> ждём QR_UPDATED;
 *  2. закрываем WS -> сервер должен удалить qr-session (активных 0);
 *  3. открываем повторно -> новый ws_connection_id и новый qr_session_id;
 *  4. шлём RESUME_QR -> повторный QR_UPDATED с той же сессией;
 *  5. GET /auth -> AUTH_SUCCESS по активной сессии;
 *  6. GET /kill -> все соединения оборваны (симуляция рестарта пода).
 */
import http from "node:http";
import { WebSocket } from "ws";

const BASE = process.env.BASE_URL ?? "http://localhost:9735";
const WS_URL = BASE.replace(/^http/, "ws") + "/identity/v3/auth/qr";

const getJson = (path: string): Promise<any> =>
  new Promise((resolve, reject) => {
    http
      .get(`${BASE}${path}`, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });

/**
 * Открывает WS и ждёт первое сообщение с timeout.
 * Возвращает сообщение и сам сокет (его можно закрыть).
 */
const openAndWaitFirst = (label: string): Promise<{ msg: any; ws: WebSocket }> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const t = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timeout: первое сообщение не пришло (${label})`));
    }, 5000);

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      clearTimeout(t);
      resolve({ msg, ws });
    });
    ws.on("error", reject);
  });

/** Ждёт вхождение сообщения нужного типа (или timeout). */
const waitForMessage = (
  ws: WebSocket,
  type: string,
  timeoutMs = 5000,
): Promise<any> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error(`timeout: сообщение ${type} не пришло`));
    }, timeoutMs);

    const handler = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === type) {
        clearTimeout(t);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown): void => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  (${JSON.stringify(detail)})` : ""}`,
  );
  if (!ok) failed += 1;
};

(async () => {
  // 1. первое подключение -> QR_UPDATED
  const { msg: first, ws: firstWs } = await openAndWaitFirst("первое подключение");
  check(
    "QR_UPDATED при подключении",
    first.type === "QR_UPDATED" &&
      typeof first.data.qr_session_id === "string" &&
      first.data.ws_connection_id >= 1,
    first,
  );

  // 2. закрытие -> сессия удалена
  await new Promise<void>((resolve) => {
    firstWs.on("close", () => resolve());
    firstWs.close();
  });
  await new Promise((r) => setTimeout(r, 300));
  const status1 = await getJson("/");
  check("qr-session удалён после close", status1.activeConnections === 0, status1);

  // 3. повторное подключение -> новые id (как после реконнекта в pep-app)
  const { msg: second, ws: secondWs } = await openAndWaitFirst("второе подключение");
  check(
    "новое соединение = новый QR (новые session_id и connection_id)",
    second.data.ws_connection_id === first.data.ws_connection_id + 1 &&
      second.data.qr_session_id !== first.data.qr_session_id,
    { first: first.data, second: second.data },
  );

  // 4. RESUME_QR -> повторный QR_UPDATED с той же сессией
  void secondWs.send(JSON.stringify({ type: "RESUME_QR" }));
  const resumed = await waitForMessage(secondWs, "QR_UPDATED");
  check(
    "RESUME_QR -> QR_UPDATED с той же сессией",
    resumed.data.qr_session_id === second.data.qr_session_id,
    resumed,
  );

  // 5. AUTH_SUCCESS по активной сессии
  // Слушатель регистрируем ДО запроса, как это делает реальный клиент,
  // иначе фрейм может прийти раньше, чем прикрутится обработчик.
  const authPromise = waitForMessage(secondWs, "AUTH_SUCCESS");
  const authRes = await getJson(`/auth?connectionId=${second.data.ws_connection_id}`);
  const authMsg = await authPromise;
  check(
    "AUTH_SUCCESS доставлен и соответствует сессии",
    authRes.sentTo === 1 && authMsg.data.qr_session_id === second.data.qr_session_id,
    authMsg,
  );

  // 6. /kill рвёт все соединения (симуляция рестарта пода fgw)
  const killRes = await getJson("/kill");
  check("KILL оборвал соединения", killRes.activeBefore >= 1 && killRes.killed === true, killRes);

  await new Promise((r) => setTimeout(r, 300));
  const status2 = await getJson("/");
  check("после KILL активных нет", status2.activeConnections === 0, status2);

  console.log(failed === 0 ? "\nВсе проверки пройдены." : `\nПровалено проверок: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => {
  console.error("Смоук-тест упал:", err);
  process.exit(1);
});
