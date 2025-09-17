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
    "https://payment254test.netlify.app",
    "https://aesthetic-dolphin-cd6fba.netlify.app", // Add your actual Netlify domain
    "https://aesthetic-dolphin-cd6fba.netlify.app", 
    "https://*.replit.dev",
    "*" // Remove in production
  ],
  credentials: true
}));

// Load credentials from environment variables
const API_KEY = process.env.SPAWIKO_API_KEY;
const API_SECRET = process.env.SPAWIKO_API_SECRET;
const PAYMENT_ACCOUNT_ID = process.env.SPAWIKO_ACCOUNT_ID || 17;

// 🆕 File-based persistent storage
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');

// 🆕 Load payments from file on startup
let payments = [];
function loadPayments() {
  try {
    if (fs.existsSync(PAYMENTS_FILE)) {
      const data = fs.readFileSync(PAYMENTS_FILE, 'utf8');
      payments = JSON.parse(data);
      console.log(`📥 Loaded ${payments.length} payments from storage`);
    } else {
      console.log('📄 No existing payments file found, starting fresh');
    }
  } catch (error) {
    console.error('❌ Error loading payments:', error.message);
    payments = [];
  }
}

// 🆕 Save payments to file
function savePayments() {
  try {
    fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(payments, null, 2));
    console.log(`💾 Saved ${payments.length} payments to storage`);
  } catch (error) {
    console.error('❌ Error saving payments:', error.message);
  }
}

// 🆕 Load payments on startup
loadPayments();

let paymentCounter = payments.length + 1000;

