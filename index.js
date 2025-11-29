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

// REQUIRED for WhatsApp Cloud API
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);


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
  process.env.WHATSAPP_API_URL || "https://graph.facebook.com/v24.0";
const WHATSAPP_PHONE_ID = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// ================================================================
// ✅ CHAT MESSAGE LIMIT CONFIGURATION
// ================================================================
const MAX_CHAT_MESSAGES = 10;

/**
 * Maintains chat message limit by deleting oldest messages (for registered users)
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

/**
 * Maintains support chat message limit by deleting oldest messages (for unknown users)
 * @param {string} shortPhone - 10-digit phone number
 */
async function maintainSupportChatLimit(shortPhone) {
  try {
    const messagesRef = db
      .collection("supportChats")
      .doc(shortPhone)
      .collection("messages");

    // Get total message count
    const snapshot = await messagesRef.get();
    const totalMessages = snapshot.size;

    if (totalMessages > MAX_CHAT_MESSAGES) {
      const excessCount = totalMessages - MAX_CHAT_MESSAGES;
      console.log(`🗑️ Deleting ${excessCount} old support messages for ${shortPhone}`);

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

      console.log(`✅ Deleted ${excessCount} old support messages for ${shortPhone}`);
    }
  } catch (error) {
    console.error(`❌ Error maintaining support chat limit for ${shortPhone}:`, error.message);
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



     // 🔥 DELIVERY TRACKING BLOCK (your requested output here)
    // ============================================================
    if (change?.statuses) {
      change.statuses.forEach((status) => {

        const statusLog = {
          statuses: [
            {
              status: status.status,
              errors: status.errors
                ? status.errors.map(err => ({
                    code: err.code,
                    title: err.title,
                    message: err.message
                  }))
                : undefined
            }
          ]
        };

        console.log("📦 DELIVERY STATUS UPDATE:\n" + JSON.stringify(statusLog, null, 2));
      });
    }





    const messages = change?.messages;
    if (!messages) return res.status(200).json({ status: "no messages" });

    for (const msg of messages) {
      const from = msg.from;               // e.g., 91987xxxxxxx
      const shortPhone = from.slice(-10);  // use 10-digit doc id
      const timestamp = new Date().toISOString();

      // ✅ TEXT MESSAGE: Check if user is registered and save accordingly
      if (msg.text?.body) {
        const text = msg.text.body;
        console.log(`📩 Text from ${from}: ${text}`);
        receivedMessagesStore.push({ from, text, timestamp });

        // Check if user is registered in teamRegistrations
        const teamSnapshot = await db
          .collection("teamRegistrations")
          .where("phoneNumber", "==", shortPhone)
          .limit(1)
          .get();

        const isRegistered = !teamSnapshot.empty;

        if (isRegistered) {
          // ✅ REGISTERED USER: Save to whatsappChats
          console.log(`💬 Registered user message: ${shortPhone}`);
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

          // Maintain chat message limit
          await maintainChatLimit(shortPhone);
        } else {
          // ✅ UNKNOWN USER: Save to supportChats
          console.log(`🆘 Unknown user message: ${shortPhone}`);
          await db
            .collection("supportChats")
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
            .collection("supportChats")
            .doc(shortPhone)
            .set({ lastUpdated: timestamp }, { merge: true });

          // Maintain chat message limit for support chats
          await maintainSupportChatLimit(shortPhone);
        }
      }

      // ✅ IMAGE MESSAGE: DO NOT store in whatsappChats; save to teamRegistrations only
      if (msg.image?.id) {
        const mediaId = msg.image.id;
        console.log(`🖼 Received image from ${shortPhone} (Media ID: ${mediaId})`);
        try {
          // 1) Get media URL
          const mediaRes = await axios.get(
            `https://graph.facebook.com/v24.0/${mediaId}`,
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
  handleVerify(req, res, "not_eligible")
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
// ✅ ADMIN → SUPPORT USER CHAT API (SEND MESSAGE TO UNKNOWN USER)
//     - Sends via WhatsApp API
//     - Stores in supportChats collection
// ================================================================
app.post("/api/support/send", async (req, res) => {
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

    // Save to supportChats collection
    const timestamp = new Date().toISOString();
    const shortPhone = phoneNumber.slice(-10);

    await db
      .collection("supportChats")
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
      .collection("supportChats")
      .doc(shortPhone)
      .set({ lastUpdated: timestamp }, { merge: true });

    // Maintain support chat message limit
    await maintainSupportChatLimit(shortPhone);

    res
      .status(200)
      .json({ success: true, message: "Support message sent successfully" });
  } catch (err) {
    console.error("❌ Admin support send error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to send support message" });
  }
});

// ================================================================
// ✅ FETCH SUPPORT CHAT HISTORY (for unknown users)
//     - Reads from supportChats collection
// ================================================================
app.get("/api/support/history/:phoneNumber", async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const shortPhone = phoneNumber.slice(-10);

    // Check if the chat document exists in supportChats
    const chatDoc = await db
      .collection("supportChats")
      .doc(shortPhone)
      .get();

    // If no chat document exists, return empty messages array
    if (!chatDoc.exists) {
      console.log(`ℹ️ No support chat history found for ${shortPhone}, returning empty array`);
      return res.status(200).json({ phoneNumber: shortPhone, messages: [] });
    }

    const messagesSnapshot = await db
      .collection("supportChats")
      .doc(shortPhone)
      .collection("messages")
      .orderBy("timestamp", "desc")
      .limit(10)
      .get();

    const messages = messagesSnapshot.docs.map((doc) => doc.data()).reverse();
    res.status(200).json({ phoneNumber: shortPhone, messages });
  } catch (err) {
    console.error("❌ Error fetching support chat history:", err.message);
    res.status(500).json({ error: "Failed to fetch support chat history" });
  }
});

// ================================================================
// ✅ GET ALL SUPPORT CHAT USERS (for support tab)
//     - Returns list of ONLY UNKNOWN users from supportChats collection
// ================================================================
app.get("/api/support/users", async (req, res) => {
  try {
    const chatsSnapshot = await db.collection("supportChats").get();
    const users = [];

    for (const chatDoc of chatsSnapshot.docs) {
      const phoneNumber = chatDoc.id;
      const chatData = chatDoc.data();
      
      // Get the last message
      const lastMessageSnapshot = await db
        .collection("supportChats")
        .doc(phoneNumber)
        .collection("messages")
        .orderBy("timestamp", "desc")
        .limit(1)
        .get();

      const lastMessage = lastMessageSnapshot.empty 
        ? null 
        : lastMessageSnapshot.docs[0].data();

      users.push({
        phoneNumber,
        name: phoneNumber, // Use phone number as name
        profileImage: null,
        lastMessage: lastMessage?.text || "No messages",
        lastMessageTime: lastMessage?.timestamp || chatData.lastUpdated,
        unreadCount: 0,
        isRegistered: false,
      });
    }

    // Sort by last message time (most recent first)
    users.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

    console.log(`✅ Found ${users.length} unknown users in support chat`);
    res.status(200).json({ users });
  } catch (err) {
    console.error("❌ Error fetching support users:", err.message);
    res.status(500).json({ error: "Failed to fetch support users" });
  }
});

// ================================================================
// ✅ GET USER DETAILS FOR SUPPORT (phone, media files, etc.)
// ================================================================
app.get("/api/support/user/:phoneNumber", async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const shortPhone = phoneNumber.slice(-10);

    // Get message count from supportChats
    const messagesSnapshot = await db
      .collection("supportChats")
      .doc(shortPhone)
      .collection("messages")
      .get();

    const messageCount = messagesSnapshot.size;

    // Get first message timestamp
    const firstMessageSnapshot = await db
      .collection("supportChats")
      .doc(shortPhone)
      .collection("messages")
      .orderBy("timestamp", "asc")
      .limit(1)
      .get();

    const firstMessageTime = firstMessageSnapshot.empty 
      ? null 
      : firstMessageSnapshot.docs[0].data().timestamp;

    res.status(200).json({
      phoneNumber: shortPhone,
      name: "Unknown User",
      email: "N/A",
      profileImage: null,
      mediaFiles: [],
      isRegistered: false,
      messageCount: messageCount,
      firstContactTime: firstMessageTime,
      registrationData: null,
    });
  } catch (err) {
    console.error("❌ Error fetching user details:", err.message);
    res.status(500).json({ error: "Failed to fetch user details" });
  }
});

