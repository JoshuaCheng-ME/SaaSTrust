const express = require('express');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Resend } = require('resend');

// 引入 MySQL 数据库连接
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Resend API 配置
const resend = new Resend(process.env.RESEND_API_KEY || 'resend_api_key_placeholder');

// Multer 文件上传配置
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'public', 'uploads');
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'proof-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// 初始化数据库表
async function initDB() {
  try {
    // Users table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTO_INCREMENT,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL,
        linkedin_profile TEXT,
        industry VARCHAR(100) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    
    // Campaigns table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTO_INCREMENT,
        employer_id INTEGER NOT NULL,
        platform VARCHAR(100),
        product_name VARCHAR(255) NOT NULL,
        product_url TEXT,
        industry VARCHAR(100) NOT NULL,
        budget_usd DECIMAL(10,2),
        total_slots INTEGER,
        status VARCHAR(50) DEFAULT 'pending_payment',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employer_id) REFERENCES users(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    
    // Applications table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS applications (
        id INTEGER PRIMARY KEY AUTO_INCREMENT,
        reviewer_id INTEGER NOT NULL,
        campaign_id INTEGER NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        screenshot_url TEXT,
        gift_card_code VARCHAR(100),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (reviewer_id) REFERENCES users(id),
        FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Create admin user if not exists
    const [adminRows] = await db.execute('SELECT id FROM users WHERE email = ?', ['admin@saastrust.net']);
    if (adminRows.length === 0) {
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      await db.execute('INSERT INTO users (email, password, role, industry) VALUES (?, ?, ?, ?)',
        ['admin@saastrust.net', hashedPassword, 'admin', 'Admin']);
      console.log('Admin user created: admin@saastrust.net / admin123');
    }

    console.log('Database initialized successfully');
  } catch (err) {
    console.error('Database initialization failed:', err);
  }
}

// 中间件配置
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'saastrust-secret-key-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// 确保上传目录存在
const uploadDir = path.join(__dirname, 'public', 'uploads');
const fs = require('fs');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 认证中间件
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user || req.session.user.role !== role) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// 发送礼品卡邮件
async function sendGiftCardEmail(email, giftCardCode, productName) {
  try {
    await resend.emails.send({
      from: 'SaaSTrust <no-reply@saastrust.net>',
      to: email,
      subject: 'Your Amazon Gift Card - SaaSTrust Review Reward',
      html: `<p>Thank you for reviewing ${productName}!</p><p>Your Amazon gift card code: <strong>${giftCardCode}</strong></p>`
    });
    return true;
  } catch (err) {
    console.error('Failed to send email:', err);
    return false;
  }
}

// 🔓 Public & General Routes

// 首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 用户注册
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, role, linkedin_profile, industry } = req.body;
    
    console.log('Registration attempt:', { email, role, industry });
    
    if (!email || !password || !role || !industry || !linkedin_profile) {
      return res.status(400).json({ error: 'Missing required fields. All fields including LinkedIn profile are required.' });
    }
    
    if (role !== 'employer' && role !== 'reviewer') {
      return res.status(400).json({ error: 'Invalid role. Must be employer or reviewer.' });
    }
    
    const hashedPassword = bcrypt.hashSync(password, 10);
    
    await db.execute(`INSERT INTO users (email, password, role, linkedin_profile, industry) VALUES (?, ?, ?, ?, ?)`,
      [email, hashedPassword, role, linkedin_profile, industry]);
    res.status(201).json({ message: 'Registration successful', role });
  } catch (err) {
    console.error('Registration error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      return res.status(500).json({ error: 'Database access denied. Check credentials.' });
    }
    if (err.code === 'ER_BAD_DB_ERROR') {
      return res.status(500).json({ error: 'Database does not exist.' });
    }
    return res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

// 用户登录
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const [users] = await db.execute('SELECT * FROM users WHERE email = ?', [email]);
    
    if (users.length === 0 || !bcrypt.compareSync(password, users[0].password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = users[0];
    req.session.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      industry: user.industry
    };
    
    res.json({ message: 'Login successful', role: user.role });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Database connection error. Please try again.' });
  }
});

// 登出
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: 'Logout successful' });
});

// 获取当前用户
app.get('/api/auth/user', requireAuth, (req, res) => {
  res.json(req.session.user);
});

// 🏢 Employer (B-End) Operations

