const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(express.json());

// ✅ Allow requests from multiple origins for development and production
app.use(cors({
  origin: [
    "https://testpayments254.netlify.app",
    "http://localhost:5000",
    "http://0.0.0.0:5000",
    "http://127.0.0.1:5000"
  ],
  credentials: true
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

    const reference = `ORDER_${Date.now()}`;

    // --- Initiate STK Push ---
    const payload = {
      payment_account_id: PAYMENT_ACCOUNT_ID,
      phone,
      amount,
      reference,
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
            transaction_code: statusResult.transaction_code,
            phone,
            amount,
            reference,
            checkout_request_id: checkoutRequestId,
            status: "completed"
          });
        } else if (statusResult.status === "failed") {
          return res.json({
            success: false,
            message: "Payment failed",
            phone,
            amount,
            reference,
            checkout_request_id: checkoutRequestId,
            status: "failed"
          });
        }
      }

      attempt++;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Timeout if still pending
    res.json({
      success: false,
      message: "Payment status check timeout - still pending",
      phone,
      amount,
      reference,
      checkout_request_id: checkoutRequestId,
      status: "pending",
      lastStatus: statusResult
    });

  } catch (err) {
    console.error("STK Push Error:", err.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ========================
// Check Transaction Status
// ========================
app.post("/transaction/status", async (req, res) => {
  try {
    const { checkout_request_id } = req.body;

    if (!checkout_request_id) {
      return res.status(400).json({ success: false, message: "checkout_request_id is required" });
    }

    const statusResponse = await axios.post(
      "https://pay.spawiko.co.ke/api/v2/status.php",
      { checkout_request_id },
      {
        headers: {
          "X-API-Key": API_KEY,
          "X-API-Secret": API_SECRET,
          "Content-Type": "application/json"
        }
      }
    );

    const statusResult = statusResponse.data;

    if (statusResult.success) {
      res.json({
        success: true,
        status: statusResult.status,
        transaction_code: statusResult.transaction_code || null,
        checkout_request_id,
        message: `Transaction is ${statusResult.status}`
      });
    } else {
      res.json({
        success: false,
        message: "Failed to check transaction status",
        checkout_request_id
      });
    }

  } catch (err) {
    console.error("Status Check Error:", err.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ========================
// Bulk Status Check (for multiple transactions)
// ========================
app.post("/transactions/status", async (req, res) => {
  try {
    const { checkout_request_ids } = req.body;

    if (!checkout_request_ids || !Array.isArray(checkout_request_ids)) {
      return res.status(400).json({ success: false, message: "checkout_request_ids array is required" });
    }

    const results = [];

    for (const checkout_request_id of checkout_request_ids) {
      try {
        const statusResponse = await axios.post(
          "https://pay.spawiko.co.ke/api/v2/status.php",
          { checkout_request_id },
          {
            headers: {
              "X-API-Key": API_KEY,
              "X-API-Secret": API_SECRET,
              "Content-Type": "application/json"
            }
          }
        );

        const statusResult = statusResponse.data;

        results.push({
          checkout_request_id,
          success: statusResult.success,
          status: statusResult.status || "unknown",
          transaction_code: statusResult.transaction_code || null
        });

      } catch (err) {
        results.push({
          checkout_request_id,
          success: false,
          status: "error",
          transaction_code: null,
          error: err.message
        });
      }
    }

    res.json({
      success: true,
      results
    });

  } catch (err) {
    console.error("Bulk Status Check Error:", err.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ========================
// Health Check
// ========================
app.get("/health", (req, res) => {
  res.json({ success: true, message: "Server is running", timestamp: new Date().toISOString() });
});

// ========================
// Start Server
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
