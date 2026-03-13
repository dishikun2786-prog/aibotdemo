/**
 * @file visitor-tracker.js
 * @description 访客追踪脚本 - 记录页面访问和停留时间
 * 自动在页面加载时记录访问，在页面离开时记录离开时间
 */

(function() {
  'use strict';

  // 配置
  const API_BASE = window.API_BASE || '';
  const SESSION_KEY = 'visitor_session_id';
  const SESSION_EXPIRE = 30 * 60 * 1000; // 30分钟会话过期

  // 全局变量
  let sessionId = null;
  let currentPage = null;
  let clientIp = null;

  /**
   * 获取或生成会话ID
   */
  function getSessionId() {
    let session = localStorage.getItem(SESSION_KEY);
    if (session) {
      try {
        const sessionData = JSON.parse(session);
        // 检查是否过期
        if (Date.now() - sessionData.timestamp < SESSION_EXPIRE) {
          sessionId = sessionData.id;
          return sessionId;
        }
      } catch (e) {
        // 解析失败，重新生成
      }
    }
    // 生成新会话ID
    sessionId = 'v_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 12);
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      id: sessionId,
      timestamp: Date.now()
    }));
    return sessionId;
  }

  /**
   * 获取客户端IP（通过API）
   */
  async function getClientIp() {
    if (clientIp) return clientIp;
    try {
      const response = await fetch(API_BASE + '/api/visitor/my-ip', {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await response.json();
      if (data.success) {
        clientIp = data.ip;
      }
    } catch (e) {
      console.error('获取IP失败:', e);
      clientIp = 'unknown';
    }
    return clientIp;
  }

  /**
   * 获取用户代理
   */
  function getUserAgent() {
    return navigator.userAgent || 'unknown';
  }

  /**
   * 获取当前页面路径
   */
  function getCurrentPage() {
    return window.location.pathname || '/';
  }

  /**
   * 记录页面访问
   */
  async function recordPageView() {
    const ip = await getClientIp();
    const page = getCurrentPage();
    const userAgent = getUserAgent();
    const sid = getSessionId();

    try {
      await fetch(API_BASE + '/api/visitor/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'enter',
          ip: ip,
          userAgent: userAgent,
          page: page,
          sessionId: sid
        })
      });
    } catch (e) {
      console.error('记录页面访问失败:', e);
    }
  }

  /**
   * 记录页面离开
   */
  async function recordPageLeave() {
    const page = getCurrentPage();
    const sid = sessionId || getSessionId();

    try {
      await fetch(API_BASE + '/api/visitor/log', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'leave',
          page: page,
          sessionId: sid
        })
      });
    } catch (e) {
      // 静默失败，不影响用户体验
    }
  }

  /**
   * 初始化追踪器
   */
  function init() {
    // 获取会话ID
    getSessionId();
    currentPage = getCurrentPage();

    // 记录页面访问
    recordPageView();

    // 页面离开时记录离开时间
    window.addEventListener('beforeunload', function() {
      recordPageLeave();
    });

    // 定期更新会话时间（每分钟）
    setInterval(function() {
      const session = localStorage.getItem(SESSION_KEY);
      if (session) {
        try {
          const sessionData = JSON.parse(session);
          sessionData.timestamp = Date.now();
          localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
        } catch (e) {
          // 忽略
        }
      }
    }, 60000);
  }

  // 页面加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 导出全局函数供手动调用
  window.VisitorTracker = {
    getSessionId: getSessionId,
    getClientIp: getClientIp,
    recordPageView: recordPageView,
    recordPageLeave: recordPageLeave
  };

})();
