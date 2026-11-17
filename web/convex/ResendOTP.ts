import { Email } from "@convex-dev/auth/providers/Email";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";

function generateOTP(length: number): string {
  const digits = "0123456789";
  const array = new Uint32Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (num) => digits[num % digits.length]).join("");
}

export const ResendOTP = Email({
  id: "resend-otp",
  maxAge: 60 * 15,
  async generateVerificationToken() {
    return generateOTP(6);
  },
  async sendVerificationRequest(
    { identifier: email, token },
    ctx?: ActionCtx,
  ): Promise<void> {
    // Invite-only: never send a code to an email that has no invite.
    if (ctx) {
      const invited: boolean = await ctx.runQuery(internal.invites.isInvited, { email });
      if (!invited) throw new Error("NOT_INVITED");
    }
    const appName = "pingme";
    const localizedCopy = {
      language: "en",
      customMessage: `Your pingme sign-in code: ${token}`,
      emailCopy: {
        subject: `${token} is your pingme code`,
        preview: "Sign in to pingme",
        heading: "Your sign-in code",
        security: "Never share this code.",
        footer: "If you did not ask for this code, you can ignore this email.",
      },
    };
    const response = await fetch(`${process.env.OTP_ENDPOINT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        token,
        chatId: process.env.CHAT_ID,
        appName,
        secretKey: process.env.SECRET_KEY,
        ...localizedCopy,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || "Failed to send verification email");
    }
  },
});

/** Sends a plain email (the invitation) through the Macaly notification endpoint. */
export async function sendEmail(input: { toEmail: string; subject: string; message: string }) {
  return await fetch(`${process.env.EMAIL_NOTIFICATION_ENDPOINT}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...input,
      chatId: process.env.CHAT_ID,
      appName: "pingme",
      secretKey: process.env.SECRET_KEY,
    }),
  });
}
