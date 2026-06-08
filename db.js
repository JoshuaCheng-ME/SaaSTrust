// Load environment variables
require('dotenv').config();

const mysql = require('mysql2');

// MySQL 连接池配置
const pool = mysql.createPool({
    // 1. Host 必须是纯粹的 'localhost'，绝对不能带 :3306 尾缀！
    host: process.env.DB_HOST || 'localhost',
    
    // 2. 将端口号独立声明（mysql2 的标准写法）
    port: parseInt(process.env.DB_PORT) || 3306,
    
    user: process.env.DB_USER || 'u442193569_user',
    password: process.env.DB_PASSWORD || '!SaasTrustNet123',
    database: process.env.DB_NAME || 'u442193569_saastrustnet',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

module.exports = pool.promise();