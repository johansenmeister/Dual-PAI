/**
 * Contract test: the SMTP server is configuration, not code (#463).
 *
 * MineReflections had smtp.gmail.com written into the code, so no mail went out
 * where the outgoing server is something else, such as a relay on port 25 with
 * STARTTLS and no login. SendMail.ts reads the setup from the environment, with
 * Gmail as the fallback.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mailSetup, sendMail } from "../.opencode/PAI/Tools/SendMail";

describe("mailSetup: SMTP_HOST, then Gmail", () => {
	test("a relay on port 25 without login: STARTTLS required, no auth", () => {
		const s = mailSetup({ SMTP_HOST: "relay.example.com", SMTP_PORT: "25", SMTP_FROM: "pai@example.com", REPORT_RECIPIENT: "ops@example.com" });
		expect(s).toEqual({
			transport: { host: "relay.example.com", port: 25, secure: false, requireTLS: true },
			from: "pai@example.com",
			to: "ops@example.com",
		});
	});

	test("port 465 is TLS from the start, and SMTP_USER logs in", () => {
		const s = mailSetup({ SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", SMTP_USER: "u@example.com", SMTP_PASSWORD: "p" });
		expect(s).toEqual({
			transport: { host: "smtp.example.com", port: 465, secure: true, requireTLS: false, auth: { user: "u@example.com", pass: "p" } },
			from: "u@example.com",
			to: "u@example.com",
		});
	});

	test("without SMTP_PORT the port is 587 with STARTTLS", () => {
		const s = mailSetup({ SMTP_HOST: "smtp.example.com", SMTP_FROM: "pai@example.com" });
		expect("transport" in s && s.transport).toMatchObject({ port: 587, secure: false, requireTLS: true });
	});

	test("SMTP_HOST wins over Gmail", () => {
		const s = mailSetup({ SMTP_HOST: "relay.example.com", SMTP_FROM: "pai@example.com", GMAIL_USER: "g@example.com", GMAIL_APP_PASSWORD: "x" });
		expect("transport" in s && s.transport.host).toBe("relay.example.com");
	});

	test("without SMTP_HOST, Gmail works as before", () => {
		const s = mailSetup({ GMAIL_USER: "g@example.com", GMAIL_APP_PASSWORD: "x", REPORT_RECIPIENT: "r@example.com" });
		expect(s).toEqual({
			transport: { host: "smtp.gmail.com", port: 587, secure: false, requireTLS: true, auth: { user: "g@example.com", pass: "x" } },
			from: "g@example.com",
			to: "r@example.com",
		});
	});

	test("what is missing is named, and nothing is guessed", () => {
		expect(mailSetup({})).toEqual({ missing: "SMTP_HOST, or GMAIL_USER and GMAIL_APP_PASSWORD" });
		expect(mailSetup({ SMTP_HOST: "relay.example.com" })).toEqual({ missing: "SMTP_FROM (or SMTP_USER)" });
		expect(mailSetup({ SMTP_HOST: "relay.example.com", SMTP_USER: "u" })).toEqual({ missing: "SMTP_PASSWORD (SMTP_USER is set)" });
		expect(mailSetup({ SMTP_HOST: "relay.example.com", SMTP_PORT: "smtp", SMTP_FROM: "a@example.com" })).toEqual({
			missing: "SMTP_PORT is not a port: smtp",
		});
		expect(mailSetup({ GMAIL_USER: "g@example.com" })).toHaveProperty("missing");
	});
});

describe("sendMail never sends in clear text", () => {
	// A server that answers like SMTP but does not offer STARTTLS. With
	// requireTLS the client must give up before MAIL FROM.
	const seen: string[] = [];
	const server: Server = createServer((socket) => {
		socket.write("220 fake ESMTP\r\n");
		socket.on("data", (d) => {
			for (const line of d.toString().split("\r\n").filter(Boolean)) {
				seen.push(line.split(" ")[0].toUpperCase());
				if (/^(EHLO|HELO)/i.test(line)) socket.write("250-fake\r\n250 OK\r\n");
				else if (/^QUIT/i.test(line)) socket.end("221 bye\r\n");
				else socket.write("250 OK\r\n");
			}
		});
	});
	const listening = new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
	afterAll(() => server.close());

	test("a server without STARTTLS is refused, and no mail is handed over", async () => {
		const port = await listening;
		const setup = mailSetup({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(port), SMTP_FROM: "pai@example.com" });
		if ("missing" in setup) throw new Error(setup.missing);
		await expect(sendMail(setup, { subject: "s", text: "t" })).rejects.toThrow();
		expect(seen).toContain("EHLO");
		expect(seen).not.toContain("MAIL");
		expect(seen).not.toContain("DATA");
	});
});