// Helper function to generate unique payment ID
function generatePaymentId() {
  return `PAY_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Helper function to get payment status from Spawiko
async function checkPaymentStatus(checkoutRequestId) {
  try {
    console.log(`🔍 Checking payment status for: ${checkoutRequestId}`);
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
    console.log('📊 Status check response:', statusResponse.data);
    return statusResponse.data;
  } catch (error) {
    console.error("❌ Status check error:", error.message);
    return { success: false, message: "Status check failed" };
  }
}

// 🆕 Enhanced logging middleware
app.use((req, res, next) => {
  console.log(`📝 ${new Date().toISOString()} - ${req.method} ${req.url}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('📤 Request body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// ========================
// Initiate STK Push + Enhanced Status Tracking
// ========================
app.post("/stkpush", async (req, res) => {
  console.log('\n🚀 STK Push initiated');
  try {
    const { phone, amount, description = "Payment via M-Pesa" } = req.body;
    console.log(`📱 Payment request: ${phone}, KES ${amount}`);

    // Validation
    if (!phone || !amount) {
      console.log('❌ Validation failed: Missing phone or amount');
      return res.status(400).json({ 
        success: false, 
        message: "Phone and amount are required" 
      });
    }

    if (!phone.match(/^2547\d{8}$/)) {
      console.log('❌ Validation failed: Invalid phone format');
      return res.status(400).json({ 
        success: false, 
        message: "Invalid phone number format. Use 2547XXXXXXXX" 
      });
    }

    if (Number(amount) <= 0 || Number(amount) > 300000) {
      console.log('❌ Validation failed: Invalid amount');
      return res.status(400).json({ 
        success: false, 
        message: "Amount must be between 1 and 300,000" 
      });
    }

    const paymentId = generatePaymentId();
    const reference = `ORDER_${Date.now()}`;
    console.log(`🆔 Generated payment ID: ${paymentId}`);

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
    savePayments(); // 🆕 Save to file immediately
    console.log(`📊 Payment stored. Total payments: ${payments.length}`);

    // --- Initiate STK Push ---
    const payload = {
      payment_account_id: PAYMENT_ACCOUNT_ID,
      phone,
      amount,
      reference,
      description
    };

    console.log('📤 Sending STK Push to Spawiko API');
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

    console.log('📥 STK Push response:', stkResponse.data);

    if (!stkResponse.data.success) {
      // Update payment status to failed
      payment.status = 'failed';
      payment.error_message = stkResponse.data.message || 'STK Push initiation failed';
      payment.updated_at = new Date().toISOString();
      savePayments(); // 🆕 Save updated status
      
      console.log(`❌ STK Push failed: ${payment.error_message}`);
      return res.status(400).json({
        success: false,
        message: payment.error_message,
        payment_id: paymentId
      });
    }

    const checkoutRequestId = stkResponse.data.checkout_request_id;
    payment.checkout_request_id = checkoutRequestId;
    payment.updated_at = new Date().toISOString();
    savePayments(); // 🆕 Save checkout request ID

    console.log(`✅ STK Push successful. Checkout ID: ${checkoutRequestId}`);
    console.log('⏳ Starting payment status polling...');

    // --- Poll Payment Status ---
    const maxAttempts = 24; // 2 minutes (5s * 24)
    let attempt = 0;
    let statusResult = null;

    while (attempt < maxAttempts) {
      console.log(`🔄 Status check attempt ${attempt + 1}/${maxAttempts}`);
      statusResult = await checkPaymentStatus(checkoutRequestId);

      if (statusResult.success) {
        if (statusResult.status === "completed") {
          payment.status = 'completed';
          payment.transaction_code = statusResult.transaction_code;
          payment.updated_at = new Date().toISOString();
          savePayments(); // 🆕 Save completed status
          
          console.log(`✅ Payment completed! Transaction code: ${statusResult.transaction_code}`);
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
          savePayments(); // 🆕 Save failed status
          
          console.log(`❌ Payment failed: ${payment.error_message}`);
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
      if (attempt < maxAttempts) {
        console.log('⏳ Waiting 5 seconds before next status check...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    // Timeout - mark as pending
    payment.status = 'timeout';
    payment.error_message = 'Payment status check timeout';
    payment.updated_at = new Date().toISOString();
    savePayments(); // 🆕 Save timeout status

    console.log('⏰ Payment status check timeout');
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
    console.error("🚨 STK Push Error:", err.message);
    console.error("📋 Error stack:", err.stack);
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
  console.log('\n📊 Fetching payments with filters:', req.query);
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
    console.log(`📋 Starting with ${filteredPayments.length} total payments`);

    // Filter by status
    if (status && status !== 'all') {
      const beforeCount = filteredPayments.length;
      filteredPayments = filteredPayments.filter(p => p.status === status);
      console.log(`🔍 Status filter (${status}): ${beforeCount} → ${filteredPayments.length}`);
    }

    // Filter by phone
    if (phone) {
      const beforeCount = filteredPayments.length;
      filteredPayments = filteredPayments.filter(p => 
        p.phone.includes(phone.replace(/\s/g, ''))
      );
      console.log(`📱 Phone filter (${phone}): ${beforeCount} → ${filteredPayments.length}`);
    }

    // Filter by date range
    if (from_date) {
      const beforeCount = filteredPayments.length;
      filteredPayments = filteredPayments.filter(p => 
        new Date(p.created_at) >= new Date(from_date)
      );
      console.log(`📅 From date filter (${from_date}): ${beforeCount} → ${filteredPayments.length}`);
    }
    if (to_date) {
      const beforeCount = filteredPayments.length;
      filteredPayments = filteredPayments.filter(p => 
        new Date(p.created_at) <= new Date(to_date)
      );
      console.log(`📅 To date filter (${to_date}): ${beforeCount} → ${filteredPayments.length}`);
    }

    // Sort by creation date (newest first)
    filteredPayments.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Pagination
    const total = filteredPayments.length;
    const paginatedPayments = filteredPayments.slice(
      parseInt(offset), 
      parseInt(offset) + parseInt(limit)
    );

    console.log(`📄 Pagination: offset=${offset}, limit=${limit}, returning ${paginatedPayments.length} payments`);

    const response = {
      success: true,
      payments: paginatedPayments,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    };

    console.log('✅ Payments response prepared');
    res.json(response);

  } catch (err) {
    console.error("❌ Get payments error:", err.message);
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
  console.log(`\n🔍 Fetching payment by ID: ${req.params.id}`);
  try {
    const { id } = req.params;
    const payment = payments.find(p => p.id === id);

    if (!payment) {
      console.log('❌ Payment not found');
      return res.status(404).json({
        success: false,
        message: "Payment not found"
      });
    }

    console.log('✅ Payment found');
    res.json({
      success: true,
      payment
    });

  } catch (err) {
    console.error("❌ Get payment error:", err.message);
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
  console.log(`\n🔄 Manual status check for payment: ${req.params.id}`);
  try {
    const { id } = req.params;
    const payment = payments.find(p => p.id === id);

    if (!payment) {
      console.log('❌ Payment not found');
      return res.status(404).json({
        success: false,
        message: "Payment not found"
      });
    }

    if (!payment.checkout_request_id) {
      console.log('❌ No checkout request ID found');
      return res.status(400).json({
        success: false,
        message: "No checkout request ID found for this payment"
      });
    }

    console.log(`🔍 Checking status for checkout ID: ${payment.checkout_request_id}`);
    const statusResult = await checkPaymentStatus(payment.checkout_request_id);

    if (statusResult.success) {
      const oldStatus = payment.status;
      if (statusResult.status === "completed") {
        payment.status = 'completed';
        payment.transaction_code = statusResult.transaction_code;
        payment.updated_at = new Date().toISOString();
        savePayments(); // 🆕 Save updated status
        console.log(`✅ Status updated: ${oldStatus} → completed`);
      } else if (statusResult.status === "failed") {
        payment.status = 'failed';
        payment.error_message = statusResult.message || 'Payment failed';
        payment.updated_at = new Date().toISOString();
        savePayments(); // 🆕 Save updated status
        console.log(`❌ Status updated: ${oldStatus} → failed`);
      }
    }

    res.json({
      success: true,
      payment,
      status_check_result: statusResult
    });

  } catch (err) {
    console.error("❌ Status check error:", err.message);
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
  console.log('\n📈 Generating payment statistics');
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

    console.log('📊 Stats generated:', stats);
    res.json({
      success: true,
      stats
    });

  } catch (err) {
    console.error("❌ Stats error:", err.message);
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
  console.log('💓 Health check requested');
  const healthData = {
    success: true, 
    message: "Server is running",
    timestamp: new Date().toISOString(),
    payments_count: payments.length,
    uptime: process.uptime(),
    memory_usage: process.memoryUsage(),
    environment: {
      node_version: process.version,
      platform: process.platform
    }
  };
  
  console.log('✅ Health check response:', healthData);
  res.json(healthData);
});

// 🆕 Debug endpoint to view all payments (remove in production)
app.get("/debug/payments", (req, res) => {
  console.log('🐛 Debug: All payments requested');
  res.json({
    success: true,
    payments: payments,
    count: payments.length,
    file_path: PAYMENTS_FILE
  });
});

// ========================
// Error handling middleware
// ========================
app.use((err, req, res, next) => {
  console.error('🚨 Unhandled error:', err.message);
  console.error('📋 Error stack:', err.stack);
  res.status(500).json({
    success: false,
    message: "Internal server error",
    error: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// ========================
// Start Server
// ========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n🚀 M-Pesa Payment Server Started!');
  console.log(`📍 Port: ${PORT}`);
  console.log(`💾 Payments file: ${PAYMENTS_FILE}`);
  console.log(`📊 Loaded payments: ${payments.length}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`🐛 Debug endpoint: http://localhost:${PORT}/debug/payments`);
  console.log('=' .repeat(50));
});

// 🆕 Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('\n⏹️  Received SIGTERM, saving payments and shutting down gracefully');
  savePayments();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n⏹️  Received SIGINT, saving payments and shutting down gracefully');
  savePayments();
  process.exit(0);
});

// 🆕 Auto-save payments every 30 seconds (backup)
setInterval(() => {
  savePayments();
}, 30000);
