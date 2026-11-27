import { describe, expect, it } from "vitest";

import { createSignInMail, type MailMessage } from "./sign-in-mail.ts";

const URL_ = "smtps://signin%40example.test:p%40ss@smtp.example.test:465";

describe("one source asking for codes to many addresses", () => {
  it("cannot use up the codes every other source may ask for, nor mail a whole domain", async () => {
    const sent: MailMessage[] = [];
    let clock = 0;
    const mail = createSignInMail({ url: URL_, now: () => clock, transport: { sendMail: async (message: MailMessage) => { sent.push(message); } } });
    for (let i = 0; i < 1_000; i += 1) {
      await mail.send(`x${i}@example.test`, null, "203.0.113.7");
      clock += 1;
    }
    expect(sent.length).toBeLessThan(100);
    expect(await mail.send("her@example.test", null, "198.51.100.2")).toBe("sent");
  });
});
