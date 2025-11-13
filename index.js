import express from "express";
import dotenv from "dotenv";
import { sendWhatsAppMessage } from "./controllers/whatsappController.js";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v2 as cloudinary } from "cloudinary";
import admin from "firebase-admin";

// 🔹 Load environment variables
dotenv.config();
const app = express();

// 🔹 File path helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🔹 Ensure uploads folder exists (optional)
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// 🔹 Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 🔹 Firebase Admin Initialization
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
// Replace escaped line breaks with real line breaks
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// 🔹 Express middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(`❌ Global error: ${err.message}`);
  console.error(err.stack);
  res.status(500).json({ error: "Internal server error", message: err.message });
});

// 🔹 In-memory store (optional, for quick debug)
let receivedMessagesStore = [];

// ================================================================
// ✅ REGISTRATION BUTTON TRIGGER
// ================================================================
app.post("/api/send-whatsapp", sendWhatsAppMessage);

// Root test route
app.get("/", (req, res) =>
  res.send("✅ WhatsApp API + Firebase connected successfully!")
);

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// ================================================================
/** ✅ STEP 1: VERIFY WEBHOOK */
// ================================================================
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "my_verify_token";

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token) {
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ WEBHOOK_VERIFIED");
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
});

// ================================================================
// ✅ ENV for WhatsApp API
// ================================================================
const WHATSAPP_API_URL =
  process.env.WHATSAPP_API_URL || "https://graph.facebook.com/v20.0";
const WHATSAPP_PHONE_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// ================================================================
// ✅ CHAT MESSAGE LIMIT CONFIGURATION
// ================================================================
const MAX_CHAT_MESSAGES = 10;

/**
 * Maintains chat message limit by deleting oldest messages
 * @param {string} shortPhone - 10-digit phone number
 */
async function maintainChatLimit(shortPhone) {
  try {
    const messagesRef = db
      .collection("whatsappChats")
      .doc(shortPhone)
      .collection("messages");

    // Get total message count
    const snapshot = await messagesRef.get();
    const totalMessages = snapshot.size;

    if (totalMessages > MAX_CHAT_MESSAGES) {
      const excessCount = totalMessages - MAX_CHAT_MESSAGES;
      console.log(`🗑️ Deleting ${excessCount} old messages for ${shortPhone}`);

      // Get oldest messages to delete
      const oldMessagesSnapshot = await messagesRef
        .orderBy("timestamp", "asc")
        .limit(excessCount)
        .get();

      // Delete in batch
      const batch = db.batch();
      oldMessagesSnapshot.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });
      await batch.commit();

      console.log(`✅ Deleted ${excessCount} old messages for ${shortPhone}`);
    }
  } catch (error) {
    console.error(`❌ Error maintaining chat limit for ${shortPhone}:`, error.message);
  }
}

