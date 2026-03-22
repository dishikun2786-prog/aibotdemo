/**
 * @file card-validator.js
 * @module middleware/card-validator
 * @description 名片输入验证中间件 - 使用express-validator验证用户输入
 */

const { body, param, validationResult } = require('express-validator');

/**
 * 处理验证结果
 * 如果有验证错误，返回400错误
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const firstError = errors.array()[0];
    return res.status(400).json({
      success: false,
      error: firstError.msg,
      field: firstError.param
    });
  }
  next();
};

/**
 * 名片保存验证规则
 * 验证：template_name, template_data
 */
const validateCardSave = [
  body('template_name')
    .trim()
    .notEmpty()
    .withMessage('名片名称不能为空')
    .isLength({ min: 2, max: 50 })
    .withMessage('名片名称必须在2-50字符之间')
    .matches(/^[a-zA-Z0-9\u4e00-\u9fa5\s\-_]+$/)
    .withMessage('名片名称只能包含中英文、数字、空格、横线和下划线'),
  
  body('template_data')
    .optional()
    .custom((value) => {
      // 验证是否为有效的对象
      if (typeof value !== 'object' || value === null) {
        throw new Error('模板数据必须是对象');
      }
      return true;
    }),
  
  body('id')
    .optional()
    .isInt({ min: 1 })
    .withMessage('名片ID必须是正整数'),
  
  handleValidationErrors
];

/**
 * 布局保存验证规则
 * 验证：layout数组
 */
const validateLayoutSave = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('名片ID必须是正整数'),
  
  body('layout')
    .isArray()
    .withMessage('布局数据必须是数组')
    .custom((value) => {
      // 验证数组中的每个元素
      if (!Array.isArray(value)) {
        throw new Error('布局数据必须是数组');
      }
      
      for (const item of value) {
        if (typeof item !== 'object' || item === null) {
          throw new Error('布局项必须是对象');
        }
        if (!item.type || typeof item.type !== 'string') {
          throw new Error('布局项必须包含type字段');
        }
      }
      
      return true;
    }),
  
  handleValidationErrors
];

/**
 * 发布名片验证规则
 * 验证：is_published
 */
const validatePublish = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('名片ID必须是正整数'),
  
  body('is_published')
    .isBoolean()
    .withMessage('发布状态必须是布尔值'),
  
  handleValidationErrors
];

/**
 * 创建空白名片验证规则
 * 验证：template_name
 */
const validateCreateBlank = [
  body('template_name')
    .optional()
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('名片名称必须在2-50字符之间')
    .matches(/^[a-zA-Z0-9\u4e00-\u9fa5\s\-_]+$/)
    .withMessage('名片名称只能包含中英文、数字、空格、横线和下划线'),
  
  handleValidationErrors
];

/**
 * 名片ID参数验证
 * 验证：路径参数中的id
 */
const validateCardId = [
  param('id')
    .isInt({ min: 1 })
    .withMessage('名片ID必须是正整数'),
  
  handleValidationErrors
];

/**
 * 名片令牌验证
 * 验证：路径参数中的token
 */
const validateCardToken = [
  param('token')
    .trim()
    .notEmpty()
    .withMessage('名片令牌不能为空')
    .isLength({ min: 32, max: 32 })
    .withMessage('名片令牌格式不正确')
    .matches(/^[a-f0-9]{32}$/)
    .withMessage('名片令牌只能包含小写字母和数字'),
  
  handleValidationErrors
];

/**
 * 分页参数验证
 * 验证：page, limit
 */
const validatePagination = [
  body('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('页码必须是正整数'),
  
  body('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('每页数量必须在1-100之间'),
  
  handleValidationErrors
];

module.exports = {
  validateCardSave,
  validateLayoutSave,
  validatePublish,
  validateCreateBlank,
  validateCardId,
  validateCardToken,
  validatePagination,
  handleValidationErrors
};
