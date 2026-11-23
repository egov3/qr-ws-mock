import { randomUUID } from "node:crypto";

import type { IQrSession, TQRWSResponse } from "./types";
import { WS_MESSAGE_TYPE } from "./types";

/**
 * Хранилище QR-сессий — минимальный аналог qr-sessions в igw.
 *
 * Как в прод-потоке: сессия существует, пока жив WS-соединение.
 * При закрытии соединения fgw удаляет qr-session, и сканирование
 * старого QR-кода больше ничего не даёт (невалидная сессия).
 */
class QrSessionStore {
  private sessions = new Map<string, IQrSession>();
  private removedCount = 0;

  create(connectionId: number): IQrSession {
    const session: IQrSession = {
      sessionId: `qr-sess-${randomUUID()}`,
      connectionId,
      createdAt: Date.now(),
      active: true,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  /**
   * Удаляет сессию (аналог "fgw при закрытии WS удаляет qr-session в igw").
   * Старый QR-код становится невалидным — клиенту нужен новый QR_UPDATED.
   */
  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.active = false;
    session.removedAt = Date.now();
    this.sessions.delete(sessionId);
    this.removedCount += 1;
  }

  isActive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.active ?? false;
  }

  get removedSessionsCount(): number {
    return this.removedCount;
  }

  /**
   * Собирает QR_UPDATED для клиента: новое соединение = новая сессия.
   * Точно так же QrAuthWebSocketHandler шлёт QR_UPDATED после открытия WS.
   */
  buildQrUpdated(session: IQrSession): TQRWSResponse {
    return {
      type: WS_MESSAGE_TYPE.updated,
      data: {
        qr_session_id: session.sessionId,
        ws_connection_id: session.connectionId,
      },
    };
  }
}

export const qrSessionStore = new QrSessionStore();
