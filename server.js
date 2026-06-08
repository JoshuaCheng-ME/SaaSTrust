const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Resend } = require('resend');

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

// 数据库连接
const db = new sqlite3.Database('./database.sqlite');

// 初始化数据库表
function initDB() {
  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL,
      linkedin_profile TEXT,
      industry TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Campaigns table
  db.run(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employer_id INTEGER NOT NULL,
      platform TEXT,
      product_name TEXT NOT NULL,
      product_url TEXT NOT NULL,
      industry TEXT NOT NULL,
      budget_usd REAL NOT NULL,
      status TEXT DEFAULT 'pending_payment',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (employer_id) REFERENCES users(id)
    )
  `);
  
  // Applications table
  db.run(`
    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reviewer_id INTEGER NOT NULL,
      campaign_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      screenshot_url TEXT,
      gift_card_code TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (reviewer_id) REFERENCES users(id),
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
    )
  `);
  
  // Create admin user if not exists
  db.get('SELECT id FROM users WHERE email = ?', ['admin@saastrust.net'], (err, row) => {
    if (!row) {
      const hashedPassword = bcrypt.hashSync('admin123', 10);
      db.run('INSERT INTO users (email, password, role, industry) VALUES (?, ?, ?, ?)',
        ['admin@saastrust.net', hashedPassword, 'admin', 'Admin'], (err) => {
          if (!err) {
            console.log('Admin user created: admin@saastrust.net / admin123');
          }
        });
    }
  });
}

initDB();

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
if (!require('fs').existsSync(uploadDir)) {
  require('fs').mkdirSync(uploadDir, { recursive: true });
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

// 🔓 Public & General Routes

// 首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 用户注册
app.post('/api/register', (req, res) => {
  const { email, password, role, linkedin_profile, industry } = req.body;
  
  if (!email || !password || !role || !industry || !linkedin_profile) {
    return res.status(400).json({ error: 'Missing required fields. LinkedIn profile is required.' });
  }
  
  if (role !== 'employer' && role !== 'reviewer') {
    return res.status(400).json({ error: 'Invalid role' });
  }
  
  const hashedPassword = bcrypt.hashSync(password, 10);
  
  db.run(`INSERT INTO users (email, password, role, linkedin_profile, industry) VALUES (?, ?, ?, ?, ?)`,
    [email, hashedPassword, role, linkedin_profile, industry], (err) => {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ error: 'Email already exists' });
        }
        return res.status(500).json({ error: 'Registration failed' });
      }
      res.status(201).json({ message: 'Registration successful', role });
    });
});

// 用户登录
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    req.session.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      industry: user.industry
    };
    
    res.json({ message: 'Login successful', role: user.role });
  });
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
app.post('/api/client/campaign', requireAuth, requireRole('employer'), (req, res) => {
  const { product_name, target_site, req_industry, total_slots } = req.body;
  
  if (!product_name || !target_site || !req_industry || !total_slots) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  db.run(`INSERT INTO campaigns (employer_id, platform, product_name, industry, total_slots) VALUES (?, ?, ?, ?, ?)`,
    [req.session.user.id, target_site, product_name, req_industry, total_slots], function(err) {
      if (err) {
        return res.status(500).json({ error: 'Failed to create campaign' });
      }
      
      // 返回 Gumroad 支付链接（示例）
      const gumroadLink = `https://saastrust.gumroad.com/l/campaign-${this.lastID}`;
      res.json({ 
        message: 'Campaign created successfully', 
        campaign_id: this.lastID,
        status: 'pending_payment',
        payment_link: gumroadLink
      });
    });
});

// 获取我的活动
app.get('/api/client/my-jobs', requireAuth, requireRole('employer'), (req, res) => {
  const employerId = req.session.user.id;
  
  db.all(`
    SELECT c.*,
           COUNT(a.id) as total_applications,
           SUM(CASE WHEN a.status = 'submitted' THEN 1 ELSE 0 END) as pending_proofs,
           SUM(CASE WHEN a.status = 'paid' THEN 1 ELSE 0 END) as completed_reviews
    FROM campaigns c
    LEFT JOIN applications a ON c.id = a.campaign_id
    WHERE c.employer_id = ?
    GROUP BY c.id
    ORDER BY c.id DESC
  `, [employerId], (err, campaigns) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch campaigns' });
    }
    res.json(campaigns);
  });
});

// 👩‍💻 Reviewer (A-End) Smart-Matching

// 智能匹配任务
app.get('/api/tester/matched', requireAuth, requireRole('reviewer'), (req, res) => {
  const reviewerIndustry = req.session.user.industry;
  
  db.all(`
    SELECT c.*,
           COUNT(a.id) as current_applications
    FROM campaigns c
    LEFT JOIN applications a ON c.id = a.campaign_id
    WHERE c.industry = ? AND c.status = 'active'
    GROUP BY c.id
    ORDER BY c.id DESC
  `, [reviewerIndustry], (err, campaigns) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch recommendations' });
    }
    res.json(campaigns);
  });
});