// ================================================================
// ✅ STEP 2: RECEIVE INCOMING WHATSAPP MESSAGES
// ================================================================
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (!(body.object && body.entry)) {
      return res.status(404).json({ error: "Invalid payload" });
    }

    const change = body.entry?.[0]?.changes?.[0]?.value;
    const messages = change?.messages;
    if (!messages) return res.status(200).json({ status: "no messages" });

    for (const msg of messages) {
      const from = msg.from;               // e.g., 91987xxxxxxx
      const shortPhone = from.slice(-10);  // use 10-digit doc id
      const timestamp = new Date().toISOString();

      // ✅ TEXT MESSAGE: store in whatsappChats
      if (msg.text?.body) {
        const text = msg.text.body;
        console.log(`📩 Text from ${from}: ${text}`);
        receivedMessagesStore.push({ from, text, timestamp });

        // Save text message to whatsappChats ONLY
        await db
          .collection("whatsappChats")
          .doc(shortPhone)
          .collection("messages")
          .add({
            from: "user",
            text,
            timestamp,
            read: false,
            type: "text",
          });

        await db
          .collection("whatsappChats")
          .doc(shortPhone)
          .set({ lastUpdated: timestamp }, { merge: true });

        // Maintain chat message limit (delete old messages if > 10)
        await maintainChatLimit(shortPhone);
      }

      // ✅ IMAGE MESSAGE: DO NOT store in whatsappChats; save to teamRegistrations only
      if (msg.image?.id) {
        const mediaId = msg.image.id;
        console.log(`🖼 Received image from ${shortPhone} (Media ID: ${mediaId})`);
        try {
          // 1) Get media URL
          const mediaRes = await axios.get(
            `https://graph.facebook.com/v20.0/${mediaId}`,
            {
              headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
            }
          );
          const mediaUrl = mediaRes.data.url;

          // 2) Download the image
          const imageResponse = await axios.get(mediaUrl, {
            responseType: "arraybuffer",
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
          });

          // 3) Upload to Cloudinary
          const uploadedImage = await new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
              { folder: `whatsapp_media/${shortPhone}` },
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            );
            uploadStream.end(imageResponse.data);
          });

          console.log(`✅ Uploaded to Cloudinary: ${uploadedImage.secure_url}`);

          // 4) Save URL into teamRegistrations only (no whatsappChats write)
          const querySnapshot = await db
            .collection("teamRegistrations")
            .where("phoneNumber", "==", shortPhone)
            .get();

          if (!querySnapshot.empty) {
            const docRef = querySnapshot.docs[0].ref;
            await docRef.update({
              images: admin.firestore.FieldValue.arrayUnion(
                uploadedImage.secure_url
              ),
              verificationStatus: "image_uploaded",
              updatedAt: timestamp,
            });
            console.log(`🔥 Image URL saved in teamRegistrations for ${shortPhone}`);
          } else {
            console.log(
              `⚠️ No matching teamRegistrations record for ${shortPhone}.`
            );
          }

          // (Optional) Keep a debug copy in memory, but NOT in whatsappChats
          receivedMessagesStore.push({
            from,
            text: `[Image] ${uploadedImage.secure_url}`,
            timestamp,
            mediaId,
            cloudinary_id: uploadedImage.public_id,
          });
        } catch (err) {
          console.error("❌ Error handling image:", err?.response?.data || err.message);
        }
      }
    }

    res.status(200).json({ status: "received" });
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// ================================================================
// ✅ GET ALL RECEIVED MESSAGES (DEBUGGING)
// ================================================================
app.get("/api/messages", (req, res) => {
  res.status(200).json({ messages: receivedMessagesStore });
});

// ================================================================
// ✅ TEMPLATE MESSAGE HELPERS
// ================================================================
async function sendTemplateMessage(to, templateName) {
  const url = `${WHATSAPP_API_URL}/${WHATSAPP_PHONE_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" },
    },
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    console.log(`✅ Template message sent: ${templateName} → ${to}`);
    return response.data;
  } catch (error) {
    console.error(
      "❌ WhatsApp template send error:",
      error.response?.data || error.message
    );
    throw new Error(JSON.stringify(error.response?.data || error.message));
  }
}

async function handleVerify(req, res, statusText) {
  try {
    const { phoneNumber } = req.body;
    if (!phoneNumber)
      return res.status(400).json({ error: "Phone number is required" });

    console.log(`📨 Sending WhatsApp message to: ${phoneNumber}`);
    const result = await sendTemplateMessage(phoneNumber, statusText);

    res.status(200).json({
      success: true,
      status: statusText,
      message: `Message sent successfully: ${statusText}`,
      result,
    });
  } catch (error) {
    console.error("❌ Error sending verification message:", error.message);
    res.status(500).json({
      error: "Failed to send WhatsApp message",
      details: error.message,
    });
  }
}

// ✅ Verification routes
app.post("/api/verify/verified", (req, res) =>
  handleVerify(req, res, "verified")
);
app.post("/api/verify/not-verified", (req, res) =>
  handleVerify(req, res, "not_verified")
);
app.post("/api/verify/pending", (req, res) =>
  handleVerify(req, res, "pending")
);

// ================================================================
// ✅ ADMIN → USER CHAT API (SEND TEXT MESSAGE ONLY)
//     - Sends via WhatsApp API
//     - Stores TEXT in whatsappChats (no images here)
// ================================================================
app.post("/api/chat/send", async (req, res) => {
  try {
    const { phoneNumber, message } = req.body;
    if (!phoneNumber || !message)
      return res
        .status(400)
        .json({ error: "phoneNumber and message are required" });

    // Send via WhatsApp
    const url = `${WHATSAPP_API_URL}/${WHATSAPP_PHONE_ID}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      to: phoneNumber, // keep full number with country code for Meta
      type: "text",
      text: { body: message },
    };

    await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    // Save TEXT to whatsappChats ONLY
    const timestamp = new Date().toISOString();
    const shortPhone = phoneNumber.slice(-10);

    await db
      .collection("whatsappChats")
      .doc(shortPhone)
      .collection("messages")
      .add({
        from: "admin",
        text: message,
        timestamp,
        read: false,
        type: "text",
      });

    await db
      .collection("whatsappChats")
      .doc(shortPhone)
      .set({ lastUpdated: timestamp }, { merge: true });

    // Maintain chat message limit (delete old messages if > 10)
    await maintainChatLimit(shortPhone);

    res
      .status(200)
      .json({ success: true, message: "Message sent successfully" });
  } catch (err) {
    console.error("❌ Admin send error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to send WhatsApp message" });
  }
});

