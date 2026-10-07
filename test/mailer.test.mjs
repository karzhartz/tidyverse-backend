import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { createMailer } from "../src/mailer.mjs";

// A throwaway SMTP server: enough of RFC 5321 to accept one message, so the
// transport is exercised over a real socket rather than a mock. No network, no
// credentials, no external service.

function startSmtpServer() {
  const messages = [];
  const sockets = new Set();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");

    let buffer = "";
    let inData = false;
    let data = [];

    socket.write("220 wimak-test ESMTP\r\n");

    socket.on("data", (chunk) => {
      buffer += chunk;

      let index;
      while ((index = buffer.indexOf("\r\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(data.join("\n"));
            data = [];
            socket.write("250 2.0.0 Ok: queued\r\n");
          } else {
            // Undo dot-stuffing so the captured message is the real one.
            data.push(line.startsWith("..") ? line.slice(1) : line);
          }
          continue;
        }

        const command = line.toUpperCase();
        if (command.startsWith("EHLO") || command.startsWith("HELO")) {
          // No AUTH and no STARTTLS advertised: this server takes plain mail.
          socket.write("250-wimak-test\r\n250-SIZE 10485760\r\n250 HELP\r\n");
        } else if (command.startsWith("MAIL FROM")) {
          socket.write("250 2.1.0 Ok\r\n");
        } else if (command.startsWith("RCPT TO")) {
          socket.write("250 2.1.5 Ok\r\n");
        } else if (command === "DATA") {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (command === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("250 2.0.0 Ok\r\n");
        }
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        messages,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** A port nothing is listening on, so a connection is refused at once. */
async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function smtpConfig(overrides = {}) {
  return {
    transport: "smtp",
    from: "Wimak Total Care <bookings@wimaktotalcare.com>",
    replyTo: "support@wimaktotalcare.com",
    resendApiKey: null,
    logDir: null,
    smtp: {
      host: "127.0.0.1",
      port: 587,
      secure: false,
      requireTLS: false,
      rejectUnauthorized: true,
      connectionTimeoutMs: 5000,
      user: null,
      password: null,
      ...overrides,
    },
  };
}

test("the SMTP transport delivers a message over a real SMTP conversation", async () => {
  const server = await startSmtpServer();

  try {
    const mailer = createMailer(smtpConfig({ port: server.port }), null);
    assert.equal(mailer.transport, "smtp");

    const result = await mailer.send({
      to: "customer@example.com",
      subject: "Booking WTC-ABC123 received",
      text: "Hello from the test.",
      html: "<p>Hello from the test.</p>",
    });

    assert.ok(result.id, "a message id should come back");
    assert.deepEqual(result.accepted, ["customer@example.com"]);
    assert.equal(server.messages.length, 1);

    const raw = server.messages[0];
    assert.match(raw, /Subject: Booking WTC-ABC123 received/i);
    assert.match(raw, /To: customer@example\.com/i);
    assert.match(raw, /bookings@wimaktotalcare\.com/i);
    assert.match(raw, /Reply-To: .*support@wimaktotalcare\.com/i);
  } finally {
    await server.close();
  }
});

test("verify() confirms the connection without sending anything", async () => {
  const server = await startSmtpServer();

  try {
    const mailer = createMailer(smtpConfig({ port: server.port }), null);
    assert.equal(await mailer.verify(), true);
    assert.equal(server.messages.length, 0, "verify must not deliver a message");
  } finally {
    await server.close();
  }
});

test("a refused connection is reported, not swallowed", async () => {
  const port = await closedPort();
  const mailer = createMailer(smtpConfig({ port }), null);

  await assert.rejects(
    () => mailer.send({ to: "x@y.co", subject: "s", text: "t" }),
    (error) => /SMTP delivery to x@y\.co failed/.test(error.message)
  );

  await assert.rejects(() => mailer.verify(), /SMTP verification failed/);
});

test("non-SMTP transports have nothing to verify", async () => {
  const consoleMailer = createMailer(
    { transport: "console", from: "a@b.co", replyTo: null, resendApiKey: null, logDir: null, smtp: null },
    null
  );
  assert.equal(await consoleMailer.verify(), true);
});

test("a message with no recipient is refused before any connection", async () => {
  const mailer = createMailer(smtpConfig({ port: 1 }), null);
  await assert.rejects(() => mailer.send({ subject: "no recipient" }), /needs a recipient/);
});
