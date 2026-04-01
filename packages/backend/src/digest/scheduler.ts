import type { Database } from '../db/database.js';
import type { AppConfig } from '../config.js';
import { generateDigest, formatDigestAsMarkdown, formatDigestAsHtml } from './generator.js';

export class DigestScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    private db: Database,
    private config: AppConfig,
  ) {}

  start() {
    // Check every hour if it's time to send a digest
    this.intervalId = setInterval(() => this.checkAndSend(), 3600_000);
    // Also check on startup (for missed digests)
    setTimeout(() => this.checkAndSend(), 5000);
    console.log('[digest] Scheduler started');
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async checkAndSend() {
    const settings = this.db.getSettingsRepo().getAll();
    const digestConfig = (settings as any).digest;
    if (!digestConfig?.enabled) return;

    // Check if we already sent a digest this week
    const lastDigest = this.db.getRawDb().prepare(
      "SELECT * FROM digest_history WHERE delivery_status = 'delivered' ORDER BY generated_at DESC LIMIT 1"
    ).get() as any;

    if (lastDigest) {
      const lastSent = new Date(lastDigest.generated_at);
      const daysSince = (Date.now() - lastSent.getTime()) / 86400000;
      if (daysSince < 6) return; // Don't send more than once a week
    }

    // Check if it's the right day and time
    const now = new Date();
    const schedule = digestConfig.schedule ?? '0 8 * * 1'; // default Monday 8am
    // Simple check: is it Monday and after 8am?
    // For a proper implementation, use node-cron. For now, simple day check.
    const targetDay = 1; // Monday
    if (now.getDay() !== targetDay) return;
    if (now.getHours() < 8) return;

    await this.sendDigest(digestConfig);
  }

  async sendDigest(digestConfig?: any) {
    try {
      const digest = await generateDigest(this.db, this.config);
      const appUrl = `http://localhost:${this.config.port}`;

      const delivery = digestConfig?.delivery ?? 'app';

      if (delivery === 'slack' && digestConfig?.slackWebhookUrl) {
        await this.sendSlack(digestConfig.slackWebhookUrl, digest, appUrl);
      }

      // Mark as delivered
      this.db.getRawDb().prepare(
        "UPDATE digest_history SET delivery_status = 'delivered', delivered_at = datetime('now') WHERE id = ?"
      ).run(digest.id);

      console.log(`[digest] Sent digest ${digest.id} (${digest.entries.length} repos)`);
    } catch (err: any) {
      console.error('[digest] Failed:', err.message);
    }
  }

  private async sendSlack(webhookUrl: string, digest: any, appUrl: string) {
    const blocks: any[] = [
      { type: 'header', text: { type: 'plain_text', text: 'Weekly Code Review Digest' } },
      { type: 'section', text: { type: 'mrkdwn', text: digest.overallSummary } },
      { type: 'divider' },
    ];

    for (const entry of digest.entries) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${entry.repoName}*\n${entry.summary}${entry.topChanges.length > 0 ? '\n' + entry.topChanges.map((c: string) => `• ${c}`).join('\n') : ''}`,
        },
        accessory: entry.commitCount > 0 ? {
          type: 'button',
          text: { type: 'plain_text', text: 'Review' },
          url: `${appUrl}?repo=${encodeURIComponent(entry.repoPath)}&mode=updates`,
        } : undefined,
      });
    }

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });
  }
}