// ================================================================
// ✅ MANUAL CLEANUP ENDPOINT (Optional - for maintenance)
// ================================================================
app.post("/api/chat/cleanup/:phoneNumber", async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const shortPhone = phoneNumber.slice(-10);

    await maintainChatLimit(shortPhone);

    res.status(200).json({
      success: true,
      message: `Chat cleanup completed for ${shortPhone}`,
    });
  } catch (err) {
    console.error("❌ Error during manual cleanup:", err.message);
    res.status(500).json({ error: "Failed to cleanup chat history" });
  }
});

// ================================================================
// ✅ CLEANUP ALL CHATS (Admin endpoint - use with caution)
// ================================================================
app.post("/api/chat/cleanup-all", async (req, res) => {
  try {
    const chatsSnapshot = await db.collection("whatsappChats").get();
    let cleanedCount = 0;

    for (const chatDoc of chatsSnapshot.docs) {
      await maintainChatLimit(chatDoc.id);
      cleanedCount++;
    }

    res.status(200).json({
      success: true,
      message: `Cleaned up ${cleanedCount} chat conversations`,
    });
  } catch (err) {
    console.error("❌ Error during bulk cleanup:", err.message);
    res.status(500).json({ error: "Failed to cleanup all chats" });
  }
});

// ================================================================
// ✅ FETCH LAST 10 CHAT MESSAGES (TEXT-ONLY HISTORY)
//     - Reads from whatsappChats (since we store only text there)
// ================================================================
app.get("/api/chat/history/:phoneNumber", async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const shortPhone = phoneNumber.slice(-10);

    // Check if the chat document exists
    const chatDoc = await db
      .collection("whatsappChats")
      .doc(shortPhone)
      .get();

    // If no chat document exists, return empty messages array (not 404)
    if (!chatDoc.exists) {
      console.log(`ℹ️ No chat history found for ${shortPhone}, returning empty array`);
      return res.status(200).json({ phoneNumber: shortPhone, messages: [] });
    }

    const messagesSnapshot = await db
      .collection("whatsappChats")
      .doc(shortPhone)
      .collection("messages")
      .orderBy("timestamp", "desc")
      .limit(10)
      .get();

    const messages = messagesSnapshot.docs.map((doc) => doc.data()).reverse();
    res.status(200).json({ phoneNumber: shortPhone, messages });
  } catch (err) {
    console.error("❌ Error fetching chat history:", err.message);
    res.status(500).json({ error: "Failed to fetch chat history" });
  }
});

// ================================================================
// ✅ KEEP-ALIVE PING (Prevents Render free tier from sleeping)
// ================================================================
const SELF_PING_INTERVAL = 14 * 60 * 1000; // 14 minutes
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || "https://whatsapp-integration-esports.onrender.com";

if (process.env.NODE_ENV !== "development") {
  setInterval(async () => {
    try {
      const response = await axios.get(`${RENDER_URL}/`);
      console.log(`✅ Keep-alive ping successful at ${new Date().toISOString()}`);
    } catch (error) {
      console.error(`❌ Keep-alive ping failed: ${error.message}`);
    }
  }, SELF_PING_INTERVAL);
}

// ================================================================
// ✅ PROCESS MONITORING
// ================================================================
process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
  console.error(error.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

// Log memory usage every 5 minutes
setInterval(() => {
  const used = process.memoryUsage();
  console.log(`📊 Memory Usage: RSS=${Math.round(used.rss / 1024 / 1024)}MB, Heap=${Math.round(used.heapUsed / 1024 / 1024)}MB`);
}, 5 * 60 * 1000);

// ================================================================
// ✅ START SERVER
// ================================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📡 Keep-alive enabled: ${process.env.NODE_ENV !== "development"}`);
  console.log(`💾 Initial Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
});
