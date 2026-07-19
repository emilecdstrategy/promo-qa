export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

const DEFAULT_SMTP: SmtpConfig = {
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  user: "hello@ecdigitalstrategy.com",
  pass: "vccvhweqtonihdj",
  from: "ECD Digital Strategy <hello@ecdigitalstrategy.com>",
  to: "hello@ecdigitalstrategy.com",
};

export function getSmtpConfig(
  getEnv: (name: string) => string | undefined = () => undefined,
): SmtpConfig {
  const port = Number(getEnv("SMTP_PORT") ?? String(DEFAULT_SMTP.port));
  return {
    host: getEnv("SMTP_HOST") ?? DEFAULT_SMTP.host,
    port,
    secure: (getEnv("SMTP_SECURE") ?? String(DEFAULT_SMTP.secure)) === "true",
    user: getEnv("SMTP_USER") ?? DEFAULT_SMTP.user,
    pass: getEnv("SMTP_PASS") ?? DEFAULT_SMTP.pass,
    from: getEnv("SMTP_FROM") ?? DEFAULT_SMTP.from,
    to: getEnv("ALERT_EMAIL_TO") ?? DEFAULT_SMTP.to,
  };
}

/** @deprecated Use getSmtpConfig instead. */
export function smtpConfigFromEnv(
  getEnv: (name: string) => string | undefined,
): SmtpConfig | null {
  return getSmtpConfig(getEnv);
}

export async function sendAlertEmail(
  config: SmtpConfig,
  subject: string,
  text: string,
): Promise<void> {
  const nodemailer = await import("npm:nodemailer@6.9.16");
  const transporter = nodemailer.default.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });

  await transporter.sendMail({
    from: config.from,
    to: config.to,
    subject,
    text,
  });
}
