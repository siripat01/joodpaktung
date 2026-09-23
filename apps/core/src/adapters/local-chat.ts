import type { ChatNotification, NotificationProviderPort, NotificationResult } from '../ports/notification-provider.js';

export class LocalChatNotificationProvider implements NotificationProviderPort {
  private readonly results = new Map<string, NotificationResult>();
  private readonly delivered = new Map<string, ChatNotification>();

  constructor(private readonly options: { readonly failBeforeAcknowledgement?: boolean } = {}) {}

  async send(input: ChatNotification): Promise<NotificationResult> {
    const existing = this.results.get(input.notificationId);
    if (existing) return existing;
    if (this.options.failBeforeAcknowledgement) {
      return { outcome: 'retryable_failure', notificationId: input.notificationId };
    }
    const result: NotificationResult = { outcome: 'success', notificationId: input.notificationId };
    this.delivered.set(input.notificationId, input);
    this.results.set(input.notificationId, result);
    return result;
  }

  deliveries(): readonly ChatNotification[] {
    return [...this.delivered.values()];
  }
}