// 创建新活动
app.post('/api/client/campaign', requireAuth, requireRole('employer'), async (req, res) => {
  const { product_name, target_site, req_industry, total_slots } = req.body;
  
  if (!product_name || !target_site || !req_industry || !total_slots) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    const [result] = await db.execute(`INSERT INTO campaigns (employer_id, platform, product_name, industry, total_slots) VALUES (?, ?, ?, ?, ?)`,
      [req.session.user.id, target_site, product_name, req_industry, total_slots]);
    
    const gumroadLink = `https://saastrust.gumroad.com/l/campaign-${result.insertId}`;
    res.json({ 
      message: 'Campaign created successfully', 
      campaign_id: result.insertId,
      status: 'pending_payment',
      payment_link: gumroadLink
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create campaign' });
  }
});

// 雇主确认已汇款
app.post('/api/client/campaign/:id/wire-confirm', requireAuth, requireRole('employer'), async (req, res) => {
  const campaignId = parseInt(req.params.id);
  const employerId = req.session.user.id;
  
  // 验证活动属于当前雇主
  const [campaigns] = await db.execute(`SELECT * FROM campaigns WHERE id = ? AND employer_id = ?`, [campaignId, employerId]);
  
  if (campaigns.length === 0) {
    return res.status(404).json({ error: 'Campaign not found' });
  }
  
  // 更新状态为 pending_payment
  await db.execute(`UPDATE campaigns SET status = 'pending_payment' WHERE id = ?`, [campaignId]);
  res.json({ message: 'Notification sent to Admin. Awaiting verification.' });
});

// 获取我的活动
app.get('/api/client/my-jobs', requireAuth, requireRole('employer'), async (req, res) => {
  const employerId = req.session.user.id;
  
  const [campaigns] = await db.execute(`
    SELECT c.*,
           COUNT(a.id) as total_applications,
           SUM(CASE WHEN a.status = 'submitted' THEN 1 ELSE 0 END) as pending_proofs,
           SUM(CASE WHEN a.status = 'paid' THEN 1 ELSE 0 END) as completed_reviews
    FROM campaigns c
    LEFT JOIN applications a ON c.id = a.campaign_id
    WHERE c.employer_id = ?
    GROUP BY c.id
    ORDER BY c.id DESC
  `, [employerId]);
  
  res.json(campaigns);
});

// 👩‍💻 Reviewer (A-End) Smart-Matching

// 智能匹配任务
app.get('/api/tester/matched', requireAuth, requireRole('reviewer'), async (req, res) => {
  const reviewerIndustry = req.session.user.industry;
  
  const [campaigns] = await db.execute(`
    SELECT c.*,
           COUNT(a.id) as current_applications
    FROM campaigns c
    LEFT JOIN applications a ON c.id = a.campaign_id
    WHERE c.industry = ? AND c.status = 'active'
    GROUP BY c.id
    ORDER BY c.id DESC
  `, [reviewerIndustry]);
  
  res.json(campaigns);
});

// 申请任务
app.post('/api/tester/apply', requireAuth, requireRole('reviewer'), async (req, res) => {
  const { campaign_id } = req.body;
  
  // 检查是否已申请过此任务
  const [existing] = await db.execute(`SELECT id FROM applications WHERE campaign_id = ? AND reviewer_id = ?`,
    [campaign_id, req.session.user.id]);
  
  if (existing.length > 0) {
    return res.status(400).json({ error: 'You have already applied for this campaign' });
  }
  
  const [result] = await db.execute(`INSERT INTO applications (reviewer_id, campaign_id, status) VALUES (?, ?, 'pending')`,
    [req.session.user.id, campaign_id]);
  
  res.json({ message: 'Application submitted successfully', application_id: result.insertId });
});

// 提交证明
app.post('/api/tester/submit', requireAuth, requireRole('reviewer'), upload.single('screenshot'), async (req, res) => {
  const { application_id } = req.body;
  
  if (!req.file) {
    return res.status(400).json({ error: 'Screenshot file is required' });
  }
  
  const screenshotUrl = `/uploads/${req.file.filename}`;
  
  const [result] = await db.execute(`UPDATE applications SET status = 'submitted', screenshot_url = ? WHERE id = ? AND reviewer_id = ?`,
    [screenshotUrl, application_id, req.session.user.id]);
  
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Application not found or not authorized' });
  }
  res.json({ message: 'Proof submitted successfully, waiting for review' });
});

// 获取我的申请
app.get('/api/tester/my-applications', requireAuth, requireRole('reviewer'), async (req, res) => {
  const reviewerId = req.session.user.id;
  
  const [applications] = await db.execute(`
    SELECT a.*, c.product_name, c.platform, c.industry, c.budget_usd
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.reviewer_id = ?
    ORDER BY a.id DESC
  `, [reviewerId]);
  
  res.json(applications);
});

// 获取账户余额
app.get('/api/tester/balance', requireAuth, requireRole('reviewer'), async (req, res) => {
  const reviewerId = req.session.user.id;
  
  const [balance] = await db.execute(`
    SELECT COUNT(*) as completed_count, COALESCE(SUM(c.budget_usd / c.total_slots), 0) as total_earned
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.reviewer_id = ? AND a.status = 'paid'
  `, [reviewerId]);
  
  res.json({
    completed_tasks: balance[0].completed_count,
    total_earned: balance[0].total_earned || 0
  });
});