// 申请任务
app.post('/api/tester/apply', requireAuth, requireRole('reviewer'), (req, res) => {
  const { campaign_id } = req.body;
  
  // 检查是否已申请过此任务
  db.get(`SELECT id FROM applications WHERE campaign_id = ? AND reviewer_id = ?`,
    [campaign_id, req.session.user.id], (err, row) => {
      if (row) {
        return res.status(400).json({ error: 'You have already applied for this campaign' });
      }
      
      db.run(`INSERT INTO applications (reviewer_id, campaign_id, status) VALUES (?, ?, 'pending')`,
        [req.session.user.id, campaign_id], function(err) {
          if (err) {
            return res.status(500).json({ error: 'Failed to apply' });
          }
          res.json({ message: 'Application submitted successfully', application_id: this.lastID });
        });
    });
});

// 提交证明
app.post('/api/tester/submit', requireAuth, requireRole('reviewer'), upload.single('screenshot'), (req, res) => {
  const { application_id } = req.body;
  
  if (!req.file) {
    return res.status(400).json({ error: 'Screenshot file is required' });
  }
  
  const screenshotUrl = `/uploads/${req.file.filename}`;
  
  db.run(`UPDATE applications SET status = 'submitted', screenshot_url = ? WHERE id = ? AND reviewer_id = ?`,
    [screenshotUrl, application_id, req.session.user.id], function(err) {
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Application not found or not authorized' });
      }
      res.json({ message: 'Proof submitted successfully, waiting for review' });
    });
});

// 获取我的申请
app.get('/api/tester/my-applications', requireAuth, requireRole('reviewer'), (req, res) => {
  const reviewerId = req.session.user.id;
  
  db.all(`
    SELECT a.*, c.product_name, c.platform, c.industry, c.budget_usd
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.reviewer_id = ?
    ORDER BY a.id DESC
  `, [reviewerId], (err, applications) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch applications' });
    }
    res.json(applications);
  });
});

// 获取账户余额
app.get('/api/tester/balance', requireAuth, requireRole('reviewer'), (req, res) => {
  const reviewerId = req.session.user.id;
  
  // 计算已支付申请的总额（假设每单 20 美元）
  db.get(`SELECT COUNT(*) as paid_count FROM applications WHERE reviewer_id = ? AND status = 'paid'`,
    [reviewerId], (err, result) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to fetch balance' });
      }
      
      const balance = (result.paid_count || 0) * 20;
      res.json({ balance: balance, paid_count: result.paid_count || 0 });
    });
});

// 👑 Admin Control Hub

// 获取仪表板数据
app.get('/admin/dashboard-data', requireAuth, requireRole('admin'), (req, res) => {
  // 总收入（已支付的活动预算）
  db.get(`SELECT SUM(budget_usd) as total_revenue FROM campaigns WHERE status != 'pending_payment'`, (err, revenue) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch revenue data' });
    }
    
    // 已支付总额（已支付的申请数量 * 假设每单20美元）
    db.get(`SELECT COUNT(*) as paid_count FROM applications WHERE status = 'paid'`, (err, paid) => {
      if (err) {
        return res.status(500).json({ error: 'Failed to fetch paid data' });
      }
      
      const totalPayouts = paid.paid_count * 20;
      const netProfit = (revenue.total_revenue || 0) - totalPayouts;
      
      // 待支付活动数量
      db.get(`SELECT COUNT(*) as pending_payments FROM campaigns WHERE status = 'pending_payment'`, (err, pendingPayments) => {
        if (err) {
          return res.status(500).json({ error: 'Failed to fetch pending payments' });
        }
        
        // 待审核证明数量
        db.get(`SELECT COUNT(*) as pending_proofs FROM applications WHERE status = 'submitted'`, (err, pendingProofs) => {
          if (err) {
            return res.status(500).json({ error: 'Failed to fetch pending proofs' });
          }
          
          res.json({
            total_revenue: revenue.total_revenue || 0,
            net_profit: netProfit,
            pending_payments_count: pendingPayments.pending_payments,
            pending_proofs_count: pendingProofs.pending_proofs
          });
        });
      });
    });
  });
});

