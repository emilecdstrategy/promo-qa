export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
}

export function smtpConfigFromEnv(
  getEnv: (name: string) => string | undefined,
): SmtpConfig | null {
  const host = getEnv("SMTP_HOST");
  const user = getEnv("SMTP_USER");
  const pass = getEnv("SMTP_PASS");
  const from = getEnv("SMTP_FROM");
  const to = getEnv("ALERT_EMAIL_TO");
  if (!host || !user || !pass || !from || !to) return null;

  const port = Number(getEnv("SMTP_PORT") ?? "587");
  return {
    host,
    port,
    secure: (getEnv("SMTP_SECURE") ?? String(port === 465)) === "true",
    user,
    pass,
    from,
    to,
  };
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
