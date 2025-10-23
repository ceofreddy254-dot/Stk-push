const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());

// ✅ Updated CORS
app.use(cors({
  origin: [
    "https://swift-9y1q.onrender.com",
    "https://aesthetic-dolphin-cd6fba.netlify.app",
    "https://*.replit.dev",
    "*" // ⚠️ Remove in production
  ],
  credentials: true
}));

// 🔐 Environment variables
const API_KEY = process.env.SPAWIKO_API_KEY;
const API_SECRET = process.env.SPAWIKO_API_SECRET;
const PAYMENT_ACCOUNT_ID = process.env.SPAWIKO_ACCOUNT_ID || 17;

// 💾 Persistent file storage
const PAYMENTS_FILE = path.join(__dirname, "payments.json");

let payments = [];

// 🧠 Load payments from file
function loadPayments() {
  try {
    if (fs.existsSync(PAYMENTS_FILE)) {
      const data = fs.readFileSync(PAYMENTS_FILE, "utf8");
      payments = JSON.parse(data);
      console.log(`📥 Loaded ${payments.length} payments from file`);
    } else {
      console.log("📄 No existing payments file found, starting fresh");
    }
  } catch (error) {
    console.error("❌ Error loading payments:", error.message);
    payments = [];
  }
}

// 💾 Save payments to file
function savePayments() {
  try {
    fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(payments, null, 2));
    console.log(`💾 Saved ${payments.length} payments`);
  } catch (error) {
    console.error("❌ Error saving payments:", error.message);
  }
}

loadPayments();

// 🔑 Generate unique payment ID
function generatePaymentId() {
  return `PAY_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// 🔍 Check payment status from Spawiko
async function checkPaymentStatus(checkoutRequestId) {
  try {
    console.log(`🔍 Checking payment status for: ${checkoutRequestId}`);
    const response = await axios.post(
      "https://pay.spawiko.co.ke/api/v2/status",
      { checkout_request_id: checkoutRequestId },
      {
        headers: {
          "X-API-Key": API_KEY,
          "X-API-Secret": API_SECRET,
          "Content-Type": "application/json",
        },
      }
    );
    console.log("📊 Status response:", response.data);
    return response.data;
  } catch (error) {
    console.error("❌ Status check error:", error.message);
    return { success: false, message: "Status check failed" };
  }
}

// 🧾 Logging middleware
app.use((req, res, next) => {
  console.log(`📝 ${req.method} ${req.url}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log("📤 Body:", JSON.stringify(req.body, null, 2));
  }
  next();
});

// =======================
// 🚀 STK Push Endpoint
// =======================
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount, description = "Payment via M-Pesa" } = req.body;

    if (!phone || !amount)
      return res.status(400).json({ success: false, message: "Phone and amount are required" });

    if (!/^2547\d{8}$/.test(phone))
      return res.status(400).json({ success: false, message: "Invalid phone format. Use 2547XXXXXXXX" });

    if (amount <= 0 || amount > 300000)
      return res.status(400).json({ success: false, message: "Amount must be between 1 and 300,000" });

    const paymentId = generatePaymentId();
    const reference = `ORDER_${Date.now()}`;
    const payment = {
      id: paymentId,
      phone,
      amount,
      reference,
      description,
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      checkout_request_id: null,
      transaction_code: null,
      error_message: null,
    };

    payments.push(payment);
    savePayments();

    // 🔁 Initiate STK Push
    const response = await axios.post(
      "https://pay.spawiko.co.ke/api/v2/stkpush",
      {
        payment_account_id: PAYMENT_ACCOUNT_ID,
        phone,
        amount,
        reference,
        description,
      },
      {
        headers: {
          "X-API-Key": API_KEY,
          "X-API-Secret": API_SECRET,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.data.success) {
      payment.status = "failed";
      payment.error_message = response.data.message;
      savePayments();
      return res.status(400).json({ success: false, message: response.data.message });
    }

    payment.checkout_request_id = response.data.checkout_request_id;
    savePayments();

    // 🕒 Poll payment status
    let attempts = 0;
    const maxAttempts = 24;
    let statusResult = null;

    while (attempts < maxAttempts) {
      statusResult = await checkPaymentStatus(payment.checkout_request_id);
      if (statusResult.success) {
        if (statusResult.status === "completed") {
          payment.status = "completed";
          payment.transaction_code = statusResult.transaction_code;
          payment.updated_at = new Date().toISOString();
          savePayments();
          return res.json({
            success: true,
            message: "Payment completed successfully",
            payment_id: paymentId,
            transaction_code: statusResult.transaction_code,
          });
        }
        if (statusResult.status === "failed") {
          payment.status = "failed";
          payment.error_message = statusResult.message;
          savePayments();
          return res.json({ success: false, message: statusResult.message });
        }
      }
      attempts++;
      if (attempts < maxAttempts) await new Promise(r => setTimeout(r, 5000));
    }

    payment.status = "timeout";
    payment.error_message = "Payment status check timeout";
    savePayments();
    res.json({ success: false, message: "Payment status check timeout" });
  } catch (err) {
    console.error("🚨 STK Push Error:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// =======================
// 📋 Get Payments
// =======================
app.get("/payments", (req, res) => {
  try {
    let { status, phone, from_date, to_date, limit = 50, offset = 0 } = req.query;
    let filtered = [...payments];

    if (status && status !== "all") filtered = filtered.filter(p => p.status === status);
    if (phone) filtered = filtered.filter(p => p.phone.includes(phone.trim()));
    if (from_date) filtered = filtered.filter(p => new Date(p.created_at) >= new Date(from_date));
    if (to_date) filtered = filtered.filter(p => new Date(p.created_at) <= new Date(to_date));

    filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const paginated = filtered.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

    res.json({ success: true, payments: paginated, total: filtered.length });
  } catch (err) {
    console.error("❌ Error fetching payments:", err.message);
    res.status(500).json({ success: false, message: "Failed to fetch payments" });
  }
});

// =======================
// 📈 Payment Stats
// =======================
app.get("/payments/stats", (req, res) => {
  try {
    const stats = {
      total: payments.length,
      completed: payments.filter(p => p.status === "completed").length,
      pending: payments.filter(p => p.status === "pending").length,
      failed: payments.filter(p => p.status === "failed").length,
      timeout: payments.filter(p => p.status === "timeout").length,
      total_amount: payments.filter(p => p.status === "completed").reduce((sum, p) => sum + p.amount, 0),
    };
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to generate stats" });
  }
});

// 🩺 Health Check
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "Server running",
    timestamp: new Date().toISOString(),
    payments_count: payments.length,
  });
});

// 🐞 Debug endpoint (remove in production)
app.get("/debug/payments", (req, res) => {
  res.json({ success: true, payments, file: PAYMENTS_FILE });
});

// 🧯 Error Handler
app.use((err, req, res, next) => {
  console.error("🚨 Unhandled Error:", err.message);
  res.status(500).json({ success: false, message: "Something went wrong" });
});

// 🚀 Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 M-Pesa Server Started on port ${PORT}`);
  console.log(`💾 Payments file: ${PAYMENTS_FILE}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
});

// 🕓 Auto-save backup every 30s
setInterval(() => savePayments(), 30000);

// 🧹 Graceful shutdown
["SIGTERM", "SIGINT"].forEach(sig => {
  process.on(sig, () => {
    console.log(`\n⏹️  Received ${sig}, saving and shutting down`);
    savePayments();
    process.exit(0);
  });
});
