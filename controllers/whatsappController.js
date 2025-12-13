import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const WHATSAPP_API_URL = `https://graph.facebook.com/v24.0/${process.env.PHONE_NUMBER_ID}/messages`;

export const sendWhatsAppMessage = async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ error: "User phone number is required" });
    }

    // Validate phone number format
    const phoneDigits = phone.replace(/[^\d]/g, "");
    if (phoneDigits.length < 10 || phoneDigits.length > 12) {
      return res.status(400).json({ 
        error: "Invalid phone number", 
        details: "Phone number must be 10-12 digits long" 
      });
    }

    // Fix phone number formatting for WhatsApp API
    let formattedUserPhone = phone.replace(/\s+/g, "").replace(/[^\d]/g, ""); // Remove all non-digits
    
    // Ensure phone number has country code
    if (formattedUserPhone.length === 10) {
      formattedUserPhone = "91" + formattedUserPhone; // Add India country code
    }
    
    // WhatsApp API expects format without + sign
    if (formattedUserPhone.startsWith("+")) {
      formattedUserPhone = formattedUserPhone.substring(1);
    }
    
    console.log(`📱 Original phone: ${phone}, Formatted: ${formattedUserPhone}`);

    const payload = {
  messaging_product: "whatsapp",
  to: formattedUserPhone,
  type: "template",
  template: {
    name: "game_greeting", // Must match your approved template name
    language: { code: "en" }, // Use exact language (check in WhatsApp Manager)
    components: [
      {
        type: "header",
        parameters: [
          {
            type: "image",
            image: {
              link: "https://res.cloudinary.com/dlmcpmdpn/image/upload/v1765266071/Prize_Pool_2.0_1_bdcuna.jpg" // 👈 Public URL of your image
            }
          }
        ]
      }
    ]
  }
};

    const response = await axios.post(WHATSAPP_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    console.log("✅ 'verified' template sent:", response.data);
    res.status(200).json({
      success: true,
      message: "Utility template 'verified' sent successfully.",
      data: response.data,
    });
  } catch (error) {
    console.error("❌ Error sending WhatsApp message:", JSON.stringify(error.response?.data || error.message, null, 2));
    
    // Extract specific error message for phone number issues
    const errorMessage = error.response?.data?.error?.message || error.message;
    const errorCode = error.response?.data?.error?.code;
    
    if (errorCode === 131009) {
      return res.status(400).json({ 
        error: "Invalid phone number format", 
        details: "Please provide a valid 10-digit phone number",
        originalError: errorMessage
      });
    }
    
    res.status(500).json({ 
      error: "Failed to send WhatsApp message",
      details: errorMessage,
      code: errorCode
    });
  }
};