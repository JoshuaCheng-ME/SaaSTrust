// Load environment variables
require('dotenv').config();

const mysql = require('mysql2');

// MySQL 连接池配置
const pool = mysql.createPool({
    // 强制使用纯 IPv4 本地回环，彻底绕开 Hostinger 的 IPv6 拒绝 Bug
    host: process.env.DB_HOST || '127.0.0.1',
    
    // 严格分离端口号
    port: parseInt(process.env.DB_PORT) || 3306,
    
    user: process.env.DB_USER || 'u442193569_user',
    password: process.env.DB_PASSWORD || '!SaasTrustNet123',
    database: process.env.DB_NAME || 'u442193569_saastrustnet',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool.promise();