/**
 * Accountant notification abstraction. Like {@link Mailer}, the domain depends
 * only on this interface so the concrete channel (dev log now, traQ/email later)
 * is swappable by configuration. (payment-webhook spec: §入金時に会計へ通知,
 * design.md D7)
 */
export interface Notifier {
  notify(message: string): Promise<void>
}

/** Development notifier: logs the accountant message instead of delivering it. */
export class LogNotifier implements Notifier {
  async notify(message: string): Promise<void> {
    console.info('[LogNotifier] accountant notification (not actually delivered):', message)
  }
}

/** Build the configured notifier. Only the log driver exists for now. */
export function createNotifier(): Notifier {
  return new LogNotifier()
}
