import express from "express";
import axios from "axios";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ✅ Serve static files (index.html, etc.)
app.use(express.static(path.join(__dirname, '.')));

// ✅ Allow requests from multiple origins for development and production
app.use(cors({
  origin: [
    "https://aesthetic-taiyaki-9db70d.netlify.app",
    "https://radiant-frangollo-1c8aad.netlify.app",
    "http://0.0.0.0:5000",
    "http://127.0.0.1:5000"
  ],
  credentials: true
}));

// Load credentials from Environment Variables
const API_KEY = process.env.SPAWIKO_API_KEY;
const API_SECRET = process.env.SPAWIKO_API_SECRET;
const PAYMENT_ACCOUNT_ID = process.env.SPAWIKO_ACCOUNT_ID || 17;

// ========================
// In-memory stores
// ========================
const users = {}; // { email: { phone, email } }
const phoneToEmail = {}; // { phone: email }

// Helper functions for user management
function createUser(email, phone) {
  users[email] = { email, phone };
  phoneToEmail[phone] = email;
  return users[email];
}

function getUserByEmail(email) {
  return users[email];
}

function getUserByPhone(phone) {
  const email = phoneToEmail[phone];
  return email ? users[email] : null;
}

// ========================
// Helper: Generate Receipt
// ========================
function generateReceipt({ phone, amount, reference, transaction_code, checkout_request_id }) {
  return {
    receipt_id: `RCPT_${Date.now()}`,
    transaction_code: transaction_code || null,
    reference,
    phone,
    amount,
    currency: "KSh",
    checkout_request_id,
    timestamp: new Date().toISOString(),
    note: "Your loan fee payment is completed, the loan disbursement has started. It may take less than 10 minutes."
  };
}

// ========================
// User Registration Endpoint
// ========================
app.post("/api/users", (req, res) => {
  try {
    const { email, phone } = req.body;

    if (!email || !phone) {
      return res.status(400).json({ 
        success: false, 
        message: "Email and phone number are required" 
      });
    }

    // Validate phone format
    if (!phone.match(/^254[0-9]{9}$/)) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid phone number format. Use 254XXXXXXXXX" 
      });
    }

    // Check if user already exists
    if (users[email] || phoneToEmail[phone]) {
      return res.status(409).json({ 
        success: false, 
        message: "User already exists with this email or phone number" 
      });
    }

    // Create user
    const user = createUser(email, phone);
    
    res.status(201).json({ 
      success: true,
      message: "User created successfully",
      user: { email: user.email, phone: user.phone }
    });

  } catch (err) {
    console.error("User registration error:", err.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ========================
// Get User by Email (for login)
// ========================
app.get("/api/users/email/:email", (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);
    const user = getUserByEmail(email);
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: "User not found" 
      });
    }

    res.json({ 
      success: true,
      email: user.email,
      phone: user.phone 
    });

  } catch (err) {
    console.error("Get user error:", err.message);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ========================
// Initiate STK Push + Poll Status
// ========================
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount } = req.body;

    if (!phone || !amount) {
      return res.status(400).json({ success: false, message: "Phone and amount are required" });
    }

    // Validate that user exists
    const user = getUserByPhone(phone);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found. Please sign up first." });
    }

    const reference = `ORDER_${Date.now()}`;

    // --- Initiate STK Push ---
    const payload = {
      payment_account_id: PAYMENT_ACCOUNT_ID,
      phone,
      amount,
      reference,
      description: "Loan Fee Payment via M-Pesa"
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
          const receipt = generateReceipt({
            phone,
            amount,
            reference,
            transaction_code: statusResult.transaction_code,
            checkout_request_id: checkoutRequestId
          });

          return res.json({
            success: true,
            message: "Loan fee completed",
            receipt
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
    const { checkout_request_id, phone, amount } = req.body;

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
      if (statusResult.status === "completed" && phone && amount) {
        const receipt = generateReceipt({
          phone,
          amount,
          reference: req.body.reference || null,
          transaction_code: statusResult.transaction_code,
          checkout_request_id
        });

        return res.json({
          success: true,
          message: "Loan fee completed",
          receipt
        });
      }

      return res.json({
        success: true,
        status: statusResult.status,
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
// Get All Users (for admin purposes)
// ========================
app.get("/api/users", (req, res) => {
  try {
    const userList = Object.values(users).map(user => ({
      email: user.email,
      phone: user.phone
    }));
    
    res.json({ 
      success: true,
      users: userList,
      total: userList.length
    });

  } catch (err) {
    console.error("Get users error:", err.message);
    res.status(500).json({ success: false, message: "Internal server error" });
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
    totalUsers: Object.keys(users).length
  });
});

// ========================
// Start Server
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PayFlow Server running on port ${PORT}`);
  console.log(`📱 Ready to handle Firebase authentication and M-Pesa transactions`);
});
