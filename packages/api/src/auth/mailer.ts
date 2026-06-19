import type { MailerConfig } from './config'

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

/**
 * Mail transport abstraction. Domain logic depends only on this interface, so
 * the concrete provider (dev log vs SendGrid) is swappable by configuration.
 * (email-verification spec: §メール送信は Mailer アダプタ越し)
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>
}

/** Development transport: logs the message instead of sending it. */
export class LogMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    console.info('[LogMailer] email (not actually sent):', {
      to: message.to,
      subject: message.subject,
      text: message.text,
    })
  }
}

/** Production transport: SendGrid v3 mail send HTTP API. */
export class SendgridMailer implements Mailer {
  constructor(private readonly apiKey: string, private readonly from: string) {}

  async send(message: MailMessage): Promise<void> {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: this.from },
        subject: message.subject,
        content: [
          { type: 'text/plain', value: message.text },
          ...(message.html ? [{ type: 'text/html', value: message.html }] : []),
        ],
      }),
    })
    if (!res.ok) {
      throw new Error(`SendGrid send failed: ${res.status} ${await res.text()}`)
    }
  }
}

/** Build the configured mailer. */
export function createMailer(config: MailerConfig): Mailer {
  if (config.driver === 'sendgrid') {
    if (!config.sendgridApiKey) {
      throw new Error('SENDGRID_API_KEY is required when MAILER_DRIVER=sendgrid')
    }
    return new SendgridMailer(config.sendgridApiKey, config.from)
  }
  return new LogMailer()
}
