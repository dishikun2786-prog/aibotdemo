/**
 * @file auth-manager.js
 * @module auth-manager
 * @description 统一登录状态管理器 - 管理前端认证状态和Token
 * @description 注意：此文件需要被所有HTML页面引用
 */

/**
 * 认证管理器
 * 统一管理登录状态，解决多页面Token key不一致的问题
 */
const AuthManager = {
  // 唯一合法的Token key
  TOKEN_KEY: 'authToken',

  // 需要迁移的旧key（兼容旧代码）
  LEGACY_TOKEN_KEYS: ['token', 'token2', 'accessToken', 'userToken', 'sessionToken'],

  /**
   * 获取Token
   * @returns {string|null} Token字符串
   */
  getToken() {
    // 先尝试迁移旧数据
    this.migrateLegacyTokens();
    return localStorage.getItem(AuthManager.TOKEN_KEY);
  },

  /**
   * 设置Token
   * @param {string} token - Token字符串
   */
  setToken(token) {
    if (!token) {
      console.warn('[AuthManager] 尝试设置空token');
      return;
    }

    // 清除所有旧key
    AuthManager.LEGACY_TOKEN_KEYS.forEach(key => {
      localStorage.removeItem(key);
    });

    // 设置新key
    localStorage.setItem(AuthManager.TOKEN_KEY, token);
    console.log('[AuthManager] Token已设置到 authToken');
  },

  /**
   * 清除Token
   */
  clearToken() {
    localStorage.removeItem(AuthManager.TOKEN_KEY);
    console.log('[AuthManager] Token已清除');
  },

  /**
   * 检查是否已登录
   * @returns {boolean}
   */
  isLoggedIn() {
    const token = this.getToken();
    return !!token && token.length > 0;
  },

  /**
   * 迁移旧数据到统一的key
   * 兼容之前使用不同key存储token的页面
   */
  migrateLegacyTokens() {
    const currentToken = localStorage.getItem(AuthManager.TOKEN_KEY);

    // 如果已经有统一key，直接返回
    if (currentToken) {
      return;
    }

    // 查找旧key中是否有token
    for (const key of AuthManager.LEGACY_TOKEN_KEYS) {
      const oldToken = localStorage.getItem(key);
      if (oldToken) {
        console.log(`[AuthManager] 发现旧token（${key}），迁移到 authToken`);
        localStorage.setItem(AuthManager.TOKEN_KEY, oldToken);
        localStorage.removeItem(key);
        return;
      }
    }
  },

  /**
   * 获取Authorization请求头
   * @returns {string} Authorization头值
   */
  getAuthHeader() {
    const token = this.getToken();
    return token ? `Bearer ${token}` : '';
  },

  /**
   * 检查Token有效性（简单检查）
   * @returns {boolean}
   */
  isTokenValid() {
    const token = this.getToken();
    if (!token) return false;

    // 简单检查：token应该是JWT格式（三个点分隔）
    const parts = token.split('.');
    return parts.length === 3;
  }
};

/**
 * 统一的API请求函数
 * 自动携带认证信息
 * @param {string} url - 请求URL
 * @param {object} options - fetch选项
 * @returns {Promise<Response>}
 */
async function authFetch(url, options = {}) {
  const token = AuthManager.getToken();

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return fetch(url, {
    ...options,
    headers
  });
}

/**
 * 检查登录状态的装饰器函数
 * 用于需要登录才能访问的页面
 * @param {Function} callback - 登录后的回调函数
 */
function requireLogin(callback) {
  if (!AuthManager.isLoggedIn()) {
    // 未登录，跳转到登录页面
    const currentUrl = encodeURIComponent(window.location.href);
    window.location.href = `/login.html?redirect=${currentUrl}`;
    return false;
  }

  if (callback) {
    callback(AuthManager.getToken());
  }

  return true;
}

/**
 * 登出函数
 * 清除所有认证数据
 */
function logout() {
  AuthManager.clearToken();
  // 跳转回登录页
  window.location.href = '/login.html';
}

/**
 * 获取当前用户信息
 * @returns {Promise<object|null>}
 */
async function getCurrentUser() {
  const token = AuthManager.getToken();
  if (!token) return null;

  try {
    const response = await authFetch('/api/auth/me');
    const data = await response.json();

    if (data.success) {
      return data.data;
    }
    return null;
  } catch (error) {
    console.error('[AuthManager] 获取用户信息失败:', error);
    return null;
  }
}

// 如果在浏览器环境，自动迁移旧数据
if (typeof window !== 'undefined') {
  // 页面加载时自动迁移
  AuthManager.migrateLegacyTokens();

  // 导出到全局
  window.AuthManager = AuthManager;
  window.authFetch = authFetch;
  window.requireLogin = requireLogin;
  window.logout = logout;
  window.getCurrentUser = getCurrentUser;
}

module.exports = {
  AuthManager,
  authFetch,
  requireLogin,
  logout,
  getCurrentUser
};
