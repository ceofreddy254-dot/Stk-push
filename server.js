const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(express.json());

// ✅ Allow only your Netlify frontend
app.use(cors({
  origin: "https://john.netlifly.app"
}));

// Load credentials from Render Environment Variables
const API_KEY = process.env.SPAWIKO_API_KEY;
const API_SECRET = process.env.SPAWIKO_API_SECRET;
const PAYMENT_ACCOUNT_ID = process.env.SPAWIKO_ACCOUNT_ID || 17;

// ========================
// Initiate STK Push + Poll Status
// ========================
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ success: false, message: "Phone and amount are required" });
    }

    // --- Initiate STK Push ---
    const payload = {
      payment_account_id: PAYMENT_ACCOUNT_ID,
      phone,
      amount,
      reference: `ORDER_${Date.now()}`,
      description: "Payment via Spawiko API"
    };

    const stkResponse = await axios.post(
      "https://pay.spawiko.co.ke/api/v2/stkpush.php",
      payload,
      {
        headers: {
          "X-API-Key": API_KEY,
          "X-API-Secret": API_SECRET,
          "Content-Type": "application/json"
        }
      }
    );

    if (!stkResponse.data.success) {
      return res.status(400).json(stkResponse.data);
    }

    const checkoutRequestId = stkResponse.data.checkout_request_id;

    // --- Poll Payment Status ---
    const maxAttempts = 24; // 2 minutes (5s * 24)
    let attempt = 0;
    let statusResult = null;

    while (attempt < maxAttempts) {
      const statusResponse = await axios.post(
        "https://pay.spawiko.co.ke/api/v2/status.php",
        { checkout_request_id: checkoutRequestId },
        {
          headers: {
            "X-API-Key": API_KEY,
            "X-API-Secret": API_SECRET,
            "Content-Type": "application/json"
          }
        }
      );

      statusResult = statusResponse.data;

      if (statusResult.success) {
        if (statusResult.status === "completed") {
          return res.json({
            success: true,
            message: "Payment completed",
            transaction_code: statusResult.transaction_code
          });
        } else if (statusResult.status === "failed") {
          return res.json({ success: false, message: "Payment failed" });
        }
      }

      // Wait 5s before retry
      attempt++;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Timeout if still pending
    res.json({ success: false, message: "Payment status check timeout", lastStatus: statusResult });

  } catch (err) {
    console.error("STK Push Error:", err.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ========================
// Start Server
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});