// 确认支付
app.post('/admin/campaigns/:id/confirm-payment', requireAuth, requireRole('admin'), (req, res) => {
  const campaignId = parseInt(req.params.id);
  
  db.run(`UPDATE campaigns SET status = 'active' WHERE id = ?`, [campaignId], function(err) {
    if (this.changes === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json({ message: 'Payment confirmed, campaign is now active' });
  });
});

// 验证并支付
app.post('/admin/applications/:id/verify-and-pay', requireAuth, requireRole('admin'), (req, res) => {
  const applicationId = parseInt(req.params.id);
  const { gift_card_code } = req.body;
  
  if (!gift_card_code) {
    return res.status(400).json({ error: 'Gift card code is required' });
  }
  
  // 获取申请信息
  db.get(`
    SELECT a.*, u.email as reviewer_email, c.product_name 
    FROM applications a
    JOIN users u ON a.reviewer_id = u.id
    JOIN campaigns c ON a.campaign_id = c.id
    WHERE a.id = ?
  `, [applicationId], (err, application) => {
    if (err || !application) {
      return res.status(404).json({ error: 'Application not found' });
    }
    
    // 更新申请状态
    db.run(`UPDATE applications SET status = 'paid', gift_card_code = ? WHERE id = ?`,
      [gift_card_code, applicationId], function(err) {
        if (err) {
          return res.status(500).json({ error: 'Failed to update application' });
        }
        
        // 发送邮件
        sendGiftCardEmail(application.reviewer_email, gift_card_code, application.product_name)
          .then(() => {
            res.json({ message: 'Application verified and gift card sent successfully' });
          })
          .catch((emailError) => {
            console.error('Failed to send email:', emailError);
            res.status(500).json({ error: 'Failed to send gift card email' });
          });
      });
  });
});

// 发送礼品卡邮件
async function sendGiftCardEmail(toEmail, giftCardCode, productName) {
  try {
    const emailContent = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 28px;">🎉 Payment Received!</h1>
        </div>
        <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px;">
          <p style="color: #333; line-height: 1.6;">Hi there,</p>
          <p style="color: #333; line-height: 1.6;">Great news! Your review for <strong>${productName}</strong> has been verified and approved.</p>
          <p style="color: #333; line-height: 1.6;">Here's your $20 Amazon Gift Card code:</p>
          <div style="background: white; border: 2px dashed #667eea; padding: 20px; text-align: center; margin: 20px 0; border-radius: 8px;">
            <span style="font-size: 24px; font-weight: bold; color: #667eea; letter-spacing: 2px;">${giftCardCode}</span>
          </div>
          <p style="color: #333; line-height: 1.6;">Thank you for your valuable contribution to the SaaSTrust community!</p>
          <p style="color: #666; font-size: 14px; margin-top: 30px;">Best regards,<br>The SaaSTrust Team</p>
        </div>
      </div>
    `;
    
    await resend.emails.send({
      from: 'SaaSTrust <noreply@saastrust.net>',
      to: toEmail,
      subject: 'Your Gift Card is Here! 🎁',
      html: emailContent
    });
    
    console.log(`Gift card email sent to ${toEmail}`);
  } catch (error) {
    console.error('Failed to send email:', error);
    throw error;
  }
}

// 获取待支付活动
app.get('/admin/pending-payments', requireAuth, requireRole('admin'), (req, res) => {
  db.all(`
    SELECT c.*, u.email as employer_email
    FROM campaigns c
    JOIN users u ON c.employer_id = u.id
    WHERE c.status = 'pending_payment'
    ORDER BY c.id DESC
  `, (err, campaigns) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch pending payments' });
    }
    res.json(campaigns);
  });
});

// 获取待审核证明
app.get('/admin/pending-proofs', requireAuth, requireRole('admin'), (req, res) => {
  db.all(`
    SELECT a.*, c.product_name, c.platform, u.email as reviewer_email
    FROM applications a
    JOIN campaigns c ON a.campaign_id = c.id
    JOIN users u ON a.reviewer_id = u.id
    WHERE a.status = 'submitted'
    ORDER BY a.id DESC
  `, (err, applications) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch pending proofs' });
    }
    res.json(applications);
  });
});

// 👥 User CRUD Management (Admin Only)

// 获取所有用户
app.get('/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  const { search, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  
  let query = 'SELECT * FROM users WHERE 1=1';
  const params = [];
  
  if (search) {
    query += ' AND (email LIKE ? OR industry LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  
  query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  
  db.all(query, params, (err, users) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to fetch users' });
    }
    res.json(users);
  });
});

// 更新用户
app.put('/admin/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const userId = parseInt(req.params.id);
  const { email, password, role, linkedin_profile, industry } = req.body;
  
  let query = 'UPDATE users SET email = ?, role = ?, linkedin_profile = ?, industry = ?';
  const params = [email, role, linkedin_profile, industry];
  
  if (password) {
    query += ', password = ?';
    params.push(bcrypt.hashSync(password, 10));
  }
  
  query += ' WHERE id = ?';
  params.push(userId);
  
  db.run(query, params, function(err) {
    if (this.changes === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ message: 'User updated successfully' });
  });
});

// 删除用户
app.delete('/admin/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const userId = parseInt(req.params.id);
  
  // SQLite 会自动处理外键约束（如果启用了 PRAGMA foreign_keys = ON）
  db.run(`DELETE FROM users WHERE id = ?`, [userId], function(err) {
    if (this.changes === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ message: 'User deleted successfully' });
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`🚀 SaaSTrust server running on port ${PORT}`);
  console.log(`📊 Admin Dashboard: http://localhost:${PORT}/admin.html`);
  console.log(`🏠 Homepage: http://localhost:${PORT}/`);
});