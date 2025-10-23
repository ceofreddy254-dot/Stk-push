// server.js - Spawiko Version (Structured like SwiftWallet)
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const cron = require("node-cron");

const app = express();
const PORT = 3000;

// File to store receipts
const receiptsFile = path.join(__dirname, "receipts.json");

// Middleware
app.use(bodyParser.json());
app.use(
  cors({
    origin: "https://swift-9y1q.onrender.com", // Your frontend
  })
);

// Helpers
function readReceipts() {
  if (!fs.existsSync(receiptsFile)) return {};
  return JSON.parse(fs.readFileSync(receiptsFile));
}
function writeReceipts(data) {
  fs.writeFileSync(receiptsFile, JSON.stringify(data, null, 2));
}

// Format phone number
function formatPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 9 && digits.startsWith("7")) return "254" + digits;
  if (digits.length === 10 && digits.startsWith("07")) return "254" + digits.substring(1);
  if (digits.length === 12 && digits.startsWith("254")) return digits;
  return null;
}

// Spawiko API credentials
const SPAWIKO_API_KEY = "7390a54c44bcb9cb692f6c861562ff6f3b424094befxxxxxxxxxxxxxxxxxxxx";
const SPAWIKO_API_SECRET = "882e5a38596b0fd6cfd8f9631592e4290ca4f441axxxxxxxxxxxxxxxxxxxxxxx";
const PAYMENT_ACCOUNT_ID = 17;

// 🟩 1️⃣ Initiate Payment
app.post("/pay", async (req, res) => {
  try {
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    if (!formattedPhone) return res.status(400).json({ success: false, error: "Invalid phone format" });
    if (!amount || amount < 1) return res.status(400).json({ success: false, error: "Amount must be >= 1" });

    const reference = "ORDER-" + Date.now();

    // Payload for Spawiko
    const payload = {
      payment_account_id: PAYMENT_ACCOUNT_ID,
      phone: formattedPhone,
      amount: Math.round(amount),
      reference,
      description: "Loan fee payment via Spawiko Gateway",
    };

    // Send request to Spawiko
    const resp = await axios.post("https://pay.spawiko.co.ke/api/v2/stkpush", payload, {
      headers: {
        "X-API-Key": SPAWIKO_API_KEY,
        "X-API-Secret": SPAWIKO_API_SECRET,
        "Content-Type": "application/json",
      },
    });

    console.log("Spawiko response:", resp.data);

    const receipts = readReceipts();

    if (resp.data.success) {
      const receiptData = {
        reference,
        transaction_id: resp.data.checkout_request_id || null,
        transaction_code: null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        customer_name: "N/A",
        status: "pending",
        status_note: `STK push sent to ${formattedPhone}. Please enter your M-Pesa PIN to complete the payment.`,
        timestamp: new Date().toISOString(),
      };

      receipts[reference] = receiptData;
      writeReceipts(receipts);

      res.json({ success: true, message: "STK push sent, check your phone", reference, receipt: receiptData });
    } else {
      const failed = {
        reference,
        transaction_id: null,
        transaction_code: null,
        amount: Math.round(amount),
        loan_amount: loan_amount || "50000",
        phone: formattedPhone,
        customer_name: "N/A",
        status: "stk_failed",
        status_note: resp.data.message || "Failed to send STK push.",
        timestamp: new Date().toISOString(),
      };
      receipts[reference] = failed;
      writeReceipts(receipts);
      res.status(400).json({ success: false, error: failed.status_note, receipt: failed });
    }
  } catch (err) {
    console.error("Payment initiation error:", err.message);
    const reference = "ORDER-" + Date.now();
    const { phone, amount, loan_amount } = req.body;
    const formattedPhone = formatPhone(phone);

    const errorReceipt = {
      reference,
      transaction_id: null,
      transaction_code: null,
      amount: amount ? Math.round(amount) : null,
      loan_amount: loan_amount || "50000",
      phone: formattedPhone,
      customer_name: "N/A",
      status: "error",
      status_note: "System error occurred. Please try again later.",
      timestamp: new Date().toISOString(),
    };
    const receipts = readReceipts();
    receipts[reference] = errorReceipt;
    writeReceipts(receipts);
    res.status(500).json({ success: false, error: err.message, receipt: errorReceipt });
  }
});