// 🛡️ Admin Dashboard

// 获取仪表板数据
app.get('/admin/dashboard-data', requireAuth, requireRole('admin'), async (req, res) => {
  // 总收入
  const [revenue] = await db.execute(`SELECT COALESCE(SUM(budget_usd), 0) as total_revenue FROM campaigns WHERE status != 'pending_payment'`);
  
  // 已支付数量
  const [paid] = await db.execute(`SELECT COUNT(*) as paid_count FROM applications WHERE status = 'paid'`);
  
  const totalPayouts = paid[0].paid_count * 20;
  const netProfit = (revenue[0].total_revenue || 0) - totalPayouts;
  
  // 待支付活动数量
  const [pendingPayments] = await db.execute(`SELECT COUNT(*) as pending_count FROM campaigns WHERE status = 'pending_payment'`);
  
  // 待审核数量
  const [pendingProofs] = await db.execute(`SELECT COUNT(*) as pending_count FROM applications WHERE status = 'submitted'`);
  
  res.json({
    total_revenue: revenue[0].total_revenue || 0,
    net_profit: netProfit,
    pending_payments_count: pendingPayments[0].pending_count,
    pending_proofs_count: pendingProofs[0].pending_count
  });
});

// 确认支付
app.post('/admin/campaigns/:id/confirm-payment', requireAuth, requireRole('admin'), async (req, res) => {
  const campaignId = parseInt(req.params.id);
  
  const [result] = await db.execute(`UPDATE campaigns SET status = 'active' WHERE id = ?`, [campaignId]);
  
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'Campaign not found' });
  }
  res.json({ message: 'Payment confirmed, campaign is now active' });
});

// 验证并支付
app.post('/admin/applications/:id/verify-and-pay', requireAuth, requireRole('admin'), async (req, res) => {
  const applicationId = parseInt(req.params.id);
  const { gift_card_code } = req.body;
  
  if (!gift_card_code) {
    return res.status(400).json({ error: 'Gift card code is required' });
  }
  
  // 获取申请信息
  const [applications] = await db.execute(`
    SELECT a.*, u.email as reviewer_email, c.product_name 
    FROM applications a
    JOIN users u ON a.reviewer_id = u.id
    JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.id = ?
  `, [applicationId]);
  
  if (applications.length === 0) {
    return res.status(404).json({ error: 'Application not found' });
  }
  
  const application = applications[0];
  
  // 更新申请状态
  await db.execute(`UPDATE applications SET status = 'paid', gift_card_code = ? WHERE id = ?`,
    [gift_card_code, applicationId]);
  
  // 发送邮件
  await sendGiftCardEmail(application.reviewer_email, gift_card_code, application.product_name);
  
  res.json({ message: 'Payment processed and email sent' });
});

// 获取待支付活动
app.get('/admin/pending-payments', requireAuth, requireRole('admin'), async (req, res) => {
  const [campaigns] = await db.execute(`
    SELECT c.*, u.email as employer_email
    FROM campaigns c
    JOIN users u ON c.employer_id = u.id
    WHERE c.status = 'pending_payment'
    ORDER BY c.id DESC
  `);
  
  res.json(campaigns);
});

// 获取待审核证明
app.get('/admin/pending-proofs', requireAuth, requireRole('admin'), async (req, res) => {
  const [applications] = await db.execute(`
    SELECT a.*, c.product_name, c.platform, u.email as reviewer_email
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    JOIN users u ON a.reviewer_id = u.id
    WHERE a.status = 'submitted'
    ORDER BY a.id DESC
  `);
  
  res.json(applications);
});

// 获取用户列表
app.get('/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
  const search = req.query.search || '';
  
  let query = `SELECT * FROM users ORDER BY id DESC`;
  let params = [];
  
  if (search) {
    query = `SELECT * FROM users WHERE email LIKE ? ORDER BY id DESC`;
    params = [`%${search}%`];
  }
  
  const [users] = await db.execute(query, params);
  res.json(users);
});

// 更新用户
app.put('/admin/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const userId = parseInt(req.params.id);
  const { email, role, industry, linkedin_profile } = req.body;
  
  const [result] = await db.execute(`UPDATE users SET email = ?, role = ?, industry = ?, linkedin_profile = ? WHERE id = ?`,
    [email, role, industry, linkedin_profile, userId]);
  
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ message: 'User updated successfully' });
});

// 删除用户
app.delete('/admin/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const userId = parseInt(req.params.id);
  
  if (userId === req.session.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  
  const [result] = await db.execute(`DELETE FROM users WHERE id = ?`, [userId]);
  
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({ message: 'User deleted successfully' });
});

// 启动服务器
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`SaaSTrust server running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
});