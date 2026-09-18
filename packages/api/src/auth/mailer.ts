import { createTransport, type SendMailOptions, type SMTPSentMessageInfo, type Transporter } from 'nodemailer'
import type { MailerConfig, SmtpConfig } from './config'

export interface MailMessage {
  to: string
  subject: string
  text: string
  html?: string
}

/**
 * Mail transport abstraction. Domain logic depends only on this interface, so
 * the concrete transport (dev log vs SMTP) is swappable by configuration.
 * (email-verification spec: §メール送信は Mailer アダプタ越し)
 *
 * The transports below are nodemailer's; what this interface adds is the narrow
 * message shape the domain uses and a `send` that either resolves because the
 * message was taken, or rejects.
 */
export interface Mailer {
  send(message: MailMessage): Promise<void>
}

/** One MailMessage as nodemailer's message object, with the configured sender. */
function sendMailOptions(from: string, message: MailMessage): SendMailOptions {
  return {
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    // Left out rather than passed as undefined: nodemailer documents the message
    // fields as optional, but not what an explicit `undefined` means.
    ...(message.html === undefined ? {} : { html: message.html }),
  }
}

/**
 * Development transport. The console line is this transport's delivery, not a
 * debug statement: the deployment runs this driver and a traQ bot reads the link
 * out of the log (DEPLOY-NEOSHOWCASE.md), so the prefix and the three fields are
 * an interface that bot depends on. The line is printed before the message is
 * handed to nodemailer, so it reaches the bot even for a message nodemailer
 * refuses; the refusal then reaches the caller as a rejected promise.
 *
 * Nothing is transmitted: the message goes to nodemailer's JSON transport, which
 * generates the message and hands it back instead of delivering it (nodemailer
 * docs, Transports / JSON transport). The same docs describe it as the transport
 * for structured message data and say message-stream transforms are not
 * reflected in its output, so it covers nodemailer's handling of the message
 * data, not the RFC 822 compile the SMTP transport performs.
 */
export class LogMailer implements Mailer {
  private readonly transporter = createTransport({ jsonTransport: true })

  constructor(private readonly from: string) {}

  async send(message: MailMessage): Promise<void> {
    // eslint-disable-next-line no-console -- printing the message IS this transport's delivery, not a leftover debug statement
    console.info('[LogMailer] email (not actually sent):', {
      to: message.to,
      subject: message.subject,
      text: message.text,
    })
    await this.transporter.sendMail(sendMailOptions(this.from, message))
  }
}

/**
 * Production transport: SMTP. Nodemailer owns the connection, so the provider is
 * whichever relay `SmtpConfig` points at, and a change of provider is a change
 * of configuration rather than of code.
 */
export class SmtpMailer implements Mailer {
  private readonly transporter: Transporter<SMTPSentMessageInfo>

  constructor(smtp: SmtpConfig, private readonly from: string) {
    this.transporter = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.pass },
    })
  }

  async send(message: MailMessage): Promise<void> {
    const info = await this.transporter.sendMail(sendMailOptions(this.from, message))
    // The info object lists the recipients the server refused in `rejected`
    // (nodemailer docs, the info object of sendMail). A refused recipient never
    // got the message, which is a failure for the caller, so it is raised here
    // rather than left to be read off a send that resolved.
    //
    // KNOWN GAP — this branch is currently unreachable. Nodemailer's error
    // reference (https://nodemailer.com/errors) puts the resolve-with-`rejected`
    // shape under "Handling partial failures", "when some recipients are
    // rejected but others accepted", and says of EENVELOPE that `rejected` and
    // `rejectedErrors` "are only attached when every recipient was rejected", so
    // a message whose only recipient is refused rejects instead of resolving.
    // Confirmed against the installed nodemailer 10.0.10: `_actionRCPT` in
    // `dist/esm/smtp-connection/index.js` goes on to DATA (the path that
    // resolves and carries `rejected`) only while
    // `envelope.rejected.length < envelope.to.length`, and otherwise calls back
    // with "Can't send mail - all recipients were rejected". `sendMailOptions`
    // above builds a single `to` and no cc/bcc, and the one caller —
    // `requestEmailVerification` in `./router`, whose input is validated as
    // `z.email()` by the contract in `@checkin/api-contract` — passes one
    // address, so a refusal there always reaches this caller as a rejection from
    // the await above. The check is kept because it becomes the failure path as
    // soon as a message carries a second recipient.
    if (info.rejected.length > 0) {
      throw new Error(`SMTP send failed: the server rejected ${info.rejected.join(', ')}`)
    }
  }
}

/** Build the configured mailer. */
export function createMailer(config: MailerConfig): Mailer {
  switch (config.driver) {
    case 'smtp': {
      const smtp = config.smtp
      if (smtp === undefined || smtp.host === '' || smtp.user === '' || smtp.pass === '') {
        throw new Error('SMTP_HOST, SMTP_USER and SMTP_PASSWORD are required when MAILER_DRIVER=smtp')
      }
      return new SmtpMailer(smtp, config.from)
    }
    case 'log':
      return new LogMailer(config.from)
  }
}