// 🟩 2️⃣ Callback (status updates)
app.post("/callback", async (req, res) => {
  console.log("Callback received:", req.body);
  const data = req.body;
  const ref = data.reference;
  let receipts = readReceipts();
  const existing = receipts[ref] || {};

  if (data.status === "completed") {
    receipts[ref] = {
      ...existing,
      status: "processing",
      transaction_code: data.transaction_code || null,
      status_note: `✅ Payment confirmed for ${existing.phone}. Your loan is being processed.`,
      timestamp: new Date().toISOString(),
    };
  } else {
    receipts[ref] = {
      ...existing,
      status: "cancelled",
      status_note: "❌ Payment failed or cancelled by user.",
      timestamp: new Date().toISOString(),
    };
  }

  writeReceipts(receipts);
  res.json({ ResultCode: 0, ResultDesc: "Success" });
});

// 🟩 3️⃣ Fetch Receipt
app.get("/receipt/:reference", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt) return res.status(404).json({ success: false, error: "Receipt not found" });
  res.json({ success: true, receipt });
});

// 🟩 4️⃣ PDF Receipt
app.get("/receipt/:reference/pdf", (req, res) => {
  const receipts = readReceipts();
  const receipt = receipts[req.params.reference];
  if (!receipt) return res.status(404).json({ success: false, error: "Receipt not found" });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename=receipt-${receipt.reference}.pdf`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  let color = "#2196F3";
  let mark = "PENDING";
  if (receipt.status === "processing") {
    mark = "PROCESSING";
    color = "#4CAF50";
  } else if (receipt.status === "cancelled") {
    mark = "FAILED";
    color = "#f44336";
  } else if (receipt.status === "loan_released") {
    mark = "RELEASED";
    color = "#4CAF50";
  }

  doc.rect(0, 0, doc.page.width, 80).fill(color);
  doc.fillColor("white").fontSize(22).text("💳 SPAWIKO LOAN RECEIPT", 50, 25);

  doc.moveDown(2);
  doc.fillColor("black").fontSize(14).text("Receipt Details", { underline: true });
  const details = [
    ["Reference", receipt.reference],
    ["Transaction ID", receipt.transaction_id || "N/A"],
    ["Transaction Code", receipt.transaction_code || "N/A"],
    ["Amount", `KES ${receipt.amount}`],
    ["Loan Amount", `KES ${receipt.loan_amount}`],
    ["Phone", receipt.phone],
    ["Status", receipt.status.toUpperCase()],
    ["Time", new Date(receipt.timestamp).toLocaleString()],
  ];
  details.forEach(([k, v]) => doc.fontSize(12).text(`${k}: ${v}`));
  doc.moveDown();
  if (receipt.status_note) doc.fontSize(12).fillColor("#555").text("Note: " + receipt.status_note);
  doc.end();
});

// 🟩 5️⃣ Auto loan release simulation
cron.schedule("*/5 * * * *", () => {
  const receipts = readReceipts();
  const now = Date.now();
  for (const ref in receipts) {
    const r = receipts[ref];
    if (r.status === "processing") {
      const releaseTime = new Date(r.timestamp).getTime() + 24 * 60 * 60 * 1000;
      if (now >= releaseTime) {
        r.status = "loan_released";
        r.status_note = "Loan has been released to your account. Thank you.";
        console.log(`✅ Released loan for ${ref}`);
      }
    }
  }
  writeReceipts(receipts);
});

// 🟩 Start server
app.listen(PORT, () => console.log(`🚀 Spawiko Server running on port ${PORT}`));
