// ─────────────────────────────────────────────────────────────────────────
// WHATSAPP ALERTS — Meta WhatsApp Cloud API (official, free)
//
// Honest limitation, not a bug: WhatsApp only allows free-form text messages
// within a 24-HOUR WINDOW that opens when you message the bot's number. Send
// it "hi" once a day (or whenever convenient) to keep alerts flowing. Outside
// that window Meta rejects the send with error code 131047 — this module
// detects that specific case and logs a clear, actionable warning instead of
// failing silently. Telegram is unaffected either way.
// ─────────────────────────────────────────────────────────────────────────

const GRAPH_VERSION = "v21.0";

// Convert the app's Telegram-HTML-ish markup to WhatsApp's markdown.
export function toWhatsAppText(html) {
  return html
    .replace(/<b>(.*?)<\/b>/gs, "*$1*")
    .replace(/<i>(.*?)<\/i>/gs, "_$1_")
    .replace(/<code>(.*?)<\/code>/gs, "`$1`")
    .replace(/<\/?[^>]+>/g, ""); // strip anything else
}

export async function sendWhatsApp(token, phoneNumberId, toNumber, htmlText) {
  const body = toWhatsAppText(htmlText);
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toNumber,
      type: "text",
      text: { preview_url: false, body },
    }),
  });
  const j = await res.json();
  if (!res.ok || j.error) {
    const code = j.error?.code;
    if (code === 131047 || code === 131026) {
      throw new Error("WA_WINDOW_CLOSED: message it 'hi' to re-open the 24h window");
    }
    throw new Error(`WhatsApp send failed: ${j.error?.message || res.status}`);
  }
  return j;
}

export async function verifyWhatsAppConfig(token, phoneNumberId) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}?fields=display_phone_number,verified_name`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(j.error?.message || `HTTP ${res.status}`);
  return j; // { display_phone_number, verified_name }
}
