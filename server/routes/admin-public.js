/**
 * @file admin-public.js
 * @module routes/admin-public
 * @description 管理员后台公开接口（无需认证）
 */
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { getDefaultValue } = require('../utils/config-validator');

// 获取客户端配置（公开接口，用于game.html加载配置）
router.get('/client-config', async (req, res) => {
  try {
    const configs = await db.query(
      'SELECT config_key, config_value FROM game_config WHERE config_key LIKE ? OR config_key LIKE ? OR config_key LIKE ? OR config_key = ?',
      ['client_%', 'game_rules_%', 'ai_agent_%', 'occupy_node_energy_cost']
    );
    const configMap = {};
    
    configs.forEach(item => {
      const defaultValue = getDefaultValue(item.config_key);
      if (typeof defaultValue === 'boolean') {
        const strValue = item.config_value || String(defaultValue);
        configMap[item.config_key] = strValue.toLowerCase() === 'true' || strValue === '1';
      } else {
        configMap[item.config_key] = item.config_value || defaultValue;
      }
    });
    
    const defaultConfigs = {
      'client_api_base': getDefaultValue('client_api_base'),
      'client_socket_url': getDefaultValue('client_socket_url'),
      'client_video_max_attempts': getDefaultValue('client_video_max_attempts'),
      'client_video_poll_interval': getDefaultValue('client_video_poll_interval'),
      'client_max_reconnect_attempts': getDefaultValue('client_max_reconnect_attempts'),
      'client_reconnect_delay': getDefaultValue('client_reconnect_delay'),
      'game_rules_pk_min_value': getDefaultValue('game_rules_pk_min_value'),
      'game_rules_pk_max_value': getDefaultValue('game_rules_pk_max_value'),
      'ai_agent_energy_cost': getDefaultValue('ai_agent_energy_cost'),
      'ai_agent_image_energy_cost': getDefaultValue('ai_agent_image_energy_cost'),
      'ai_agent_image_enabled': getDefaultValue('ai_agent_image_enabled'),
      'ai_agent_video_enabled': getDefaultValue('ai_agent_video_enabled'),
      'ai_agent_voice_enabled': getDefaultValue('ai_agent_voice_enabled'),
      'ai_agent_web_search_enabled': getDefaultValue('ai_agent_web_search_enabled'),
      'ai_agent_web_search_studio_only': getDefaultValue('ai_agent_web_search_studio_only'),
      'ai_agent_web_search_energy_cost': getDefaultValue('ai_agent_web_search_energy_cost')
    };
    
    const finalConfig = { ...defaultConfigs, ...configMap };
    
    res.json({
      success: true,
      data: finalConfig
    });
  } catch (error) {
    console.error('获取客户端配置失败:', error);
    res.status(500).json({ error: '获取客户端配置失败' });
  }
});

// 获取主题风格配置（公开接口，用于game.html加载主题）
router.get('/config/theme_style', async (req, res) => {
  try {
    const [config] = await db.query(
      'SELECT config_value FROM game_config WHERE config_key = ?',
      ['theme_style']
    );
    res.json({ success: true, value: config?.config_value || 'q' });
  } catch (error) {
    console.error('获取主题配置失败:', error);
    res.json({ success: true, value: 'q' });
  }
});

module.exports = router;