// ================================================================
// ✅ BULK MESSAGE SENDER API ENDPOINTS
// ================================================================

// Map of template → language + body param count + optional header type
// header: "image" | "video" | null
const TEMPLATE_META = {
    not_eligible: { language: "en_US", bodyParams: 0, header: null },
  verified:     { language: "en_US", bodyParams: 0, header: null },
  pending:      { language: "en_US", bodyParams: 0, header: null },
  game_greeting:{ language: "en_US", bodyParams: 0, header: null },
  // EXAMPLES (uncomment / adjust when you create them):
  // tournament_reminder: {
  //   language: "en_US",
  //   bodyParams: 2,         // e.g. {{1}} = tournament, {{2}} = date
  //   header: "image"        // uses header image
  // },
};

/**
 * Helper function to send WhatsApp template message with dynamic parameters
 * @param {string} to - Phone number with country code (e.g., 919876543210)
 * @param {string} templateName - Name of the WhatsApp template
 * @param {object} params - Dynamic parameters for the template (e.g., { tournament, date, imageUrl })
 * @returns {Promise<object>} - WhatsApp API response
 */
async function sendTemplateMessageWithParams(to, templateName, params = {}) {
  const url = `${WHATSAPP_API_URL}/${WHATSAPP_PHONE_ID}/messages`;

  // Validate inputs
  if (!to || to.trim() === "") {
    throw new Error("Phone number is required");
  }

  if (!templateName || templateName.trim() === "") {
    throw new Error("Template name is required");
  }

  // Resolve template meta (fallback = text-only, 0 params, en_US)
  if(!TEMPLATE_META[templateName]){
  TEMPLATE_META[templateName] = { language:"en_US", bodyParams:0, header:null };
  console.log(`⚠ Auto-added template: ${templateName}`);
}
const meta = TEMPLATE_META[templateName];


  const components = [];

  // 🔹 1) HEADER (image / video) SUPPORT
  // If your template has a media header, configure `header` in TEMPLATE_META
  if (meta.header === "image" && params.imageUrl) {
    components.push({
      type: "header",
      parameters: [
        {
          type: "image",
          image: {
            link: String(params.imageUrl),
          },
        },
      ],
    });
  } else if (meta.header === "video" && params.videoUrl) {
    components.push({
      type: "header",
      parameters: [
        {
          type: "video",
          video: {
            link: String(params.videoUrl),
          },
        },
      ],
    });
  }

  // 🔹 2) BODY PARAMETERS (ONLY if template expects them)
  if (meta.bodyParams > 0) {
    const bodyParameters = [];

    // Simple mapping for your current use case (tournament + date)
    if (params.tournament) {
      bodyParameters.push({ type: "text", text: String(params.tournament) });
    }
    if (params.date) {
      bodyParameters.push({ type: "text", text: String(params.date) });
    }

    // Optional: support generic `params.body = [v1, v2, ...]`
    if (Array.isArray(params.body)) {
      params.body.forEach((val) => {
        bodyParameters.push({ type: "text", text: String(val) });
      });
    }

    if (bodyParameters.length !== meta.bodyParams) {
      throw new Error(
        `Template "${templateName}" expects ${meta.bodyParams} body params, but got ${bodyParameters.length}`
      );
    }

    components.push({
      type: "body",
      parameters: bodyParameters,
    });
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: meta.language },
      ...(components.length > 0 ? { components } : {}),
    },
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 10000, // 10 second timeout
    });

    console.log(`✅ Template sent: ${templateName} → ${to}`);
    return response.data;
  } catch (error) {
    // Enhanced error logging and handling
    console.error(`❌ WhatsApp send error for ${to}:`);

    if (error.response) {
      console.error("Response status:", error.response.status);
      console.error("Response data:", JSON.stringify(error.response.data, null, 2));
      console.error("Response headers:", error.response.headers);

      const whatsappError = error.response.data?.error;
      if (whatsappError) {
        const errorMessage =
          whatsappError.message ||
          whatsappError.error_user_msg ||
          "WhatsApp API error";
        const errorCode = whatsappError.code || error.response.status;
        throw new Error(`WhatsApp API Error (${errorCode}): ${errorMessage}`);
      }

      throw new Error(`WhatsApp API returned status ${error.response.status}`);
    } else if (error.request) {
      console.error("No response received from WhatsApp API");
      console.error("Request details:", error.request);
      throw new Error("No response from WhatsApp API - network or timeout issue");
    } else if (error.code === "ECONNABORTED") {
      console.error("Request timeout");
      throw new Error("WhatsApp API request timeout");
    } else {
      console.error("Error setting up request:", error.message);
      throw new Error(`Request setup error: ${error.message}`);
    }
  }
}

