import { useRef, useEffect, useState, useCallback } from 'react';
import { ClientMessage, ServerMessage } from '../lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseWebSocketReturn {
  isConnected: boolean;
  isReconnecting: boolean;
  send: (msg: ClientMessage) => void;
  sendBinary: (data: ArrayBuffer) => void;
  disconnect: () => void;
  reconnect: () => void;
  latencyMs: number | null;
}

export interface WebSocketHandlers {
  onMessage: (msg: ServerMessage) => void;
  onBinary: (data: ArrayBuffer) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
const PING_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useWebSocket(
  url: string,
  handlers: WebSocketHandlers,
): UseWebSocketReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);

  // Mutable refs that survive re-renders
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(handlers);
  const urlRef = useRef(url);
  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendQueueRef = useRef<Array<string | ArrayBuffer>>([]);
  const unmountedRef = useRef(false);
  const intentionalCloseRef = useRef(false);

  // Keep handler ref current so callbacks never go stale
  handlersRef.current = handlers;
  urlRef.current = url;

  // ------ internal helpers ------

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const clearPingTimer = useCallback(() => {
    if (pingTimerRef.current !== null) {
      clearInterval(pingTimerRef.current);
      pingTimerRef.current = null;
    }
  }, []);

  const startPing = useCallback(() => {
    clearPingTimer();
    pingTimerRef.current = setInterval(() => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const msg: ClientMessage = { type: 'ping', ts: Date.now() };
        ws.send(JSON.stringify(msg));
      }
    }, PING_INTERVAL_MS);
  }, [clearPingTimer]);

  const flushQueue = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const queue = sendQueueRef.current;
    sendQueueRef.current = [];
    for (const item of queue) {
      ws.send(item);
    }
  }, []);

  // Ref to break circular dependency: scheduleReconnect -> connect -> scheduleReconnect
  const connectRef = useRef<() => void>(() => {});

  const scheduleReconnect = useCallback(() => {
    if (unmountedRef.current) return;
    clearReconnectTimer();
    const delay =
      RECONNECT_DELAYS[Math.min(attemptRef.current, RECONNECT_DELAYS.length - 1)];
    attemptRef.current += 1;
    setIsReconnecting(true);
    reconnectTimerRef.current = setTimeout(() => {
      if (!unmountedRef.current) {
        connectRef.current();
      }
    }, delay);
  }, [clearReconnectTimer]);

  const connect = useCallback(() => {
    // Close any existing socket before opening a new one
    if (wsRef.current) {
      const old = wsRef.current;
      wsRef.current = null;
      old.onopen = null;
      old.onclose = null;
      old.onmessage = null;
      old.onerror = null;
      if (old.readyState === WebSocket.OPEN || old.readyState === WebSocket.CONNECTING) {
        old.close();
      }
    }

    if (unmountedRef.current) return;

    const ws = new WebSocket(urlRef.current);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      if (unmountedRef.current) {
        ws.close();
        return;
      }
      attemptRef.current = 0;
      setIsConnected(true);
      setIsReconnecting(false);
      intentionalCloseRef.current = false;
      flushQueue();
      startPing();
      handlersRef.current.onConnect();
    };

    ws.onclose = () => {
      if (unmountedRef.current) return;
      clearPingTimer();
      setIsConnected(false);

      handlersRef.current.onDisconnect();

      if (!intentionalCloseRef.current) {
        scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // The browser will fire onclose after onerror; nothing extra needed.
    };

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        handlersRef.current.onBinary(event.data);
      } else {
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage;
          // Handle pong internally for latency measurement
          if (msg.type === 'pong') {
            setLatencyMs(Date.now() - msg.ts);
          }
          handlersRef.current.onMessage(msg);
        } catch {
          // Ignore malformed JSON
        }
      }
    };
  }, [flushQueue, startPing, clearPingTimer, scheduleReconnect]);

  // Keep connectRef current for the scheduleReconnect closure
  connectRef.current = connect;

  // ------ public API ------

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    const serialized = JSON.stringify(msg);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(serialized);
    } else {
      sendQueueRef.current.push(serialized);
    }
  }, []);

  const sendBinary = useCallback((data: ArrayBuffer) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    } else {
      sendQueueRef.current.push(data);
    }
  }, []);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    clearReconnectTimer();
    clearPingTimer();
    setIsReconnecting(false);
    const ws = wsRef.current;
    if (ws) {
      ws.close();
    }
  }, [clearReconnectTimer, clearPingTimer]);

  const reconnect = useCallback(() => {
    intentionalCloseRef.current = false;
    attemptRef.current = 0;
    clearReconnectTimer();
    connect();
  }, [clearReconnectTimer, connect]);

  // ------ lifecycle ------

  useEffect(() => {
    unmountedRef.current = false;
    connect();

    return () => {
      unmountedRef.current = true;
      clearReconnectTimer();
      clearPingTimer();
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.close();
        wsRef.current = null;
      }
    };
  }, [connect, clearReconnectTimer, clearPingTimer]);

  return { isConnected, isReconnecting, send, sendBinary, disconnect, reconnect, latencyMs };
}
