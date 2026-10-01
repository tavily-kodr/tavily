/**
 * Event Bus for Real-Time Event Dispatching (WebSocket & Server-Sent Events)
 */

type EventHandler<T = any> = (data: T) => void;

class EventBusService {
  private handlers = new Map<string, Set<EventHandler>>();

  subscribe<T = any>(event: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    const set = this.handlers.get(event)!;
    set.add(handler);

    // Return unsubscribe function
    return () => {
      set.delete(handler);
      if (set.size === 0) {
        this.handlers.delete(event);
      }
    };
  }

  emit<T = any>(event: string, data: T): void {
    const set = this.handlers.get(event);
    if (set) {
      for (const handler of set) {
        try {
          handler(data);
        } catch {
          // Prevent handler errors from breaking emission
        }
      }
    }
  }
}

export const eventBus = new EventBusService();
