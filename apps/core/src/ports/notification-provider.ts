export type ChatNotification = {
  readonly traceId: string;
  readonly orderId: string;
  readonly notificationId: string;
  readonly recipient: 'buyer' | 'seller';
  readonly message: string;
};

export type NotificationResult = {
  readonly outcome: 'success' | 'retryable_failure' | 'permanent_rejection' | 'timeout';
  readonly notificationId: string;
};

export interface NotificationProviderPort {
  send(input: ChatNotification): Promise<NotificationResult>;
}
