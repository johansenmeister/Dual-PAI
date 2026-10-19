#!/usr/bin/env bun
/**
 * SendMail — one mail over SMTP, set up from `.env` (#463).
 *
 * The SMTP server is configuration, not code: one site sends through Gmail with
 * an app password, another through a relay on port 25 without login.
 *
 *   SMTP_HOST, SMTP_PORT   the server; port 465 is TLS, any other port requires
 *                          STARTTLS (default 587). Mail is never sent in clear text.
 *   SMTP_USER, SMTP_PASSWORD  optional: without SMTP_USER there is no login.
 *   SMTP_FROM              the sender (defaults to SMTP_USER).
 *   REPORT_RECIPIENT       the recipient (defaults to the sender).
 *
 * Without SMTP_HOST, GMAIL_USER and GMAIL_APP_PASSWORD still work as before.
 *
 * Usage:
 *   echo "body" | bun PAI/Tools/SendMail.ts --subject "Subject"
 *   bun PAI/Tools/SendMail.ts --subject "Subject" --file body.txt
 *
 * Exit 0: sent. Exit 2: no mail set up (the reason on stderr). Exit 1: failed.
 *
 * @module PAI/Tools/SendMail
 */

import { readFileSync } from "node:fs";
import * as nodemailer from "nodemailer";
import { getDAName } from "../../pai-core/lib/identity";
import { loadPaiEnv } from "./pai-env";

loadPaiEnv();

export interface MailSetup {
	transport: {
		host: string;
		port: number;
		secure: boolean;
		requireTLS: boolean;
		auth?: { user: string; pass: string };
	};
	from: string;
	to: string;
}

const GMAIL_HOST = "smtp.gmail.com";

/** The mail setup the environment describes, or what is missing. */
export function mailSetup(env: NodeJS.ProcessEnv = process.env): MailSetup | { missing: string } {
	const get = (k: string) => env[k]?.trim() || undefined;
	const recipient = get("REPORT_RECIPIENT");

	const host = get("SMTP_HOST");
	if (host) {
		const port = Number(get("SMTP_PORT") ?? 587);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return { missing: `SMTP_PORT is not a port: ${env.SMTP_PORT}` };
		const user = get("SMTP_USER");
		const pass = get("SMTP_PASSWORD");
		if (user && !pass) return { missing: "SMTP_PASSWORD (SMTP_USER is set)" };
		const from = get("SMTP_FROM") ?? user;
		if (!from) return { missing: "SMTP_FROM (or SMTP_USER)" };
		return {
			transport: { host, port, secure: port === 465, requireTLS: port !== 465, ...(user && pass ? { auth: { user, pass } } : {}) },
			from,
			to: recipient ?? from,
		};
	}

	const gmailUser = get("GMAIL_USER");
	const gmailPass = get("GMAIL_APP_PASSWORD");
	if (gmailUser && gmailPass) {
		return {
			transport: { host: GMAIL_HOST, port: 587, secure: false, requireTLS: true, auth: { user: gmailUser, pass: gmailPass } },
			from: gmailUser,
			to: recipient ?? gmailUser,
		};
	}
	return { missing: "SMTP_HOST, or GMAIL_USER and GMAIL_APP_PASSWORD" };
}

/** Sends one mail; returns the message id. The sender shows as the DA's name. */
export async function sendMail(
	setup: MailSetup,
	mail: { subject: string; text?: string; html?: string },
): Promise<string> {
	const transporter = nodemailer.createTransport(setup.transport);
	const info = await transporter.sendMail({
		from: `"${getDAName()}" <${setup.from}>`,
		to: setup.to,
		subject: mail.subject,
		text: mail.text,
		html: mail.html,
	});
	return info.messageId;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const value = (flag: string) => {
		const i = args.indexOf(flag);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const subject = value("--subject");
	if (!subject) {
		console.error('Usage: bun SendMail.ts --subject "Subject" [--file body.txt]  (body from stdin without --file)');
		process.exit(1);
	}
	const file = value("--file");
	const text = file ? readFileSync(file, "utf8") : await Bun.stdin.text();

	const setup = mailSetup();
	if ("missing" in setup) {
		console.error(`No mail set up: missing ${setup.missing}`);
		process.exit(2);
	}
	try {
		console.log(`Sent to ${setup.to}: ${await sendMail(setup, { subject, text })}`);
	} catch (e) {
		console.error("Could not send:", e instanceof Error ? e.message : e);
		process.exit(1);
	}
}
