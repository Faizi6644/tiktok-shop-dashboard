import { config } from './config.js';
import { log } from './log.js';

/**
 * Alerts always go to the log at error level. If ALERT_WEBHOOK_URL is set (Slack, Teams,
 * PagerDuty...), they are POSTed there too, so we hear about a problem before the client does.
 */
export async function alert(title, details = {}) {
  log.error(`ALERT: ${title}`, details);
  if (!config.alertWebhookUrl) return;
  try {
    await fetch(config.alertWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${title}\n${JSON.stringify(details)}` }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    log.warn('alert webhook failed', { error: e.message });
  }
}
