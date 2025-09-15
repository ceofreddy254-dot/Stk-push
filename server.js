import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ✅ Serve static files
app.use(express.static(path.join(__dirname, "public")));

// ✅ Allow requests from multiple origins
app.use(
  cors({
    origin:
      process.env.NODE_ENV === "development"
        ? ["http://localhost:5000", "http://127.0.0.1:5000"]
        : ["https://radiant-souffle-6d1711.netlify.app"],
    credentials: true,
  })
);

// ========================
// Load credentials
// ========================
const API_KEY = process.env.SPAWIKO_API_KEY;
const API_SECRET = process.env.SPAWIKO_API_SECRET;
const PAYMENT_ACCOUNT_ID = process.env.SPAWIKO_ACCOUNT_ID || 17;

// ========================
// In-memory + JSON DB
// ========================
const balances = {}; // { phone: balance }
const users = {}; // { email: { phone, email } }
const phoneToEmail = {}; // { phone: email }
const DB_FILE = path.join(__dirname, "db.json");

// Load from JSON at startup
function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    Object.assign(balances, data.balances || {});
    Object.assign(users, data.users || {});
    Object.assign(phoneToEmail, data.phoneToEmail || {});
  }
}

// Save to JSON
function saveDB() {
  const data = { balances, users, phoneToEmail };
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// Load DB initially
loadDB();

// ========================
// Helpers
// ========================
function formatError(message, details = null) {
  return { success: false, message, details };
}

function createUser(email, phone) {
  users[email] = { email, phone };
  phoneToEmail[phone] = email;
  if (!balances[phone]) balances[phone] = 0;
  saveDB();
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
  saveDB();
  return balances[phone];
}

function getBalance(phone) {
  return balances[phone] || 0;
}

// ========================
// User Registration
// ========================
app.post("/api/users", (req, res) => {
  try {
    const { email, phone } = req.body;

    if (!email || !phone) {
      return res.status(400).json(formatError("Email and phone number are required"));
    }

    if (!phone.match(/^254[0-9]{9}$/)) {
      return res
        .status(400)
        .json(formatError("Invalid phone number format. Use 254XXXXXXXXX"));
    }

    if (users[email] || phoneToEmail[phone]) {
      return res
        .status(409)
        .json(formatError("User already exists with this email or phone number"));
    }

    const user = createUser(email, phone);

    res.status(201).json({
      success: true,
      message: "User created successfully",
      user: { email: user.email, phone: user.phone },
    });
  } catch (err) {
    console.error("User registration error:", err.message);
    res.status(500).json(formatError("Internal server error", err.message));
  }
});

// ========================
// Get User by Email
// ========================
app.get("/api/users/email/:email", (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const user = getUserByEmail(email);

    if (!user) {
      return res.status(404).json(formatError("User not found"));
    }

    res.json({
      success: true,
      email: user.email,
      phone: user.phone,
    });
  } catch (err) {
    console.error("Get user error:", err.message);
    res.status(500).json(formatError("Internal server error", err.message));
  }
});

// ========================
// STK Push (non-blocking)
// ========================
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount } = req.body;

    if (!phone || !amount) {
      return res.status(400).json(formatError("Phone and amount are required"));
    }

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json(formatError("Invalid amount"));
    }

    const user = getUserByPhone(phone);
    if (!user) {
      return res
        .status(404)
        .json(formatError("User not found. Please sign up first."));
    }

    const reference = `ORDER_${Date.now()}`;

    const payload = {
      payment_account_id: PAYMENT_ACCOUNT_ID,
      phone,
      amount,
      reference,
      description: "PayFlow Deposit via M-Pesa",
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
      return res
        .status(400)
        .json(formatError("STK push failed", stkResponse.data));
    }

    const checkoutRequestId = stkResponse.data.checkout_request_id;

    return res.json({
      success: true,
      message: "STK push initiated. Awaiting confirmation...",
      checkout_request_id: checkoutRequestId,
      reference,
      phone,
      amount,
    });
  } catch (err) {
    console.error("STK Push Error:", err.message);
    return res.status(500).json(formatError("Internal server error", err.message));
  }
});

// ========================
// Transaction Status
// ========================
app.post("/transaction/status", async (req, res) => {
  try {
    const { checkout_request_id, phone, amount } = req.body;

    if (!checkout_request_id) {
      return res.status(400).json(formatError("checkout_request_id is required"));
    }

    const statusResponse = await axios.post(
      "https://pay.spawiko.co.ke/api/v2/status.php",
      { checkout_request_id },
      {
        headers: {
          "X-API-Key": API_KEY,
          "X-API-Secret": API_SECRET,
          "Content-Type": "application/json",
        },
      }
    );

    const statusResult = statusResponse.data;

    if (statusResult.success) {
      if (statusResult.status === "completed" && phone && amount) {
        creditBalance(phone, amount);
      }

      return res.json({
        success: true,
        status: statusResult.status,
        transaction_code: statusResult.transaction_code || null,
        checkout_request_id,
        balance: phone ? getBalance(phone) : undefined,
        message: `Transaction is ${statusResult.status}`,
      });
    } else {
      return res.json(
        formatError("Failed to check transaction status", statusResult)
      );
    }
  } catch (err) {
    console.error("Status Check Error:", err.message);
    res.status(500).json(formatError("Internal server error", err.message));
  }
});

// ========================
// Balance Check
// ========================
app.post("/balance/check", (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json(formatError("Phone number is required"));
    }

    const user = getUserByPhone(phone);
    if (!user) {
      return res.status(404).json(formatError("User not found"));
    }

    const balance = getBalance(phone);

    res.json({
      success: true,
      balance,
      currency: "KSh",
      phone,
      timestamp: new Date().toISOString(),
      message: "Balance retrieved successfully",
    });
  } catch (err) {
    console.error("Balance Check Error:", err.message);
    res.status(500).json(formatError("Internal server error", err.message));
  }
});

// ========================
// Get All Users
// ========================
app.get("/api/users", (req, res) => {
  try {
    const userList = Object.values(users).map((user) => ({
      email: user.email,
      phone: user.phone,
      balance: getBalance(user.phone),
    }));

    res.json({
      success: true,
      users: userList,
      total: userList.length,
    });
  } catch (err) {
    console.error("Get users error:", err.message);
    res.status(500).json(formatError("Internal server error", err.message));
  }
});

// ========================
// Health Check
// ========================
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "PayFlow Server is running",
    timestamp: new Date().toISOString(),
    totalUsers: Object.keys(users).length,
    totalBalance: Object.values(balances).reduce((sum, bal) => sum + bal, 0),
  });
});

// ========================
// Start Server
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PayFlow Server running on port ${PORT}`);
  console.log(
    `📱 Ready to handle Firebase authentication and M-Pesa transactions`
  );
});
