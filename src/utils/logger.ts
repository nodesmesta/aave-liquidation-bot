import winston from 'winston';
import { config } from '../config';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
      )}`;
    }
    return msg;
  })
);

export const logger = winston.createLogger({
  level: config.logging.level,
  format: logFormat,
  transports: [
    // Console output
    new winston.transports.Console({
      format: consoleFormat,
    }),
    // Error log file
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
    }),
    // Combined log file
    new winston.transports.File({
      filename: config.logging.file,
    }),
  ],
});

// Create logs directory if not exists
import * as fs from 'fs';
if (!fs.existsSync('logs')) {
  fs.mkdirSync('logs');
}

/**
 * @notice Safe BigInt serializer for logging
 * @dev Recursively converts BigInt to string to prevent JSON.stringify errors
 */
function serializeBigInt(obj: any): any {
  if (typeof obj === 'bigint') {
    return obj.toString();
  }
  if (obj && typeof obj === 'object') {
    if (obj instanceof Error) {
      return {
        message: obj.message,
        stack: obj.stack,
        name: obj.name,
      };
    }
    if (Array.isArray(obj)) {
      return obj.map(serializeBigInt);
    }
    const serialized: any = {};
    for (const key in obj) {
      serialized[key] = serializeBigInt(obj[key]);
    }
    return serialized;
  }
  return obj;
}

export { serializeBigInt };
