import Joi from 'joi';

export const sepayEnvironmentSchema = {
  PAYMENT_REDIS_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .allow('')
    .default(''),
  PAYMENT_EVENTS_CHANNEL: Joi.string()
    .pattern(/^[A-Za-z0-9:_-]{1,100}$/)
    .default('vedora:payments:v1'),
  BILLING_PRO_PRICE_VND: Joi.number()
    .integer()
    .min(1)
    .max(1_000_000_000)
    .default(49000),
  BILLING_PREMIUM_PRICE_VND: Joi.number()
    .integer()
    .min(1)
    .max(1_000_000_000)
    .default(99000),
  BILLING_DURATION_DAYS: Joi.number().integer().min(1).max(365).default(30),
  SEPAY_PAYMENT_ENABLED: Joi.boolean().default(false),
  SEPAY_PAYMENT_FLOW: Joi.string()
    .valid('bank_transfer_qr')
    .default('bank_transfer_qr'),
  SEPAY_QR_BANK_CODE: Joi.string()
    .max(50)
    .when('SEPAY_PAYMENT_ENABLED', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.allow('').default(''),
    }),
  // Banking payload.gateway is often a full name, whereas QR uses a bank code.
  SEPAY_BANK_GATEWAY: Joi.string()
    .max(100)
    .when('SEPAY_PAYMENT_ENABLED', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.allow('').default(''),
    }),
  SEPAY_QR_ACCOUNT_NUMBER: Joi.string()
    .pattern(/^[A-Za-z0-9]{1,100}$/)
    .when('SEPAY_PAYMENT_ENABLED', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.allow('').default(''),
    }),
  SEPAY_QR_ACCOUNT_HOLDER: Joi.string()
    .max(150)
    .when('SEPAY_PAYMENT_ENABLED', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.allow('').default(''),
    }),
  SEPAY_QR_STORE_NAME: Joi.string().max(100).default('Vedora'),
  SEPAY_QR_TRANSFER_PREFIX: Joi.string()
    .pattern(/^[A-Z0-9]{1,30}$/)
    .allow('')
    .default(''),
  SEPAY_PAYMENT_CODE_PREFIX: Joi.string()
    .pattern(/^[A-Z][A-Z0-9]{1,4}$/)
    .default('VED'),
  SEPAY_BANK_WEBHOOK_API_KEY: Joi.string()
    .min(16)
    .max(200)
    .when('SEPAY_PAYMENT_ENABLED', {
      is: true,
      then: Joi.required(),
      otherwise: Joi.allow('').default(''),
    }),
};
