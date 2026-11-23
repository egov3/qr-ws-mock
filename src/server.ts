import http from "node:http";

import express from "express";
import { WebSocket, WebSocketServer } from "ws";

import { qrSessionStore } from "./qrSessionStore";
import { WS_MESSAGE_TYPE } from "./types";
import type { IWsClientState, TStats } from "./types";

const WS_PATH = "/identity/v3/auth/qr";

const app = express();
const server = http.createServer(app);

const clients = new Map<WebSocket, IWsClientState>();
let totalConnections = 0;
let lastConnectionId = 0;
let kills = 0;
const startedAt = Date.now();

/** Отправляет JSON-сообщение клиенту, если соединение открыто. */
const send = (socket: WebSocket, message: unknown): void => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
};

/**
 * Обработка нового WS-создания — аналог QrAuthWebSocketHandler.kt:
 *  1. каждому соединению выдаётся новый ws_connection_id;
 *  2. создаётся новая qr-session;
 *  3. клиенту сразу шлётся QR_UPDATED с новым qr_session_id.
 * После реконнекта клиент получает новый валидный QR-код.
 */
const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on("connection", (socket) => {
  lastConnectionId += 1;
  totalConnections += 1;

  const connectionId = lastConnectionId;
  const session = qrSessionStore.create(connectionId);
  const state: IWsClientState = {
    connectionId,
    sessionId: session.sessionId,
    socket,
    paused: false,
  };
  clients.set(socket, state);

  console.log(
    `[qr-ws-mock] + WS соединение #${connectionId}, qr_session_id=${session.sessionId} (активно: ${clients.size})`,
  );

  send(socket, qrSessionStore.buildQrUpdated(session));

  socket.on("message", (raw) => {
    let message: { type?: string };
    try {
      message = JSON.parse(raw.toString());
    } catch {
      console.warn(`[qr-ws-mock] #${connectionId}: не-JSON сообщение, игнорируем`);
      return;
    }

    if (message.type === WS_MESSAGE_TYPE.resume) {
      // Клиент попросил восстановить/перерисовать QR (кнопка refresh)
      state.paused = false;
      console.log(`[qr-ws-mock] #${connectionId}: RESUME_QR`);
      send(socket, qrSessionStore.buildQrUpdated(session));
      return;
    }

    console.log(`[qr-ws-mock] #${connectionId}: неизвестный тип "${message.type}", игнорируем`);
  });

  socket.on("close", () => {
    clients.delete(socket);
    // Как в прод: fgw удаляет qr-session в igw — старый QR больше невалиден
    qrSessionStore.remove(session.sessionId);
    console.log(
      `[qr-ws-mock] - WS соединение #${connectionId} (qr-session ${session.sessionId} удалён, активно: ${clients.size})`,
    );
  });

  socket.on("error", (err) => {
    console.error(`[qr-ws-mock] #${connectionId}: ошибка сокета:`, err.message);
  });
});

/* ------------------------------ HTTP API ------------------------------ */

/** Статус: сколько соединений открыто, сколько создано всего. */
app.get("/", (_req, res) => {
  res.json({
    service: "qr-ws-mock",
    wsUrl: `ws://<host>:<port>${WS_PATH}`,
    activeConnections: clients.size,
    stats: getStats(),
  });
});

/** Лёгкий healthcheck для кранов/скиппов. */
app.get("/health", (_req, res) => {
  res.json({ ok: true, uptimeMs: Date.now() - startedAt });
});

/**
 * Симуляция "kubectl rollout restart deploy/front-gateway":
 * рвём ВСЕ открытые WS без close-кода (как при гибели пода).
 * QR-сессии удаляются — клиент обязан реконнектиться и получить новый QR.
 */
app.get("/kill", (_req, res) => {
  kills += 1;
  const activeBefore = clients.size;
  for (const socket of clients.keys()) {
    // terminate() = немедленный обрыв, как при гибели процесса
    socket.terminate();
  }
  console.log(`[qr-ws-mock] KILL: оборвано соединений: ${activeBefore}`);
  res.json({ killed: true, activeBefore });
});

/** Отдельно рвёт одно соединение по ws_connection_id (полезно для тестов). */
app.get("/kill/:connectionId", (req, res) => {
  const id = Number(req.params.connectionId);
  let killed = false;
  for (const [socket, state] of clients) {
    if (state.connectionId === id) {
      killed = true;
      socket.terminate();
      break;
    }
  }
  res.json({ killed, connectionId: id });
});

/**
 * Симуляция успешного сканирования QR в мобильном приложении:
 * шлёт AUTH_SUCCESS всем активным WS (или одному, ?connectionId=N).
 * После AUTH_SUCCESS клиент НЕ должен реконнектиться.
 */
app.get("/auth", (req, res) => {
  const targetId = req.query.connectionId ? Number(req.query.connectionId) : null;
  let sentTo = 0;

  for (const [socket, state] of clients) {
    if (targetId !== null && state.connectionId !== targetId) continue;
    send(socket, {
      type: WS_MESSAGE_TYPE.authenticated,
      data: { qr_session_id: state.sessionId },
    });
    sentTo += 1;
  }

  res.json({ sentTo, targetId });
});

/**
 * Симуляция блокировки/паузы сессии (SESSION_EXPIRED / QR_PAUSED):
 * клиент обязан закрыть сессию и НЕ реконнектиться без действия.
 */
app.get("/pause", (req, res) => {
  const targetId = req.query.connectionId ? Number(req.query.connectionId) : null;
  let sentTo = 0;

  for (const [socket, state] of clients) {
    if (targetId !== null && state.connectionId !== targetId) continue;
    send(socket, {
      type: WS_MESSAGE_TYPE.sessionExpired,
      data: { qr_session_id: state.sessionId },
    });
    sentTo += 1;
  }

  res.json({ sentTo, targetId });
});

function getStats(): TStats {
  return {
    totalConnections,
    lastConnectionId,
    totalRemovedSessions: qrSessionStore.removedSessionsCount,
    kills,
    uptimeMs: Date.now() - startedAt,
  };
}

const PORT = Number(process.env.PORT ?? 9735);

server.listen(PORT, () => {
  console.log("==============================================");
  console.log(" qr-ws-mock (мок front-gateway)");
  console.log("==============================================");
  console.log(`  WS:     ws://localhost:${PORT}${WS_PATH}`);
  console.log(`  Статус: http://localhost:${PORT}/`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  KILL:   http://localhost:${PORT}/kill          — рвёт все WS (рестарт пода)`);
  console.log(`  Auth:   http://localhost:${PORT}/auth          — AUTH_SUCCESS (сканирование)`);
  console.log(`  Pause:  http://localhost:${PORT}/pause         — SESSION_EXPIRED`);
  console.log("==============================================");
});

export { app, server, wss, clients };
