/**
 * Протокол сообщений QR-входа (соответствует QrAuthWebSocketHandler в front-gateway).
 */

export const WS_MESSAGE_TYPE = {
  updated: "QR_UPDATED",
  paused: "QR_PAUSED",
  resume: "RESUME_QR",
  authenticated: "AUTH_SUCCESS",
  sessionExpired: "SESSION_EXPIRED",
  authFailed: "AUTH_FAILED",
} as const;

export type WSMessageType = (typeof WS_MESSAGE_TYPE)[keyof typeof WS_MESSAGE_TYPE];

/** Сообщение сервер -> клиент. */
export interface TQRWSResponse {
  type: WSMessageType;
  data: {
    qr_session_id: string;
    ws_connection_id?: number;
  };
}

/** Сообщение клиент -> сервер. */
export interface TQRWSRequest {
  type?: string;
}

/** Запись о QR-сессии (аналог qr-session в igw). */
export interface IQrSession {
  sessionId: string;
  connectionId: number;
  createdAt: number;
  /** true, пока WS-соединение открыто; при закрытии fgw "удаляет" сессию в igw. */
  active: boolean;
  removedAt?: number;
}

/** Состояние одного WS-клиента. */
export interface IWsClientState {
  connectionId: number;
  sessionId: string;
  socket: import("ws").WebSocket;
  paused: boolean;
}

/** Счётчики для /health. */
export interface TStats {
  totalConnections: number;
  lastConnectionId: number;
  totalRemovedSessions: number;
  kills: number;
  uptimeMs: number;
}
