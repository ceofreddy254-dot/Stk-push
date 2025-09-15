import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import PDFDocument from "pdfkit";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, ".")));

app.use(
  cors({
    origin: [
      "https://funny-tanuki-b344b5.netlify.app",
      "http://localhost:5000",
      "http://127.0.0.1:5000",
    ],
    credentials: true,
  })
);

// ========================
// Memory Stores
// ========================
const balances = {};
const users = {};
const phoneToEmail = {};
const transactions = {}; // { phone: [ {id, type, amount, status, timestamp} ] }

const API_KEY = process.env.SPAWIKO_API_KEY;
const API_SECRET = process.env.SPAWIKO_API_SECRET;
const PAYMENT_ACCOUNT_ID = process.env.SPAWIKO_ACCOUNT_ID || 17;

// ========================
// Helpers
// ========================
function createUser(email, phone) {
  users[email] = { email, phone };
  phoneToEmail[phone] = email;
  if (!balances[phone]) balances[phone] = 0;
  if (!transactions[phone]) transactions[phone] = [];
  return users[email];
}
function getUserByEmail(email) {
  return users[email];
}
function getUserByPhone(phone) {
  const email = phoneToEmail[phone];
  return email ? users[email] : null;
}
function creditBalance(phone, amount) {
  if (!balances[phone]) balances[phone] = 0;
  balances[phone] += Number(amount);
  return balances[phone];
}
function getBalance(phone) {
  return balances[phone] || 0;
}
function addTransaction(phone, tx) {
  if (!transactions[phone]) transactions[phone] = [];
  transactions[phone].push(tx);
}
function generateReceiptPDFBase64(receipt) {
  return new Promise((resolve) => {
    const doc = new PDFDocument();
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => {
      resolve(Buffer.concat(chunks).toString("base64"));
    });

    // Header
    doc.fontSize(20).fillColor("#2C3E50").text("PayFlow Receipt", { align: "center" });
    doc.moveDown();

    doc.fontSize(12).fillColor("#000").text(`Phone: ${receipt.phone}`);
    doc.text(`Amount: KSh ${receipt.amount}`);
    doc.text(`Status: ${receipt.status}`);
    doc.text(`Transaction ID: ${receipt.transaction_id}`);
    doc.text(`Reference: ${receipt.reference}`);
    doc.text(`Balance: KSh ${receipt.balance}`);
    doc.text(`Date: ${new Date(receipt.timestamp).toLocaleString()}`);

    // Stamp
    let stamp = receipt.status === "completed" ? "APPROVED" : "PENDING APPROVAL";
    let color = receipt.status === "completed" ? "green" : "orange";
    doc.moveDown(2);
    doc.fontSize(40).fillColor(color).text(stamp, { align: "center", opacity: 0.5 });

    doc.end();
  });
}

// ========================
// User Routes
// ========================
app.post("/api/users", (req, res) => {
  const { email, phone } = req.body;
  if (!email || !phone)
    return res.status(400).json({ success: false, message: "Email & phone required" });

  if (!phone.match(/^254[0-9]{9}$/))
    return res.status(400).json({ success: false, message: "Invalid phone format" });

  if (users[email] || phoneToEmail[phone])
    return res.status(409).json({ success: false, message: "User exists" });

  const user = createUser(email, phone);
  res.status(201).json({ success: true, user });
});

app.get("/api/users/email/:email", (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const user = getUserByEmail(email);
  if (!user) return res.status(404).json({ success: false, message: "User not found" });
  res.json({ success: true, ...user });
});

// ========================
// Deposit (STK Push)
// ========================
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount } = req.body;
    if (!phone || !amount)
      return res.status(400).json({ success: false, message: "Phone & amount required" });

    const user = getUserByPhone(phone);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const reference = `DEP_${Date.now()}`;
    const payload = {
      payment_account_id: PAYMENT_ACCOUNT_ID,
      phone,
      amount,
      reference,
      description: "Deposit",
    };

    const stkResponse = await axios.post(
      "https://pay.spawiko.co.ke/api/v2/stkpush.php",
      payload,
      {
        headers: {
          "X-API-Key": API_KEY,
          "X-API-Secret": API_SECRET,
          "Content-Type": "application/json",
        },
      }
    );

    if (!stkResponse.data.success) {
      return res.status(400).json(stkResponse.data);
    }

    // Simulate success immediately
    creditBalance(phone, amount);

    const receipt = {
      phone,
      amount,
      status: "completed",
      transaction_id: stkResponse.data.checkout_request_id,
      reference,
      balance: getBalance(phone),
      timestamp: new Date().toISOString(),
    };

    addTransaction(phone, {
      id: receipt.transaction_id,
      type: "deposit",
      amount,
      status: "success",
      timestamp: receipt.timestamp,
    });

    const pdf = await generateReceiptPDFBase64(receipt);
    res.json({ success: true, receipt, pdf });
  } catch (err) {
    console.error("STK Push Error:", err.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ========================
// Withdraw (Virtual Pending)
// ========================
app.post("/withdraw", async (req, res) => {
  try {
    const { phone, amount, pin } = req.body;
    if (!phone || !amount || !pin)
      return res.status(400).json({ success: false, message: "Phone, amount, pin required" });

    const user = getUserByPhone(phone);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    if (getBalance(phone) < amount)
      return res.status(400).json({ success: false, message: "Insufficient balance" });

    balances[phone] -= Number(amount);

    const receipt = {
      phone,
      amount,
      status: "pending",
      transaction_id: `WDR_${Date.now()}`,
      reference: `WITHDRAW_${Date.now()}`,
      balance: getBalance(phone),
      timestamp: new Date().toISOString(),
    };

    addTransaction(phone, {
      id: receipt.transaction_id,
      type: "withdraw",
      amount,
      status: "pending",
      timestamp: receipt.timestamp,
    });

    const pdf = await generateReceiptPDFBase64(receipt);
    res.json({ success: true, message: "Withdrawal pending approval", receipt, pdf });
  } catch (err) {
    console.error("Withdraw Error:", err.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ========================
// Check Balance
// ========================
app.post("/balance/check", (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, message: "Phone required" });
  const user = getUserByPhone(phone);
  if (!user) return res.status(404).json({ success: false, message: "User not found" });

  res.json({ success: true, balance: getBalance(phone) });
});

// ========================
// Transactions History
// ========================
app.post("/transactions", (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, message: "Phone required" });
  res.json({ success: true, transactions: transactions[phone] || [] });
});

// ========================
// Health
// ========================
app.get("/health", (req, res) => {
  res.json({ success: true, message: "Server running" });
});

// ========================
// Start
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));
