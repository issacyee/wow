/**
 * Notification provider contracts.
 *
 * Lifecycle policy lives in the notifications extension; providers only deliver
 * a normalized notification through one concrete channel.
 */

export interface Notification {
  title: string;
  /** Ordered detail lines. Providers may join them when their platform has only one body field. */
  lines: string[];
}

export interface NotificationResult {
  ok: boolean;
  available: boolean;
  backend: string;
  /** Optional provider-specific diagnostics, shown only by explicit test commands. */
  diagnostics?: string[];
  error?: string;
}

export interface NotificationProvider {
  readonly id: string;
  send(notification: Notification): Promise<NotificationResult>;
}
