const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());

// ✅ Updated CORS to allow your frontend domains
app.use(cors({
  origin: [
    "https://starlit-haupia-69559a.netlify.app",
    "http://localhost:3000", 
    "https://*.replit.dev",
    "*" // Allow all origins for testing - remove in production
  ],
  credentials: true
}));

// Remove static file serving since you're hosting frontend separately
// app.use(express.static('public')); // ❌ Remove this line

// Load credentials from environment variables
const API_KEY = process.env.SPAWIKO_API_KEY;
const API_SECRET = process.env.SPAWIKO_API_SECRET;
const PAYMENT_ACCOUNT_ID = process.env.SPAWIKO_ACCOUNT_ID || 17;

// In-memory storage for payments (use database in production)
let payments = [];
let paymentCounter = 1000;

// Helper function to generate unique payment ID
function generatePaymentId() {
  return `PAY_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Helper function to get payment status from Spawiko
async function checkPaymentStatus(checkoutRequestId) {
  try {
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
    return statusResponse.data;
  } catch (error) {
    console.error("Status check error:", error.message);
    return { success: false, message: "Status check failed" };
  }
}

// ❌ Remove these routes since frontend is hosted separately
// app.get('/', (req, res) => {
//   res.sendFile(path.join(__dirname, 'public', 'index.html'));
// });

// app.get('/receipt', (req, res) => {
//   res.sendFile(path.join(__dirname, 'public', 'receipt.html'));
// });

// ========================
// Initiate STK Push + Enhanced Status Tracking
// ========================
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount, description = "Payment via M-Pesa" } = req.body;

    // Validation
    if (!phone || !amount) {
      return res.status(400).json({ 
        success: false, 
        message: "Phone and amount are required" 
      });
    }

    if (!phone.match(/^2547\d{8}$/)) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid phone number format. Use 2547XXXXXXXX" 
      });
    }

    if (Number(amount) <= 0 || Number(amount) > 300000) {
      return res.status(400).json({ 
        success: false, 
        message: "Amount must be between 1 and 300,000" 
      });
    }

    const paymentId = generatePaymentId();
    const reference = `ORDER_${Date.now()}`;

    // Create payment record
    const payment = {
      id: paymentId,
      phone,
      amount: Number(amount),
      reference,
      description,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      checkout_request_id: null,
      transaction_code: null,
      error_message: null
    };

    payments.push(payment);

    // --- Initiate STK Push ---
    const payload = {
      payment_account_id: PAYMENT_ACCOUNT_ID,
      phone,
      amount,
      reference,
      description
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
      // Update payment status to failed
      payment.status = 'failed';
      payment.error_message = stkResponse.data.message || 'STK Push initiation failed';
      payment.updated_at = new Date().toISOString();
      
      return res.status(400).json({
        success: false,
        message: payment.error_message,
        payment_id: paymentId
      });
    }

    const checkoutRequestId = stkResponse.data.checkout_request_id;
    payment.checkout_request_id = checkoutRequestId;
    payment.updated_at = new Date().toISOString();

    // --- Poll Payment Status ---
    const maxAttempts = 24; // 2 minutes (5s * 24)
    let attempt = 0;
    let statusResult = null;

    while (attempt < maxAttempts) {
      statusResult = await checkPaymentStatus(checkoutRequestId);

      if (statusResult.success) {
        if (statusResult.status === "completed") {
          payment.status = 'completed';
          payment.transaction_code = statusResult.transaction_code;
          payment.updated_at = new Date().toISOString();
          
          return res.json({
            success: true,
            message: "Payment completed successfully",
            payment_id: paymentId,
            transaction_code: statusResult.transaction_code,
            phone,
            amount,
            reference,
            checkout_request_id: checkoutRequestId
          });
        } else if (statusResult.status === "failed") {
          payment.status = 'failed';
          payment.error_message = statusResult.message || 'Payment failed';
          payment.updated_at = new Date().toISOString();
          
          return res.json({
            success: false,
            message: payment.error_message,
            payment_id: paymentId,
            phone,
            amount,
            reference,
            checkout_request_id: checkoutRequestId
          });
        }
      }

      attempt++;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // Timeout - mark as pending
    payment.status = 'timeout';
    payment.error_message = 'Payment status check timeout';
    payment.updated_at = new Date().toISOString();

    res.json({
      success: false,
      message: "Payment status check timeout. Please check manually.",
      payment_id: paymentId,
      phone,
      amount,
      reference,
      checkout_request_id: checkoutRequestId,
      lastStatus: statusResult
    });

  } catch (err) {
    console.error("STK Push Error:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Internal server error",
      error: err.message 
    });
  }
});

// ========================
// Get All Payments with Filters
// ========================
app.get("/payments", (req, res) => {
  try {
    const { 
      status, 
      phone, 
      from_date, 
      to_date, 
      limit = 50, 
      offset = 0 
    } = req.query;

    let filteredPayments = [...payments];

    // Filter by status
    if (status && status !== 'all') {
      filteredPayments = filteredPayments.filter(p => p.status === status);
    }

    // Filter by phone
    if (phone) {
      filteredPayments = filteredPayments.filter(p => 
        p.phone.includes(phone.replace(/\s/g, ''))
      );
    }

    // Filter by date range
    if (from_date) {
      filteredPayments = filteredPayments.filter(p => 
        new Date(p.created_at) >= new Date(from_date)
      );
    }
    if (to_date) {
      filteredPayments = filteredPayments.filter(p => 
        new Date(p.created_at) <= new Date(to_date)
      );
    }

    // Sort by creation date (newest first)
    filteredPayments.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Pagination
    const total = filteredPayments.length;
    const paginatedPayments = filteredPayments.slice(
      parseInt(offset), 
      parseInt(offset) + parseInt(limit)
    );

    res.json({
      success: true,
      payments: paginatedPayments,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

  } catch (err) {
    console.error("Get payments error:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch payments" 
    });
  }
});

// ========================
// Get Single Payment by ID
// ========================
app.get("/payments/:id", (req, res) => {
  try {
    const { id } = req.params;
    const payment = payments.find(p => p.id === id);

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found"
      });
    }

    res.json({
      success: true,
      payment
    });

  } catch (err) {
    console.error("Get payment error:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch payment" 
    });
  }
});

// ========================
// Manual Status Check for Pending Payments
// ========================
app.post("/payments/:id/check-status", async (req, res) => {
  try {
    const { id } = req.params;
    const payment = payments.find(p => p.id === id);

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: "Payment not found"
      });
    }

    if (!payment.checkout_request_id) {
      return res.status(400).json({
        success: false,
        message: "No checkout request ID found for this payment"
      });
    }

    const statusResult = await checkPaymentStatus(payment.checkout_request_id);

    if (statusResult.success) {
      if (statusResult.status === "completed") {
        payment.status = 'completed';
        payment.transaction_code = statusResult.transaction_code;
        payment.updated_at = new Date().toISOString();
      } else if (statusResult.status === "failed") {
        payment.status = 'failed';
        payment.error_message = statusResult.message || 'Payment failed';
        payment.updated_at = new Date().toISOString();
      }
    }

    res.json({
      success: true,
      payment,
      status_check_result: statusResult
    });

  } catch (err) {
    console.error("Status check error:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Failed to check payment status" 
    });
  }
});

// ========================
// Payment Statistics
// ========================
app.get("/payments/stats", (req, res) => {
  try {
    const stats = {
      total_payments: payments.length,
      completed: payments.filter(p => p.status === 'completed').length,
      pending: payments.filter(p => p.status === 'pending').length,
      failed: payments.filter(p => p.status === 'failed').length,
      timeout: payments.filter(p => p.status === 'timeout').length,
      total_amount: payments
        .filter(p => p.status === 'completed')
        .reduce((sum, p) => sum + p.amount, 0)
    };

    res.json({
      success: true,
      stats
    });

  } catch (err) {
    console.error("Stats error:", err.message);
    res.status(500).json({ 
      success: false, 
      message: "Failed to fetch statistics" 
    });
  }
});

// ========================
// Health Check
// ========================
app.get("/health", (req, res) => {
  res.json({ 
    success: true, 
    message: "Server is running",
    timestamp: new Date().toISOString(),
    payments_count: payments.length
  });
});

// ========================
// Start Server
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 M-Pesa Payment Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});
