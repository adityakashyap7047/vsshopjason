/*
  Secure notification server example.
  Do NOT put bot tokens in frontend code.
*/

import express from "express";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const ORDER_TELEGRAM_BOT_TOKEN = process.env.ORDER_TELEGRAM_BOT_TOKEN || "";
const ORDER_TELEGRAM_CHAT_ID = process.env.ORDER_TELEGRAM_CHAT_ID || "";
const TICKET_TELEGRAM_BOT_TOKEN = process.env.TICKET_TELEGRAM_BOT_TOKEN || "";
const TICKET_TELEGRAM_CHAT_ID = process.env.TICKET_TELEGRAM_CHAT_ID || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const FULFILLMENT_DISCORD_CHANNEL = process.env.FULFILLMENT_DISCORD_CHANNEL || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const TELEGRAM_ADMIN_CHAT_IDS = (process.env.TELEGRAM_ADMIN_CHAT_IDS || ORDER_TELEGRAM_CHAT_ID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PORT = process.env.PORT || 3000;
const db = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  : null;

const ALLOWED_STATUSES = new Set(["pending", "order_started", "order_completed", "discord_sent"]);

async function sendTelegram(botToken, chatId, text) {
  if (!botToken || !chatId) return;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

async function sendDiscord(text) {
  if (!DISCORD_WEBHOOK_URL) return;
  await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text })
  });
}

function isAdminChat(chatId) {
  return TELEGRAM_ADMIN_CHAT_IDS.includes(String(chatId || ""));
}

function helpText() {
  return [
    "Admin commands:",
    "/help",
    "/order <ORDER_ID>",
    "/status <ORDER_ID> <pending|order_started|order_completed|discord_sent>"
  ].join("\n");
}

async function handleTelegramCommand(update) {
  const msg = update && update.message ? update.message : null;
  if (!msg || !msg.text) return;
  const chatId = msg.chat && msg.chat.id ? String(msg.chat.id) : "";
  if (!isAdminChat(chatId)) return;

  const text = msg.text.trim();
  const parts = text.split(/\s+/);
  const cmd = (parts[0] || "").toLowerCase();

  if (cmd === "/help" || cmd === "/start") {
    await sendTelegram(ORDER_TELEGRAM_BOT_TOKEN, chatId, helpText());
    return;
  }

  if (!db) {
    await sendTelegram(ORDER_TELEGRAM_BOT_TOKEN, chatId, "Supabase backend config missing.");
    return;
  }

  if (cmd === "/order") {
    const orderId = parts[1];
    if (!orderId) {
      await sendTelegram(ORDER_TELEGRAM_BOT_TOKEN, chatId, "Usage: /order <ORDER_ID>");
      return;
    }
    const { data, error } = await db
      .from("customer_orders")
      .select("*")
      .eq("order_id", orderId)
      .single();
    if (error || !data) {
      await sendTelegram(ORDER_TELEGRAM_BOT_TOKEN, chatId, `Order not found: ${orderId}`);
      return;
    }
    const summary = [
      "ORDER DETAILS",
      `Order: ${data.order_id || "-"}`,
      `Customer: ${data.customer_name || data.customer_email || "-"}`,
      `Item: ${data.item_name || "-"}`,
      `Price: Rs ${data.price || 0}`,
      `Status: ${data.order_status || "pending"}`,
      `Target: ${data.target_link || "-"}`,
      `UTR: ${data.payment_utr || "-"}`
    ].join("\n");
    await sendTelegram(ORDER_TELEGRAM_BOT_TOKEN, chatId, summary);
    return;
  }

  if (cmd === "/status") {
    const orderId = parts[1];
    const nextStatus = parts[2];
    if (!orderId || !nextStatus) {
      await sendTelegram(ORDER_TELEGRAM_BOT_TOKEN, chatId, "Usage: /status <ORDER_ID> <status>");
      return;
    }
    if (!ALLOWED_STATUSES.has(nextStatus)) {
      await sendTelegram(
        ORDER_TELEGRAM_BOT_TOKEN,
        chatId,
        "Invalid status. Use: pending, order_started, order_completed, discord_sent"
      );
      return;
    }
    const { data, error } = await db
      .from("customer_orders")
      .update({ order_status: nextStatus, updated_at: new Date().toISOString() })
      .eq("order_id", orderId)
      .select("*")
      .single();
    if (error || !data) {
      await sendTelegram(ORDER_TELEGRAM_BOT_TOKEN, chatId, `Update failed for ${orderId}`);
      return;
    }
    await sendTelegram(
      ORDER_TELEGRAM_BOT_TOKEN,
      chatId,
      `Updated ${orderId} -> ${nextStatus}`
    );
    return;
  }

  await sendTelegram(ORDER_TELEGRAM_BOT_TOKEN, chatId, "Unknown command.\n" + helpText());
}

app.post("/api/order-alert", async (req, res) => {
  const order = req.body && req.body.order ? req.body.order : null;
  if (!order || !order.order_id) return res.status(400).json({ ok: false });

  const msg = [
    "NEW ORDER",
    `Order: ${order.order_id}`,
    `Customer: ${order.customer_name || order.customer_email || "-"}`,
    `Handle: ${order.social_username || "-"}`,
    `Item: ${order.item_name || "-"}`,
    `Price: Rs ${order.price || 0}`,
    `UTR: ${order.payment_utr || "-"}`,
    `Target: ${order.target_link || "-"}`
  ].join("\n");

  await Promise.all([
    sendTelegram(ORDER_TELEGRAM_BOT_TOKEN, ORDER_TELEGRAM_CHAT_ID, msg),
    sendDiscord(msg)
  ]);
  return res.json({ ok: true });
});

app.post("/api/ticket-alert", async (req, res) => {
  const ticket = req.body && req.body.ticket ? req.body.ticket : null;
  if (!ticket || !ticket.ticket_id) return res.status(400).json({ ok: false });

  const msg = [
    "NEW SUPPORT TICKET",
    `Ticket: ${ticket.ticket_id}`,
    `Customer: ${ticket.customer_name || ticket.customer_email || "-"}`,
    `Subject: ${ticket.subject || "-"}`,
    `Message: ${ticket.message || "-"}`
  ].join("\n");

  await Promise.all([
    sendTelegram(TICKET_TELEGRAM_BOT_TOKEN, TICKET_TELEGRAM_CHAT_ID, msg),
    sendDiscord(msg)
  ]);
  return res.json({ ok: true });
});

app.post("/api/fulfillment-push", async (req, res) => {
  const order = req.body && req.body.order ? req.body.order : null;
  const status = req.body && req.body.status ? req.body.status : "unknown";
  if (!order || !order.order_id) return res.status(400).json({ ok: false });

  const msg = [
    "FULFILLMENT UPDATE",
    `Order: ${order.order_id}`,
    `Status: ${status}`,
    `Item: ${order.item_name || "-"}`,
    `Target: ${order.target_link || "-"}`,
    `UTR: ${order.payment_utr || "-"}`
  ].join("\n");

  await Promise.all([
    sendTelegram(ORDER_TELEGRAM_BOT_TOKEN, ORDER_TELEGRAM_CHAT_ID, msg),
    sendDiscord(msg)
  ]);
  return res.json({ ok: true });
});

app.post("/api/telegram-bot-webhook", async (req, res) => {
  try {
    await handleTelegramCommand(req.body || {});
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => {
  console.log(`notify server running on ${PORT}`);
});
