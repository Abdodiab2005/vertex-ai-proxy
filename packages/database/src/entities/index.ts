import { AdminSession } from "./admin-session.entity";
import { AdminUser } from "./admin-user.entity";
import { Alert, type AlertStatus, type AlertSeverity } from "./alert.entity";
import { ApiKey } from "./api-key.entity";
import { KeyPreset } from "./key-preset.entity";
import { AuditLog } from "./audit-log.entity";
import { CreditTransaction } from "./credit-transaction.entity";
import { Model } from "./model.entity";
import { ModelAlias } from "./model-alias.entity";
import { ModelRoute } from "./model-route.entity";
import { PricingRule } from "./pricing-rule.entity";
import { RequestLog } from "./request-log.entity";
import { SystemSetting } from "./system-setting.entity";
import { Upstream } from "./upstream.entity";
import { UsageAggregate } from "./usage-aggregate.entity";
import { UsageRecord } from "./usage-record.entity";

export {
  AdminSession,
  AdminUser,
  Alert,
  AlertStatus,
  AlertSeverity,
  ApiKey,
  KeyPreset,
  AuditLog,
  CreditTransaction,
  Model,
  ModelAlias,
  ModelRoute,
  PricingRule,
  RequestLog,
  SystemSetting,
  Upstream,
  UsageAggregate,
  UsageRecord,
};

export const entities = [
  AdminSession,
  AdminUser,
  Alert,
  ApiKey,
  KeyPreset,
  AuditLog,
  CreditTransaction,
  Model,
  ModelAlias,
  ModelRoute,
  PricingRule,
  RequestLog,
  SystemSetting,
  Upstream,
  UsageAggregate,
  UsageRecord,
];