/**
 * POST /api/bulk-message/send
 * Send bulk WhatsApp messages to multiple teams
 */
app.post("/api/bulk-message/send", async (req, res) => {
  try {
    console.log("📨 Bulk message send request received");
    const { teams, templateName, tournament, date, templateParams } = req.body;
    
    // Validate input with detailed error messages
    if (!teams || !Array.isArray(teams)) {
      console.error("❌ Validation failed: teams is not an array");
      return res.status(400).json({ 
        error: "Invalid request: teams must be an array" 
      });
    }
    
    if (teams.length === 0) {
      console.error("❌ Validation failed: no teams provided");
      return res.status(400).json({ 
        error: "No teams provided. Please select at least one team." 
      });
    }
    
    if (!templateName || templateName.trim() === "") {
      console.error("❌ Validation failed: template name missing");
      return res.status(400).json({ 
        error: "Template name is required" 
      });
    }
    
    if (!tournament || tournament.trim() === "") {
      console.error("❌ Validation failed: tournament missing");
      return res.status(400).json({ 
        error: "Tournament is required" 
      });
    }
    
    // Validate team data
    const invalidTeams = teams.filter(team => 
      !team.teamId || !team.phoneNumber || !team.teamName
    );
    
    if (invalidTeams.length > 0) {
      console.error("❌ Validation failed: invalid team data", invalidTeams);
      return res.status(400).json({ 
        error: `${invalidTeams.length} team(s) have missing required fields (teamId, phoneNumber, or teamName)` 
      });
    }
    
    console.log(`📨 Starting bulk send: ${teams.length} teams, template: ${templateName}, tournament: ${tournament}`);
    
    const results = {
      successful: 0,
      failed: 0,
      details: []
    };
    
    // Send messages to all teams with delay to avoid rate limiting
    for (let i = 0; i < teams.length; i++) {
      const team = teams[i];
      
      try {
        // Validate phone number format
        let phoneNumber = team.phoneNumber?.trim();
        
        if (!phoneNumber) {
          throw new Error("Phone number is empty");
        }
        
        // Ensure phone number has country code (add 91 if not present)
        if (phoneNumber.length === 10) {
          phoneNumber = `91${phoneNumber}`;
        } else if (phoneNumber.length !== 12 || !phoneNumber.startsWith("91")) {
          throw new Error(`Invalid phone number format: ${phoneNumber}`);
        }
        
        console.log(`📤 [${i + 1}/${teams.length}] Sending to ${team.teamName} (${phoneNumber})`);
        
        await sendTemplateMessageWithParams(
          phoneNumber,
          templateName,
          templateParams || { tournament, date }
        );
        
        results.successful++;
        results.details.push({
          teamId: team.teamId,
          teamName: team.teamName,
          phoneNumber: team.phoneNumber,
          status: "success"
        });
        
        console.log(`✅ [${i + 1}/${teams.length}] Sent to ${team.teamName}`);
        
        // Add 100ms delay between messages to avoid rate limiting
        if (i < teams.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (error) {
        results.failed++;
        const errorMessage = error.message || "Unknown error";
        
        results.details.push({
          teamId: team.teamId,
          teamName: team.teamName,
          phoneNumber: team.phoneNumber,
          status: "failed",
          error: errorMessage
        });
        
        console.error(`❌ [${i + 1}/${teams.length}] Failed for ${team.teamName}: ${errorMessage}`);
        
        // Log WhatsApp API specific errors
        if (error.response?.data) {
          console.error("WhatsApp API error details:", JSON.stringify(error.response.data, null, 2));
        }
      }
    }
    
    console.log(`📊 Bulk send completed: ${results.successful} successful, ${results.failed} failed`);
    
    // Store in bulkMessageHistory collection
    const historyRecord = {
      tournament: tournament,
      templateName: templateName,
      totalTeams: teams.length,
      successfulCount: results.successful,
      failedCount: results.failed,
      sentDate: new Date().toISOString(),
      teamIds: teams.map(t => t.teamId),
      results: results.details
    };
    
    try {
      console.log("💾 Saving bulk message history to Firebase...");
      const historyRef = await db.collection("bulkMessageHistory").add(historyRecord);
      console.log(`✅ History saved with ID: ${historyRef.id}`);
      
      res.status(200).json({
        success: true,
        results: results,
        historyId: historyRef.id
      });
    } catch (dbError) {
      console.error("❌ Error saving to bulkMessageHistory:", dbError.message);
      console.error("Database error details:", dbError);
      
      // Still return success for the messages that were sent
      res.status(200).json({
        success: true,
        results: results,
        historyId: null,
        warning: "Messages sent but history not saved to database"
      });
    }
    
  } catch (error) {
    console.error("❌ Bulk send error:", error.message);
    console.error("Error stack:", error.stack);
    
    res.status(500).json({ 
      error: "Failed to send bulk messages. Please try again.",
      details: error.message 
    });
  }
});

/**
 * GET /api/whatsapp/templates
 * Fetch WhatsApp message templates from Meta Graph API
 */
app.get("/api/whatsapp/templates", async (req, res) => {
  try {
    console.log("📋 Fetching WhatsApp templates from Meta Graph API...");
    
    // Get WABA ID from environment variable
    const WABA_ID = "1540862954008233";
    
    if (!WABA_ID) {
      console.error("❌ WHATSAPP_BUSINESS_ACCOUNT_ID not configured");
      return res.status(500).json({ 
        error: "WhatsApp Business Account ID not configured",
        templates: []
      });
    }
    
    if (!WHATSAPP_TOKEN) {
      console.error("❌ WHATSAPP_TOKEN not configured");
      return res.status(500).json({ 
        error: "WhatsApp token not configured",
        templates: []
      });
    }
    
    // Fetch templates from Meta Graph API
    const url = `${WHATSAPP_API_URL}/${WABA_ID}/message_templates`;
    
    console.log(`📡 Requesting templates from: ${url}`);
    
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`
      },
      params: {
        limit: 100 // Get up to 100 templates
      }
    });
    
    const templates = response.data.data || [];
    
    console.log(`✅ Fetched ${templates.length} templates from Meta`);
    
    // Filter only approved templates and format the response
    const approvedTemplates = templates
      .filter(template => template.status === "APPROVED")
      .map(template => ({
        id: template.id,
        name: template.name,
        language: template.language,
        status: template.status,
        category: template.category,
        components: template.components || []
      }));
    
    console.log(`✅ Returning ${approvedTemplates.length} approved templates`);
    
    res.status(200).json({
      success: true,
      count: approvedTemplates.length,
      templates: approvedTemplates
    });
    
  } catch (error) {
    console.error("❌ Error fetching WhatsApp templates:", error.response?.data || error.message);
    
    res.status(500).json({
      error: "Failed to fetch templates",
      message: error.response?.data?.error?.message || error.message,
      templates: []
    });
  }
});

/**
 * GET /api/bulk-message/history
 * Fetch bulk message history with pagination
 */
app.get("/api/bulk-message/history", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    // Validate query parameters
    if (limit < 1 || limit > 100) {
      console.warn(`⚠️ Invalid limit parameter: ${limit}, using default 50`);
    }
    
    if (offset < 0) {
      console.warn(`⚠️ Invalid offset parameter: ${offset}, using default 0`);
    }
    
    const validLimit = Math.min(Math.max(limit, 1), 100);
    const validOffset = Math.max(offset, 0);
    
    console.log(`📋 Fetching bulk message history (limit: ${validLimit}, offset: ${validOffset})`);
    
    try {
      const historySnapshot = await db
        .collection("bulkMessageHistory")
        .orderBy("sentDate", "desc")
        .limit(validLimit)
        .offset(validOffset)
        .get();
      
      if (!historySnapshot) {
        console.warn("⚠️ History snapshot is null or undefined");
        return res.status(200).json({ 
          history: [],
          count: 0,
          limit: validLimit,
          offset: validOffset
        });
      }
      
      const history = historySnapshot.docs.map(doc => {
        try {
          return {
            id: doc.id,
            ...doc.data()
          };
        } catch (docError) {
          console.error(`❌ Error processing history document ${doc.id}:`, docError.message);
          return null;
        }
      }).filter(record => record !== null);
      
      console.log(`✅ Retrieved ${history.length} history records`);
      
      res.status(200).json({ 
        history,
        count: history.length,
        limit: validLimit,
        offset: validOffset
      });
      
    } catch (dbError) {
      console.error("❌ Database error fetching history:", dbError.message);
      console.error("Database error details:", dbError);
      
      // Check for specific Firebase errors
      if (dbError.code === 'permission-denied') {
        return res.status(403).json({ 
          error: "Permission denied to access history",
          details: "You may not have access to the bulkMessageHistory collection" 
        });
      } else if (dbError.code === 'unavailable') {
        return res.status(503).json({ 
          error: "Database service unavailable",
          details: "The database service is temporarily unavailable. Please try again later." 
        });
      }
      
      throw dbError;
    }
    
  } catch (error) {
    console.error("❌ Error fetching history:", error.message);
    console.error("Error stack:", error.stack);
    
    res.status(500).json({ 
      error: "Failed to fetch history. Please try again.",
      details: error.message 
    });
  }
});

/**
 * DELETE /api/bulk-message/history/:id
 * Delete a specific bulk message history record
 */
app.delete("/api/bulk-message/history/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate history ID
    if (!id || id.trim() === "") {
      console.error("❌ Validation failed: history ID is empty");
      return res.status(400).json({ 
        error: "History ID is required" 
      });
    }
    
    console.log(`🗑️ Deleting bulk message history: ${id}`);
    
    try {
      // Check if document exists before deleting
      const docRef = db.collection("bulkMessageHistory").doc(id);
      const docSnapshot = await docRef.get();
      
      if (!docSnapshot.exists) {
        console.warn(`⚠️ History record not found: ${id}`);
        return res.status(404).json({ 
          error: "History record not found",
          details: "The history record may have already been deleted"
        });
      }
      
      // Delete the document
      await docRef.delete();
      
      console.log(`✅ History record deleted: ${id}`);
      
      res.status(200).json({ 
        success: true, 
        message: "History deleted successfully",
        id: id
      });
      
    } catch (dbError) {
      console.error("❌ Database error deleting history:", dbError.message);
      console.error("Database error details:", dbError);
      
      // Check for specific Firebase errors
      if (dbError.code === 'permission-denied') {
        return res.status(403).json({ 
          error: "Permission denied to delete history",
          details: "You may not have permission to delete from the bulkMessageHistory collection" 
        });
      } else if (dbError.code === 'unavailable') {
        return res.status(503).json({ 
          error: "Database service unavailable",
          details: "The database service is temporarily unavailable. Please try again later." 
        });
      }
      
      throw dbError;
    }
    
  } catch (error) {
    console.error("❌ Error deleting history:", error.message);
    console.error("Error stack:", error.stack);
    
    res.status(500).json({ 
      error: "Failed to delete history. Please try again.",
      details: error.message 
    });
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
