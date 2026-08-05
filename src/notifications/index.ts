/**
 * Notification Port — swappable notification interface.
 * Slack is the default adapter; others can be added without touching tool handlers.
 */

export interface NotificationResult {
  sent: boolean;
  error?: string;
}

export interface NotificationPort {
  send(message: string): Promise<NotificationResult>;
}

/**
 * Slack Incoming Webhook adapter.
 * Requires SLACK_WEBHOOK_URL env var. If not set, send() returns { sent: false }.
 */
export class SlackNotificationAdapter implements NotificationPort {
  private webhookUrl: string | undefined;

  constructor(webhookUrl?: string) {
    this.webhookUrl = webhookUrl || process.env.SLACK_WEBHOOK_URL;
  }

  async send(message: string): Promise<NotificationResult> {
    if (!this.webhookUrl) {
      return { sent: false, error: 'SLACK_WEBHOOK_URL not configured' };
    }

    try {
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });

      if (res.ok) {
        return { sent: true };
      }
      return { sent: false, error: `Slack returned ${res.status}` };
    } catch (e: any) {
      return { sent: false, error: e.message || 'Unknown fetch error' };
    }
  }
}

/**
 * No-op adapter for testing or when notifications are disabled.
 */
export class NoopNotificationAdapter implements NotificationPort {
  async send(_message: string): Promise<NotificationResult> {
    return { sent: false, error: 'Notifications disabled' };
  }
}
