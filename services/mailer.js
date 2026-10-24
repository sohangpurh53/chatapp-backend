const nodemailer = require('nodemailer');

/**
 * Sends transactional email over plain SMTP, so any provider works (Resend,
 * SendGrid, SES, Gmail...): set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and
 * MAIL_FROM. Without SMTP_HOST, development prints the message to the console
 * and production refuses to pretend an email was sent.
 */
let transporter = null;

const isConfigured = () => !!process.env.SMTP_HOST;

const getTransporter = () => {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
};

const sendMail = async ({ to, subject, text }) => {
  if (!isConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Email is not configured (set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM)');
    }
    console.log(`📧 [dev, SMTP not configured] To: ${to}\nSubject: ${subject}\n${text}`);
    return { delivered: false };
  }
  await getTransporter().sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
  });
  return { delivered: true };
};

module.exports = { sendMail, isConfigured };
